import { describe, expect, test } from "bun:test";
import { handleArchiveRequest } from "../services/archive-forwarder/request";
import { StrategyArchiveSpool } from "../services/archive-forwarder/strategy-spool";
import {
	ArchiveForwarderTelemetry,
	type ArchiveMetricsRecorder,
} from "../services/archive-forwarder/telemetry";
import fixture from "./fixtures/archive_forwarder_envelope.json";

const noopRecorder: ArchiveMetricsRecorder = {
	recordCounter: () => {},
	setObservableGauge: () => {},
};

function post(body: unknown): Request {
	return new Request("http://localhost/archive", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("strategy durable HTTP admission", () => {
	test("returns 202 after SQLite ownership without waiting for ClickHouse", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		let insertCalled = false;
		const response = await handleArchiveRequest(post(fixture), {
			inserter: async () => {
				insertCalled = true;
				throw new Error("ClickHouse is down");
			},
			spool,
			telemetry: new ArchiveForwarderTelemetry(noopRecorder),
		});
		expect(response.status).toBe(202);
		expect(insertCalled).toBe(false);
		expect(spool.stats()).toMatchObject({ queuedBatches: 1, queuedWork: 3 });
		spool.close();
	});

	test("keeps broker traffic on direct synchronous insertion", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		let insertCalled = false;
		const response = await handleArchiveRequest(
			post({
				source: "broker_read",
				deployment_id: "broker-a",
				rows: [
					{
						table: "market_data.cex_trades",
						row: { source: "broker_read", trade_id: "trade-a" },
					},
				],
			}),
			{
				inserter: async () => {
					insertCalled = true;
				},
				spool,
				telemetry: new ArchiveForwarderTelemetry(noopRecorder),
			},
		);
		expect(response.status).toBe(200);
		expect(insertCalled).toBe(true);
		expect(spool.stats().queuedBatches).toBe(0);
		spool.close();
	});

	test("rejects strategy source/table/version failures before admission", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		const invalid = structuredClone(fixture);
		invalid.rows[0].row.schema_version = "99";
		const response = await handleArchiveRequest(post(invalid), {
			inserter: async () => {},
			spool,
			telemetry: new ArchiveForwarderTelemetry(noopRecorder),
		});
		expect(response.status).toBe(400);
		expect(spool.stats().queuedBatches).toBe(0);
		spool.close();
	});

	test("returns 429 when the spool cannot reserve fixed capacity", async () => {
		const probe = new StrategyArchiveSpool({ path: ":memory:" });
		const required = probe.accountedBytes(fixture);
		probe.close();
		const spool = new StrategyArchiveSpool({
			path: ":memory:",
			limits: { maxBytes: required - 1 },
		});
		const response = await handleArchiveRequest(post(fixture), {
			inserter: async () => {},
			spool,
			telemetry: new ArchiveForwarderTelemetry(noopRecorder),
		});
		expect(response.status).toBe(429);
		expect(spool.stats().queuedBatches).toBe(0);
		spool.close();
	});

	test("returns 503 when no durable strategy spool is available", async () => {
		const response = await handleArchiveRequest(post(fixture), {
			inserter: async () => {},
			telemetry: new ArchiveForwarderTelemetry(noopRecorder),
		});
		expect(response.status).toBe(503);
	});
});
