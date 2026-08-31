import { afterEach, describe, expect, test } from "bun:test";
import { handleArchiveRequest } from "../services/archive-forwarder/request";
import {
	ARCHIVE_FORWARDER_METRICS,
	ArchiveForwarderTelemetry,
	type ArchiveMetricsRecorder,
	createArchiveForwarderTelemetry,
} from "../services/archive-forwarder/telemetry";
import { sha256Canonical } from "../src/helpers/market-data-archive/capture-contract";

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
			rows: rows.map((entry) => {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
					return entry;
				}
				const candidate = entry as { table?: unknown; row?: unknown };
				if (
					typeof candidate.table === "string" &&
					candidate.table.startsWith("market_data.") &&
					candidate.row &&
					typeof candidate.row === "object" &&
					!Array.isArray(candidate.row)
				) {
					return {
						...candidate,
						row: {
							...(candidate.row as Record<string, unknown>),
							source: "broker_write",
							deployment_id: "deploy-a",
						},
					};
				}
				return entry;
			}),
		}),
	});
}

describe("archive forwarder telemetry", () => {
	const originalEnv = { ...process.env };
	const marketIdentity = {
		source: "broker_write" as const,
		deploymentId: "deploy-a",
	};

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
			{ inserter: async () => {}, marketIdentity, telemetry },
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
			marketIdentity,
			telemetry,
		});

		expect(response.status).toBe(200);
		// A batch that inserts nothing must not look like a successful flush: a
		// staleness alert built on this gauge would stay green while no data reaches
		// ClickHouse, which is exactly the condition it exists to detect.
		expect(gauges).toHaveLength(0);
	});

	test("records bounded maker replay success and insertion-failure counters", async () => {
		const success = createCapturingTelemetry();
		const replayBody = {
			source: "maker_replay",
			deployment_id: "replay-a",
			rows: [
				{
					table: "strategy_data.policy_evaluation_events",
					row: {
						source: "maker_replay",
						deployment_id: "replay-a",
						schema_version: "1",
					},
				},
			],
		};
		const successResponse = await handleArchiveRequest(
			new Request("http://localhost/archive", {
				method: "POST",
				body: JSON.stringify(replayBody),
			}),
			{ inserter: async () => {}, telemetry: success.telemetry },
		);
		expect(successResponse.status).toBe(200);
		expect(success.counters).toEqual(
			expect.arrayContaining([
				{
					name: ARCHIVE_FORWARDER_METRICS.strategyReplayBatchesInserted,
					value: 1,
					labels: {},
				},
				{
					name: ARCHIVE_FORWARDER_METRICS.strategyReplayRowsInserted,
					value: 1,
					labels: {},
				},
			]),
		);

		const failure = createCapturingTelemetry();
		const failureResponse = await handleArchiveRequest(
			new Request("http://localhost/archive", {
				method: "POST",
				body: JSON.stringify(replayBody),
			}),
			{
				inserter: async () => {
					throw new Error("network unavailable");
				},
				telemetry: failure.telemetry,
			},
		);
		expect(failureResponse.status).toBe(500);
		expect(failure.counters).toContainEqual({
			name: ARCHIVE_FORWARDER_METRICS.strategyReplayInsertionFailures,
			value: 1,
			labels: {},
		});
		expect(
			failure.counters.some(({ name }) =>
				[
					ARCHIVE_FORWARDER_METRICS.strategyBatchesAdmitted,
					ARCHIVE_FORWARDER_METRICS.strategyRowsAdmitted,
				].includes(name),
			),
		).toBe(false);
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
				marketIdentity,
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
			{ inserter: async () => {}, marketIdentity, telemetry },
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
				marketIdentity,
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
			deployment_id: "deploy-a",
			capture_bundle_id: "bundle-a",
			exchange: "binance",
			symbol: "BTC/USDT",
			trading_pair: "BTC-USDT",
			source_symbol: "BTC/USDT",
			asset_type: "spot",
			feed: "ORDERBOOK",
			provider: "ccxt:binance",
			source_mode: "broker_live_sampling_v1",
			source_time_ms: 1,
			received_time_ms: 1,
			raw_capture_id: "a".repeat(64),
			raw_capture_scope: "ccxt_normalized_object",
			schema_version: "1.0.0",
			checksum_algorithm: "sha256-canonical-json-v1",
			raw_checksum: "b".repeat(64),
			provenance_complete: 1,
			snapshot_id: "c".repeat(64),
			construction_mode: "sampled_top_n_snapshot",
			gap_policy: "record_gap",
			depth_limit: 25,
			sequence: null,
			exact_l2_reconstruction_complete: 0,
			side: "bid",
			level_index: 0,
			price: 100,
			amount: 1,
			notional: 100,
			mid_price: 100.5,
			spread_from_mid_bps: 49.75124378109453,
		};
		const firstContent = { ...common, normalized_row_checksum: "" };
		const secondContent = {
			...common,
			amount: 2,
			notional: 200,
			normalized_row_checksum: "",
		};
		const response = await handleArchiveRequest(
			archiveRequest([
				{
					table: "market_data.cex_order_book_levels",
					row: {
						...firstContent,
						normalized_row_checksum: sha256Canonical(firstContent),
					},
				},
				{
					table: "market_data.cex_order_book_levels",
					row: {
						...secondContent,
						normalized_row_checksum: sha256Canonical(secondContent),
					},
				},
			]),
			{ inserter: async () => {}, marketIdentity, telemetry },
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
				marketIdentity,
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
				marketIdentity,
				telemetry: createArchiveForwarderTelemetry(),
			},
		);

		expect(response.status).toBe(200);
	});

	test("records durable strategy admission and spool state with bounded labels", () => {
		const { telemetry, counters, gauges } = createCapturingTelemetry();
		telemetry.recordStrategyAdmission(3);
		telemetry.recordStrategyAdmissionRejected("attacker-controlled-reason");
		telemetry.recordStrategyRetry(
			"strategy_data.policy_evaluation_events",
			"connection",
		);
		telemetry.recordStrategySpoolStats({
			queuedBatches: 2,
			queuedWork: 3,
			terminalWork: 1,
			expiredWork: 4,
			accountedBytes: 100,
			oldestAgeMs: 5_000,
			lastErrorClass: "connection",
		});

		expect(counters).toEqual(
			expect.arrayContaining([
				{
					name: ARCHIVE_FORWARDER_METRICS.strategyBatchesAdmitted,
					value: 1,
					labels: {},
				},
				{
					name: ARCHIVE_FORWARDER_METRICS.strategyRowsAdmitted,
					value: 3,
					labels: {},
				},
				{
					name: ARCHIVE_FORWARDER_METRICS.strategyAdmissionsRejected,
					value: 1,
					labels: { reason: "other" },
				},
			]),
		);
		expect(gauges.map((entry) => entry.name)).toEqual(
			expect.arrayContaining([
				ARCHIVE_FORWARDER_METRICS.strategySpoolPendingBatches,
				ARCHIVE_FORWARDER_METRICS.strategySpoolPendingWork,
				ARCHIVE_FORWARDER_METRICS.strategySpoolBytes,
				ARCHIVE_FORWARDER_METRICS.strategySpoolOldestAge,
			]),
		);
	});
});
