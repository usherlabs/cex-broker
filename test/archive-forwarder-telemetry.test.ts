import { afterEach, describe, expect, test } from "bun:test";
import { handleArchiveRequest } from "../services/archive-forwarder/request";
import {
	ARCHIVE_FORWARDER_METRICS,
	ArchiveForwarderTelemetry,
	type ArchiveMetricsRecorder,
	createArchiveForwarderTelemetry,
} from "../services/archive-forwarder/telemetry";

type CounterRecord = {
	name: string;
	value: number;
	labels: Record<string, string | number>;
};

type GaugeRecord = CounterRecord;

function createCapturingTelemetry(): {
	telemetry: ArchiveForwarderTelemetry;
	counters: CounterRecord[];
	gauges: GaugeRecord[];
} {
	const counters: CounterRecord[] = [];
	const gauges: GaugeRecord[] = [];
	const recorder: ArchiveMetricsRecorder = {
		recordCounter: async (name, value, labels) => {
			counters.push({ name, value, labels });
		},
		setObservableGauge: async (name, value, labels) => {
			gauges.push({ name, value, labels });
		},
	};
	return {
		telemetry: new ArchiveForwarderTelemetry(recorder),
		counters,
		gauges,
	};
}

function archiveRequest(rows: unknown[]): Request {
	return new Request("http://localhost/archive", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			source: "broker_write",
			deployment_id: "deploy-a",
			rows,
		}),
	});
}

describe("archive forwarder telemetry", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("records inserted rows by table and updates the successful-flush heartbeat", async () => {
		const { telemetry, counters, gauges } = createCapturingTelemetry();
		const response = await handleArchiveRequest(
			archiveRequest([
				{ table: "market_data.candles", row: { open_time_ms: 1 } },
				{ table: "market_data.candles", row: { open_time_ms: 2 } },
				{
					table: "broker_execution.order_events",
					row: { order_id: "order-1" },
				},
			]),
			{ inserter: async () => {}, telemetry },
		);

		expect(response.status).toBe(200);
		expect(counters).toEqual(
			expect.arrayContaining([
				{
					name: ARCHIVE_FORWARDER_METRICS.rowsInserted,
					value: 2,
					labels: { table: "market_data.candles" },
				},
				{
					name: ARCHIVE_FORWARDER_METRICS.rowsInserted,
					value: 1,
					labels: { table: "broker_execution.order_events" },
				},
			]),
		);
		expect(gauges).toHaveLength(1);
		expect(gauges[0]?.name).toBe(ARCHIVE_FORWARDER_METRICS.lastSuccessfulFlush);
		expect(gauges[0]?.value).toBeGreaterThan(0);
	});

	test("records every rejected row by table, including malformed rows", async () => {
		const { telemetry, counters } = createCapturingTelemetry();
		let insertCalled = false;
		const response = await handleArchiveRequest(
			archiveRequest([
				{ table: "strategy_data.unknown", row: {} },
				{ table: "strategy_data.unknown", row: {} },
				{ table: 42, row: {} },
			]),
			{
				inserter: async () => {
					insertCalled = true;
				},
				telemetry,
			},
		);

		expect(response.status).toBe(400);
		expect(insertCalled).toBe(false);
		expect(counters).toEqual(
			expect.arrayContaining([
				{
					name: ARCHIVE_FORWARDER_METRICS.rowsRejected,
					value: 2,
					labels: { table: "strategy_data.unknown" },
				},
				{
					name: ARCHIVE_FORWARDER_METRICS.rowsRejected,
					value: 1,
					labels: { table: "(malformed)" },
				},
			]),
		);
	});

	test("records insert failures by table and coarse error class", async () => {
		const { telemetry, counters, gauges } = createCapturingTelemetry();
		const response = await handleArchiveRequest(
			archiveRequest([
				{ table: "market_data.cex_trades", row: { trade_id: "trade-1" } },
			]),
			{
				inserter: async () => {
					throw new Error("unknown table market_data.cex_trades");
				},
				telemetry,
			},
		);

		expect(response.status).toBe(500);
		expect(counters).toContainEqual({
			name: ARCHIVE_FORWARDER_METRICS.insertFailures,
			value: 1,
			labels: {
				table: "market_data.cex_trades",
				error_class: "schema",
			},
		});
		expect(gauges).toHaveLength(0);
	});

	test("keeps a successful request independent of throwing telemetry", async () => {
		const throwingRecorder: ArchiveMetricsRecorder = {
			recordCounter: async () => {
				throw new Error("exporter failed");
			},
			setObservableGauge: () => {
				throw new Error("exporter failed");
			},
		};
		const insertedTables: string[] = [];
		const response = await handleArchiveRequest(
			archiveRequest([
				{ table: "market_data.candles", row: { open_time_ms: 1 } },
			]),
			{
				inserter: async (table) => {
					insertedTables.push(table);
				},
				telemetry: new ArchiveForwarderTelemetry(throwingRecorder),
			},
		);

		expect(response.status).toBe(200);
		expect(insertedTables).toEqual(["market_data.candles"]);
	});

	test("keeps telemetry optional when no OTLP endpoint is configured", async () => {
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
		const response = await handleArchiveRequest(
			archiveRequest([
				{ table: "market_data.candles", row: { open_time_ms: 1 } },
			]),
			{
				inserter: async () => {},
				telemetry: createArchiveForwarderTelemetry(),
			},
		);

		expect(response.status).toBe(200);
	});
});
