import { describe, expect, test } from "bun:test";
import { handleArchiveRequest } from "../services/archive-forwarder/request";
import { StrategyArchiveSpool } from "../services/archive-forwarder/strategy-spool";
import {
	ArchiveForwarderTelemetry,
	type ArchiveMetricsRecorder,
} from "../services/archive-forwarder/telemetry";
import fixture from "./fixtures/archive_forwarder_envelope.json";
import makerOrchestratorFixture from "./fixtures/maker_orchestrator_archive_envelope.json";

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
		expect(spool.stats()).toMatchObject({
			queuedBatches: 1,
			queuedWork: fixture.rows.length,
		});
		spool.close();
	});

	test("durably admits Maker orchestrator rows without waiting for ClickHouse", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		let insertCalled = false;
		const response = await handleArchiveRequest(
			post(makerOrchestratorFixture),
			{
				inserter: async () => {
					insertCalled = true;
					throw new Error("ClickHouse is down");
				},
				spool,
				telemetry: new ArchiveForwarderTelemetry(noopRecorder),
			},
		);
		expect(response.status).toBe(202);
		expect(insertCalled).toBe(false);
		expect(spool.stats()).toMatchObject({
			queuedBatches: 1,
			queuedWork: makerOrchestratorFixture.rows.length,
		});
		spool.close();
	});

	test("rejects external and unknown market sources before insertion or spool admission", async () => {
		for (const source of ["external_backfill", "unknown_market_source"]) {
			const spool = new StrategyArchiveSpool({ path: ":memory:" });
			let insertCalled = false;
			const response = await handleArchiveRequest(
				post({
					source,
					deployment_id: "historical-worker",
					rows: [
						{
							table: "market_data.cex_order_book_depth_summary",
							row: { source, snapshot_id: "snapshot-a" },
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
			expect(response.status).toBe(400);
			expect(insertCalled).toBe(false);
			expect(spool.stats()).toMatchObject({
				queuedBatches: 0,
				queuedWork: 0,
			});
			spool.close();
		}
	});

	test("rejects a broker envelope when a market row source is caller-overridden", async () => {
		let insertCalled = false;
		const response = await handleArchiveRequest(
			post({
				source: "broker_read",
				deployment_id: "broker-a",
				rows: [
					{
						table: "market_data.cex_trades",
						row: { source: "external_backfill", trade_id: "trade-a" },
					},
				],
			}),
			{
				inserter: async () => {
					insertCalled = true;
				},
				telemetry: new ArchiveForwarderTelemetry(noopRecorder),
			},
		);
		expect(response.status).toBe(400);
		expect(insertCalled).toBe(false);
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

	test("inserts maker_replay synchronously without changing spool ownership", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		const replay = structuredClone(fixture);
		replay.source = "maker_replay";
		for (const entry of replay.rows) entry.row.source = "maker_replay";
		const insertedTables: string[] = [];
		const insertedSources: unknown[] = [];
		const before = spool.stats();
		const response = await handleArchiveRequest(post(replay), {
			inserter: async (table, rows) => {
				insertedTables.push(table);
				insertedSources.push(...rows.map((row) => row.source));
			},
			spool,
			telemetry: new ArchiveForwarderTelemetry(noopRecorder),
		});
		expect(response.status).toBe(200);
		expect(new Set(insertedTables)).toEqual(
			new Set([
				"strategy_data.policy_evaluation_events",
				"strategy_data.strategy_policy_snapshots",
				"strategy_data.market_identity",
				"strategy_data.symbol_mapping",
				"strategy_data.inventory_settlement_events",
			]),
		);
		expect(new Set(insertedSources)).toEqual(new Set(["maker_replay"]));
		expect(spool.stats()).toEqual(before);
		spool.close();
	});

	test("returns 500 for maker_replay insertion failure without spooling", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		const replay = structuredClone(fixture);
		replay.source = "maker_replay";
		for (const entry of replay.rows) entry.row.source = "maker_replay";
		const response = await handleArchiveRequest(post(replay), {
			inserter: async () => {
				throw new Error("ClickHouse is down");
			},
			spool,
			telemetry: new ArchiveForwarderTelemetry(noopRecorder),
		});
		expect(response.status).toBe(500);
		expect(spool.stats()).toMatchObject({
			queuedBatches: 0,
			queuedWork: 0,
			accountedBytes: 0,
		});
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
