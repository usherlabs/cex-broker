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

	test("an empty batch does not advance the successful-flush heartbeat", async () => {
		const { telemetry, gauges } = createCapturingTelemetry();
		const response = await handleArchiveRequest(archiveRequest([]), {
			inserter: async () => {},
			telemetry,
		});

		expect(response.status).toBe(200);
		// A batch that inserts nothing must not look like a successful flush: a
		// staleness alert built on this gauge would stay green while no data reaches
		// ClickHouse, which is exactly the condition it exists to detect.
		expect(gauges).toHaveLength(0);
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
		// Unknown table names are client-controlled, so they are bucketed rather than
		// used verbatim as a label. The raw name stays in the response and the log.
		expect(counters).toEqual(
			expect.arrayContaining([
				{
					name: ARCHIVE_FORWARDER_METRICS.rowsRejected,
					value: 2,
					labels: { table: "(unsupported)" },
				},
				{
					name: ARCHIVE_FORWARDER_METRICS.rowsRejected,
					value: 1,
					labels: { table: "(malformed)" },
				},
			]),
		);
	});

	test("bounds rejected-row label cardinality no matter how many table names a client invents", async () => {
		const { telemetry, counters } = createCapturingTelemetry();
		const response = await handleArchiveRequest(
			archiveRequest(
				Array.from({ length: 50 }, (_, index) => ({
					table: `strategy_data.attacker_${index}`,
					row: {},
				})),
			),
			{ inserter: async () => {}, telemetry },
		);

		expect(response.status).toBe(400);
		const rejected = counters.filter(
			(entry) => entry.name === ARCHIVE_FORWARDER_METRICS.rowsRejected,
		);
		// One series, not fifty: each distinct label value would otherwise persist in
		// the metrics SDK, letting a client grow our memory without bound.
		expect(rejected).toEqual([
			{
				name: ARCHIVE_FORWARDER_METRICS.rowsRejected,
				value: 50,
				labels: { table: "(unsupported)" },
			},
		]);
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

	test("records same-batch checksum conflicts with bounded source/feed labels", async () => {
		const { telemetry, counters } = createCapturingTelemetry();
		const common = {
			source: "broker_write",
			capture_bundle_id: "bundle-a",
			exchange: "binance",
			trading_pair: "BTC-USDT",
			raw_capture_id: "raw-a",
			snapshot_id: "snapshot-a",
			schema_version: "1.0.0",
			side: "bid",
			level_index: 0,
		};
		const response = await handleArchiveRequest(
			archiveRequest([
				{
					table: "market_data.cex_order_book_levels",
					row: { ...common, normalized_row_checksum: "a" },
				},
				{
					table: "market_data.cex_order_book_levels",
					row: { ...common, normalized_row_checksum: "b" },
				},
			]),
			{ inserter: async () => {}, telemetry },
		);
		expect(response.status).toBe(400);
		expect(counters).toContainEqual({
			name: ARCHIVE_FORWARDER_METRICS.checksumConflicts,
			value: 2,
			labels: {
				source: "broker_write",
				feed: "ORDERBOOK",
				table: "market_data.cex_order_book_levels",
			},
		});
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
