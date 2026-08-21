import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import {
	exportCanonicalOrderBookParquet,
	validateCanonicalMarketReplayWindow,
} from "../scripts/export-canonical-orderbook-parquet";
import { createClickHouseInserter } from "../services/archive-forwarder/insert";
import { handleArchiveBatch } from "../services/archive-forwarder/router";
import { ensureArchiveSchema } from "../services/archive-forwarder/schema";
import {
	createClickHouseExactOrderBookExportClient,
	exportExactCanonicalOrderBook,
} from "../src/helpers/canonical-orderbook-export/exporter";
import { buildCanonicalOrderBookRows } from "../src/helpers/market-data-archive/canonical-orderbook";
import {
	createRawCapture,
	sha256Canonical,
} from "../src/helpers/market-data-archive/capture-contract";
import { buildLegacyOhlcvMigrationRow } from "../src/helpers/market-data-archive/legacy-migration";
import {
	buildCanonicalCexStreamEventRow,
	buildCanonicalOhlcvRow,
	buildCanonicalTickerEventRow,
	buildCanonicalTradeRow,
} from "../src/helpers/market-data-archive/rows";
import type { MarketCaptureContext } from "../src/helpers/market-data-archive/types";
import { CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID } from "../src/helpers/market-data-preparation/contracts";
import {
	createClickHouseArchiveQueryClient,
	QualifiedOrderBookArchiveReader,
} from "../src/helpers/market-data-vendor-backfill/archive-reader";
import {
	BACKFILL_REQUEST_SCHEMA_VERSION,
	EXTERNAL_BACKFILL_SOURCE,
	finalizeArchiveSelection,
	HISTORICAL_VENDOR_SOURCE_MODE,
	PROMOTION_RECEIPT_SCHEMA_ID,
	VENDOR_DATASET_RAW_CAPTURE_SCOPE,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	CAPABILITY_POLICY,
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";
import {
	finalizePromotionReceipt,
	promotionReceiptToArchiveRow,
} from "../src/helpers/market-data-vendor-backfill/promotion";
import {
	finalizeQualificationEvent,
	qualificationEventToArchiveRow,
} from "../src/helpers/market-data-vendor-backfill/qualification";

const CLICKHOUSE_URL =
	process.env.CLICKHOUSE_TEST_URL?.trim() ||
	`http://${process.env.CLICKHOUSE_HOST?.trim() || "localhost"}:${process.env.CLICKHOUSE_PORT?.trim() || "18123"}`;
const CLICKHOUSE_USERNAME = process.env.CLICKHOUSE_USER?.trim() || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";

const TEST_DEPLOYMENT = `clickhouse-integration-test-${Date.now()}`;
const TEST_EVENT_MS = 1_900_000_000_000;

let client: ClickHouseClient | undefined;
let clickhouseAvailable = false;

function requireClient(): ClickHouseClient {
	if (!client) {
		throw new Error("ClickHouse client is not initialized");
	}
	return client;
}

// An unreachable host normally refuses the connection immediately, but a
// half-started server can accept the socket and never answer. Without a
// deadline the probe would block beforeAll indefinitely and the file would be
// reported as a wall of per-test timeouts naming neither ClickHouse nor the
// URL. The deadline turns that into a definite unavailable verdict, and the
// reason is carried so the required-service failure says what went wrong.
const PROBE_TIMEOUT_MS = 10_000;

type ProbeResult = { available: true } | { available: false; reason: string };

async function probeClickHouse(): Promise<ProbeResult> {
	const probe = createClient({
		url: CLICKHOUSE_URL,
		username: CLICKHOUSE_USERNAME,
		password: CLICKHOUSE_PASSWORD,
	});
	try {
		const result = await probe.query({
			query: "SELECT 1 AS ok",
			format: "JSONEachRow",
			abort_signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		const rows = (await result.json()) as Array<{ ok: number }>;
		return rows[0]?.ok === 1
			? { available: true }
			: { available: false, reason: "probe query did not return SELECT 1" };
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "TimeoutError"
				? `probe did not answer within ${PROBE_TIMEOUT_MS}ms`
				: error instanceof Error
					? error.message
					: String(error);
		return { available: false, reason };
	} finally {
		await probe.close();
	}
}

async function tableEngine(name: string): Promise<string | null> {
	const activeClient = requireClient();
	const result = await activeClient.query({
		query: `
			SELECT engine
			FROM system.tables
			WHERE database = 'market_data' AND name = {name:String}
		`,
		query_params: { name },
		format: "JSONEachRow",
	});
	const rows = (await result.json()) as Array<{ engine: string }>;
	return rows[0]?.engine ?? null;
}

async function cleanupTestRows(): Promise<void> {
	const activeClient = requireClient();
	await activeClient.command({
		query: `
			ALTER TABLE orderbook_snapshots
			DELETE WHERE deployment_id = {deployment_id:String}
		`,
		query_params: { deployment_id: TEST_DEPLOYMENT },
	});
	for (const table of [
		"cex_stream_events",
		"cex_ticker_events",
		"cex_trades",
		"cex_order_book_levels",
		"cex_order_book_depth_summary",
		"cex_order_book_capture_promotions",
		"cex_ohlcv",
	]) {
		await activeClient.command({
			query: `ALTER TABLE ${table} DELETE WHERE deployment_id = {deployment_id:String}`,
			query_params: { deployment_id: TEST_DEPLOYMENT },
		});
		await activeClient.command({ query: `OPTIMIZE TABLE ${table} FINAL` });
	}
	await activeClient.command({
		query: `
			ALTER TABLE cex_order_book_capture_promotions
			DELETE WHERE startsWith(request_id, {request_prefix:String})
		`,
		query_params: { request_prefix: TEST_DEPLOYMENT },
	});
	await activeClient.command({
		query: "OPTIMIZE TABLE cex_order_book_capture_promotions FINAL",
	});
	await activeClient.command({
		query: `
			ALTER TABLE candles
			DELETE WHERE deployment_id = {deployment_id:String}
		`,
		query_params: { deployment_id: TEST_DEPLOYMENT },
	});
	await activeClient.command({
		query: "OPTIMIZE TABLE orderbook_snapshots FINAL",
	});
	await activeClient.command({
		query: "OPTIMIZE TABLE candles FINAL",
	});
	for (const table of [
		"policy_evaluation_events",
		"strategy_policy_snapshots",
		"market_identity",
		"symbol_mapping",
		"inventory_settlement_events",
	]) {
		await activeClient.command({
			query: `
				ALTER TABLE strategy_data.${table}
				DELETE WHERE deployment_id = {deployment_id:String}
			`,
			query_params: { deployment_id: TEST_DEPLOYMENT },
		});
		await activeClient.command({
			query: `OPTIMIZE TABLE strategy_data.${table} FINAL`,
		});
	}
}

describe("ClickHouse market_data schema integration", () => {
	beforeAll(async () => {
		const probe = await probeClickHouse();
		clickhouseAvailable = probe.available;
		if (!probe.available) {
			if (process.env.CLICKHOUSE_REQUIRED === "1") {
				throw new Error(
					`Required ClickHouse integration service is unavailable at ${CLICKHOUSE_URL}: ${probe.reason}`,
				);
			}
			return;
		}
		const bootstrap = createClient({
			url: CLICKHOUSE_URL,
			username: CLICKHOUSE_USERNAME,
			password: CLICKHOUSE_PASSWORD,
		});
		await bootstrap.command({
			query: "CREATE DATABASE IF NOT EXISTS market_data",
		});
		await bootstrap.close();
		client = createClient({
			url: CLICKHOUSE_URL,
			database: "market_data",
			username: CLICKHOUSE_USERNAME,
			password: CLICKHOUSE_PASSWORD,
		});
		await ensureArchiveSchema(client);
		try {
			await cleanupTestRows();
		} catch {
			// Tables may not exist yet on a fresh instance.
		}
	});

	afterAll(async () => {
		if (!clickhouseAvailable || !client) {
			return;
		}
		try {
			await cleanupTestRows();
		} catch {
			// Best-effort cleanup for local dev runs.
		}
		await client.close();
	});

	test("orderbook_tob and orderbook_depth are views over orderbook_snapshots", async () => {
		if (!clickhouseAvailable || !client) {
			return;
		}

		expect(await tableEngine("orderbook_snapshots")).toBe("MergeTree");
		expect(await tableEngine("orderbook_tob")).toBe("View");
		expect(await tableEngine("orderbook_depth")).toBe("View");
		expect(await tableEngine("candles_closed")).toBe("View");
		expect(await tableEngine("cex_order_book_levels")).toBe("MergeTree");
		expect(await tableEngine("cex_order_book_depth_summary")).toBe("MergeTree");
		expect(await tableEngine("cex_order_book_capture_promotions")).toBe(
			"MergeTree",
		);
		expect(await tableEngine("cex_order_book_capture_qualifications")).toBe(
			"MergeTree",
		);
		expect(await tableEngine("cex_order_book_archive_selections")).toBe(
			"MergeTree",
		);
		expect(await tableEngine("cex_archive_cluster_identity")).toBe(
			"ReplacingMergeTree",
		);
		expect(await tableEngine("cex_order_book_levels_canonical")).toBe("View");
		expect(await tableEngine("cex_order_book_levels_conflicts")).toBe("View");
		expect(await tableEngine("cex_order_book_levels_replay_qualified")).toBe(
			"View",
		);
		expect(
			await tableEngine("cex_order_book_depth_summary_replay_qualified"),
		).toBe("View");
		expect(await tableEngine("cex_ohlcv")).toBe("ReplacingMergeTree");
		expect(await tableEngine("cex_ohlcv_closed")).toBe("View");
	});

	test("external history remains physical and becomes replay-qualified only after an exact promotion", async () => {
		if (!clickhouseAvailable || !client) return;
		const sourceTimeMs = Date.UTC(2025, 6, 1, 10, 30);
		const captureBundleId = sha256Canonical({
			testDeployment: TEST_DEPLOYMENT,
		});
		const context: MarketCaptureContext = {
			source: EXTERNAL_BACKFILL_SOURCE,
			deploymentId: TEST_DEPLOYMENT,
			captureBundleId,
			exchange: "binance",
			symbol: "TEST/EXTERNAL",
			tradingPair: "TEST-EXTERNAL",
			sourceSymbol: "TESTEXTERNAL",
			assetType: "spot",
			feed: "ORDERBOOK",
			provider: "cryptohftdata",
			sourceMode: HISTORICAL_VENDOR_SOURCE_MODE,
			schemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
			provenanceComplete: true,
		};
		const canonical = buildCanonicalOrderBookRows({
			context,
			rawCapture: {
				rawCaptureId: "c".repeat(64),
				rawCaptureScope: VENDOR_DATASET_RAW_CAPTURE_SCOPE,
				rawChecksum: "d".repeat(64),
				redactedPayload: {
					dataset_object_identity:
						"binance_spot/2025-07-01/10/TESTEXTERNAL_orderbook.parquet.zst",
					dataset_object_checksum: "d".repeat(64),
				},
				eventTimeMs: sourceTimeMs,
				receivedTimeMs: sourceTimeMs + 10,
				checksumAlgorithm: "sha256-canonical-json-v1",
			},
			depthLimit: 1,
			constructionMode: "sampled_top_n_snapshot",
			snapshot: {
				bids: [[100, 1]],
				asks: [[101, 2]],
				timestamp: sourceTimeMs,
				receivedTimestamp: sourceTimeMs + 10,
				exchange: "binance",
				symbol: "TEST/EXTERNAL",
				depthLimit: 1,
				sequence: "9007199254740993",
			},
		});
		const candidateRows = [...canonical.levels, canonical.summary];
		const candidateInsert = await handleArchiveBatch(
			createClickHouseInserter(client),
			{
				source: EXTERNAL_BACKFILL_SOURCE,
				deployment_id: TEST_DEPLOYMENT,
				batch_id: "candidate-integration",
				rows: candidateRows,
			},
		);
		expect(candidateInsert).toMatchObject({
			inserted: candidateRows.length,
			failed: 0,
		});
		await client.command({
			query: "OPTIMIZE TABLE cex_order_book_levels FINAL",
		});
		await client.command({
			query: "OPTIMIZE TABLE cex_order_book_depth_summary FINAL",
		});

		const counts = async () => {
			const result = await requireClient().query({
				query: `
					SELECT
						(SELECT count() FROM cex_order_book_levels
						 WHERE capture_bundle_id = {bundle:String}) AS physical_levels,
						(SELECT count() FROM cex_order_book_levels_replay_qualified
						 WHERE capture_bundle_id = {bundle:String}) AS qualified_levels,
						(SELECT count() FROM cex_order_book_depth_summary_replay_qualified
						 WHERE capture_bundle_id = {bundle:String}) AS qualified_summaries
				`,
				query_params: { bundle: captureBundleId },
				format: "JSONEachRow",
			});
			return (await result.json()) as Array<Record<string, string>>;
		};
		expect(await counts()).toEqual([
			{
				physical_levels: "2",
				qualified_levels: "0",
				qualified_summaries: "0",
			},
		]);

		const promotion = (depth: number) => {
			const receipt = finalizePromotionReceipt({
				schema_id: PROMOTION_RECEIPT_SCHEMA_ID,
				verified_at: new Date(sourceTimeMs + depth).toISOString(),
				request_id: `018f0f4d-7b32-7a30-8f4d-1d2a6e40f1${depth.toString().padStart(2, "0")}`,
				idempotency_key: "e".repeat(64),
				source: EXTERNAL_BACKFILL_SOURCE,
				capture_origin: "vendor_historical_backfill",
				source_mode: HISTORICAL_VENDOR_SOURCE_MODE,
				provider: "cryptohftdata",
				adapter_version: "cryptohftdata-orderbook/v2",
				effective_policies: {
					capability_policy: {
						policy_id: CAPABILITY_POLICY.policy_id,
						policy_sha256: CAPABILITY_POLICY.policy_sha256,
					},
					resource_policy: {
						policy_id: RESOURCE_POLICY.policy_id,
						policy_sha256: RESOURCE_POLICY.policy_sha256,
					},
					adapter_policy: EFFECTIVE_ADAPTER_POLICY_PIN,
					acquisition_policy: EFFECTIVE_ACQUISITION_POLICY_PIN,
				},
				capture_bundle_id: captureBundleId,
				scope: {
					exchange: "binance",
					trading_pair: "TEST-EXTERNAL",
					market_type: "spot",
					feed: "ORDERBOOK",
				},
				window: {
					start_at: new Date(sourceTimeMs - 1).toISOString(),
					end_at: new Date(sourceTimeMs + 1).toISOString(),
				},
				depth,
				construction_mode: "sampled_top_n_snapshot",
				canonical_schema: {
					schema_id: "cex-order-book-canonical/v1",
					schema_sha256: "a".repeat(64),
				},
				coverage_policy: {
					policy_id: "prior-asof-strict/v1",
					max_asof_lag_ms: 1,
					future_rows: "reject",
					missing_required_event: "fail",
				},
				selection_sha256: "5".repeat(64),
				vendor_semantic_digest: "1".repeat(64),
				canonical_semantic_digest: "2".repeat(64),
				prefix_digest: "3".repeat(64),
				suffix_digest: "4".repeat(64),
				seam_verified: true,
				coverage_verified: true,
				dataset_objects: [
					{
						identity:
							"binance_spot/2025-07-01/10/TESTEXTERNAL_orderbook.parquet.zst",
						checksum: "d".repeat(64),
						bytes: 10,
						rows: 2,
					},
				],
			});
			return { receipt, row: promotionReceiptToArchiveRow(receipt) };
		};

		for (const depth of [2, 1]) {
			const { receipt, row } = promotion(depth);
			const inserted = await handleArchiveBatch(
				createClickHouseInserter(client),
				{
					source: EXTERNAL_BACKFILL_SOURCE,
					deployment_id: TEST_DEPLOYMENT,
					batch_id: `promotion-integration-${depth}`,
					rows: [row],
				},
			);
			expect(inserted.failed).toBe(0);
			if (depth === 1) {
				const qualification = qualificationEventToArchiveRow(
					finalizeQualificationEvent({
						capture_bundle_id: receipt.capture_bundle_id,
						state: "qualified",
						receipt_id: receipt.receipt_id,
						promotion_identity_sha256: receipt.promotion_identity_sha256,
						window: receipt.window,
						event_at: new Date(sourceTimeMs + 10).toISOString(),
						reason_code: "integration_qualified",
					}),
				);
				const qualificationInsert = await handleArchiveBatch(
					createClickHouseInserter(client),
					{
						source: EXTERNAL_BACKFILL_SOURCE,
						deployment_id: "market-data-vendor-backfill",
						batch_id: "qualification-integration",
						rows: [qualification],
					},
				);
				expect(qualificationInsert.failed).toBe(0);
			}
			expect((await counts())[0]).toMatchObject({
				physical_levels: "2",
				qualified_levels: depth === 1 ? "2" : "0",
				qualified_summaries: depth === 1 ? "1" : "0",
			});
		}
		const qualifiedReceipt = promotion(1).receipt;
		const appendQualification = async (
			state: "qualified" | "quarantined" | "revoked",
			offsetMs: number,
		) => {
			const finalizedEvent = finalizeQualificationEvent({
				capture_bundle_id: qualifiedReceipt.capture_bundle_id,
				state,
				receipt_id: qualifiedReceipt.receipt_id,
				promotion_identity_sha256: qualifiedReceipt.promotion_identity_sha256,
				window: qualifiedReceipt.window,
				event_at: new Date(sourceTimeMs + offsetMs).toISOString(),
				reason_code: `integration_${state}`,
			});
			const event = qualificationEventToArchiveRow(finalizedEvent);
			const result = await handleArchiveBatch(
				createClickHouseInserter(client),
				{
					source: EXTERNAL_BACKFILL_SOURCE,
					deployment_id: "market-data-vendor-backfill",
					batch_id: `qualification-integration-${state}-${offsetMs}`,
					rows: [event],
				},
			);
			expect(result.failed).toBe(0);
			return finalizedEvent;
		};
		await appendQualification("quarantined", 20);
		expect((await counts())[0]).toMatchObject({
			qualified_levels: "0",
			qualified_summaries: "0",
		});
		await appendQualification("revoked", 30);
		expect((await counts())[0]).toMatchObject({
			qualified_levels: "0",
			qualified_summaries: "0",
		});
		const currentQualification = await appendQualification("qualified", 40);
		expect((await counts())[0]).toMatchObject({
			qualified_levels: "2",
			qualified_summaries: "1",
		});
		const requestBusiness = {
			schemaVersion: BACKFILL_REQUEST_SCHEMA_VERSION,
			requestId: `${TEST_DEPLOYMENT}-reader`,
			providerPolicy: {
				provider: "cryptohftdata" as const,
				allowedAdapterVersions: ["cryptohftdata-orderbook/v1"],
			},
			scope: {
				exchange: "binance",
				tradingPair: "TEST-EXTERNAL",
				sourceSymbol: "TESTEXTERNAL",
				marketType: "spot" as const,
				feed: "ORDERBOOK" as const,
			},
			window: { startTimeMs: sourceTimeMs - 1, endTimeMs: sourceTimeMs + 1 },
			depth: 1,
			constructionMode: "sampled_top_n_snapshot" as const,
			requiredClockTargetsMs: [sourceTimeMs],
			maxPriorAsOfLagMs: 1,
			sourcePolicy: "authoritative_window" as const,
			budgets: {
				maxFiles: 1,
				maxBytes: 1,
				maxRows: 1,
				maxDurationMs: 1,
				maxBoundaryLookbackMs: 0,
			},
			expectedProduct: {
				packageName: "@usherlabs/cex-broker" as const,
				canonicalSchemaVersion: "1.0.0",
				checksumAlgorithm: "sha256-canonical-json-v1" as const,
			},
		};
		const qualifiedCoverage = await new QualifiedOrderBookArchiveReader(
			createClickHouseArchiveQueryClient({
				url: CLICKHOUSE_URL,
				username: CLICKHOUSE_USERNAME,
				password: CLICKHOUSE_PASSWORD,
			}),
		).coverage({
			...requestBusiness,
			idempotencyKey: "e".repeat(64),
		});
		expect(qualifiedCoverage.complete).toBe(true);

		const outputDirectory = await mkdtemp(
			join(tmpdir(), "cex-broker-external-parquet-test-"),
		);
		try {
			await client.insert({
				table: "cex_archive_cluster_identity",
				format: "JSONEachRow",
				values: [
					{
						singleton_key: "archive",
						environment: "integration",
						cluster: "clickhouse-schema-test",
						configured_at_ms: sourceTimeMs,
						configuration_sha256: "9".repeat(64),
					},
				],
			});
			const selection = finalizeArchiveSelection({
				schema_id:
					"https://schemas.usher.so/market-data-vendor-backfill-archive-selection/v1",
				scope: qualifiedReceipt.scope,
				required_clock: {
					clock_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f130",
					clock_sha256: "8".repeat(64),
					event_count: 1,
				},
				coverage_policy: qualifiedReceipt.coverage_policy,
				source_policy: "authoritative_window",
				coverage_class: "complete",
				requested_intervals: [qualifiedReceipt.window],
				selected_intervals: [
					{
						...qualifiedReceipt.window,
						capture_bundle_id: captureBundleId,
						capture_origin: "vendor_historical_backfill",
					},
				],
				precedence: ["vendor"],
				bundles: [
					{
						capture_bundle_id: captureBundleId,
						capture_origin: "vendor_historical_backfill",
						interval: qualifiedReceipt.window,
						qualification: {
							qualification_event_id:
								currentQualification.qualification_event_id,
							state: "qualified",
							receipt_id: qualifiedReceipt.receipt_id,
							promotion_identity_sha256:
								qualifiedReceipt.promotion_identity_sha256,
						},
					},
				],
				support_anchors: [],
				receipt_ids: [qualifiedReceipt.receipt_id],
				qualification_event_ids: [currentQualification.qualification_event_id],
				resolved_at: new Date(sourceTimeMs + 41).toISOString(),
			});
			const exported = await exportExactCanonicalOrderBook({
				request: {
					schema_id: CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
					request_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f131",
					target: {
						environment: "integration",
						cluster: "clickhouse-schema-test",
					},
					selection,
					depth: 1,
					construction_mode: "sampled_top_n_snapshot",
					canonical_schema_version: "1.0.0",
					checksum_algorithm: "sha256-canonical-json-v1",
				},
				client: createClickHouseExactOrderBookExportClient({
					url: CLICKHOUSE_URL,
					username: CLICKHOUSE_USERNAME,
					password: CLICKHOUSE_PASSWORD,
				}),
				outputDirectory,
			});
			expect(exported).toMatchObject({
				levels: { rows: 2 },
				summary: { rows: 1 },
			});
			expect(exported.promotionReceiptIds).toEqual([
				qualifiedReceipt.receipt_id,
			]);
			for (const artifactPath of [exported.levelsPath, exported.summaryPath]) {
				const bytes = await readFile(artifactPath);
				expect(bytes.subarray(0, 4).toString()).toBe("PAR1");
				expect(bytes.subarray(-4).toString()).toBe("PAR1");
			}
		} finally {
			await rm(outputDirectory, { recursive: true, force: true });
		}
	});

	test("canonical views deduplicate agreement, expose conflicts, and accept incomplete legacy provenance", async () => {
		if (!clickhouseAvailable || !client) return;
		const context: MarketCaptureContext = {
			source: "broker_read",
			deploymentId: TEST_DEPLOYMENT,
			captureBundleId: "integration-bundle",
			exchange: "binance",
			symbol: "TEST/CANONICAL",
			assetType: "spot",
			feed: "ORDERBOOK",
			provider: "ccxt:binance",
			sourceMode: "broker_live_sampling_v1",
			schemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
			provenanceComplete: true,
		};
		const snapshot = {
			bids: [[100, 1]],
			asks: [[101, 2]],
			timestamp: TEST_EVENT_MS + 300_000,
			receivedTimestamp: TEST_EVENT_MS + 300_010,
			exchange: "binance",
			symbol: "TEST/CANONICAL",
			depthLimit: 1,
			sequence: 7,
		};
		const raw = createRawCapture(context, {
			payload: snapshot,
			eventTimeMs: snapshot.timestamp,
			receivedTimeMs: snapshot.receivedTimestamp,
			scope: "ccxt_normalized_object",
		});
		const canonical = buildCanonicalOrderBookRows({
			context,
			snapshot,
			rawCapture: raw,
			depthLimit: 1,
		});
		const duplicateRows = [
			...canonical.levels,
			canonical.summary,
			...canonical.levels,
			canonical.summary,
		];
		const inserted = await handleArchiveBatch(
			createClickHouseInserter(client),
			{
				source: "broker_read",
				deployment_id: TEST_DEPLOYMENT,
				rows: duplicateRows,
			},
		);
		expect(inserted.failed).toBe(0);

		const counts = await client.query({
			query: `
				SELECT
					(SELECT count() FROM cex_order_book_levels WHERE snapshot_id = {snapshot:String}) AS physical,
					(SELECT count() FROM cex_order_book_levels_canonical WHERE snapshot_id = {snapshot:String}) AS canonical
			`,
			query_params: { snapshot: canonical.snapshotId },
			format: "JSONEachRow",
		});
		expect(await counts.json()).toEqual([{ physical: "4", canonical: "2" }]);

		const firstLevel = canonical.levels[0] as (typeof canonical.levels)[number];
		for (const checksum of ["conflict-a", "conflict-b"]) {
			await handleArchiveBatch(createClickHouseInserter(client), {
				source: "broker_read",
				deployment_id: TEST_DEPLOYMENT,
				rows: [
					{
						...firstLevel,
						row: {
							...firstLevel.row,
							normalized_row_checksum: checksum,
						},
					},
				],
			});
		}
		const conflicts = await client.query({
			query: `
				SELECT
					(SELECT count() FROM cex_order_book_levels_conflicts
					 WHERE snapshot_id = {snapshot:String} AND side = {side:String}
					   AND level_index = {level_index:UInt16}) AS conflicts,
					(SELECT count() FROM cex_order_book_levels_canonical
					 WHERE snapshot_id = {snapshot:String} AND side = {side:String}
					   AND level_index = {level_index:UInt16}) AS replay_rows
			`,
			query_params: {
				snapshot: canonical.snapshotId,
				side: firstLevel.row.side,
				level_index: firstLevel.row.level_index,
			},
			format: "JSONEachRow",
		});
		expect(await conflicts.json()).toEqual([
			{ conflicts: "1", replay_rows: "0" },
		]);

		const legacy = buildLegacyOhlcvMigrationRow({
			deployment_id: TEST_DEPLOYMENT,
			exchange: "binance",
			asset_type: "spot",
			symbol: "TEST/CANONICAL",
			timeframe: "1m",
			open_time_ms: TEST_EVENT_MS + 360_000,
			open: 1,
			high: 2,
			low: 0.5,
			close: 1.5,
			volume: 10,
			is_closed: 1,
			broker_version: 1,
		});
		await handleArchiveBatch(createClickHouseInserter(client), {
			source: "broker_write",
			deployment_id: TEST_DEPLOYMENT,
			rows: [legacy],
		});
		const provenance = await client.query({
			query: `
				SELECT isNull(capture_bundle_id) AS bundle_null,
				       isNull(raw_capture_id) AS raw_null,
				       isNull(raw_checksum) AS checksum_null,
				       provenance_complete, source_mode
				FROM cex_ohlcv FINAL
				WHERE deployment_id = {deployment:String}
			`,
			query_params: { deployment: TEST_DEPLOYMENT },
			format: "JSONEachRow",
		});
		expect(await provenance.json()).toEqual([
			{
				bundle_null: 1,
				raw_null: 1,
				checksum_null: 1,
				provenance_complete: 0,
				source_mode: "legacy_migration_v1",
			},
		]);
	});

	test("all four feeds retain raw linkage and reproducible canonical checksums", async () => {
		if (!clickhouseAvailable || !client) return;
		const receivedTimeMs = TEST_EVENT_MS + 500_010;
		const captureBundleId = "integration-four-feed-bundle";
		const baseContext = {
			source: "broker_read" as const,
			deploymentId: TEST_DEPLOYMENT,
			captureBundleId,
			exchange: "binance",
			symbol: "TEST/FOUR-FEED",
			assetType: "spot" as const,
			provider: "ccxt:binance",
			schemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
			provenanceComplete: true,
		};
		const tickerContext: MarketCaptureContext = {
			...baseContext,
			feed: "TICKER",
			sourceMode: "broker_live_stream_v1",
		};
		const ticker = {
			eventTimeMs: TEST_EVENT_MS + 500_000,
			last: 100.5,
			bid: 100,
			ask: 101,
		};
		const tickerRaw = createRawCapture(tickerContext, {
			payload: ticker,
			eventTimeMs: ticker.eventTimeMs,
			receivedTimeMs,
			scope: "ccxt_normalized_object",
		});
		const tickerRows = [
			buildCanonicalCexStreamEventRow(tickerContext, tickerRaw),
			buildCanonicalTickerEventRow(tickerContext, tickerRaw, ticker),
		];

		const tradesContext: MarketCaptureContext = {
			...baseContext,
			feed: "TRADES",
			sourceMode: "broker_live_stream_v1",
		};
		const trade = {
			eventTimeMs: TEST_EVENT_MS + 500_001,
			tradeId: "integration-trade-1",
			side: "buy",
			price: 100.5,
			amount: 2,
			cost: 201,
		};
		const tradeRaw = createRawCapture(tradesContext, {
			payload: trade,
			eventTimeMs: trade.eventTimeMs,
			receivedTimeMs,
			scope: "ccxt_normalized_object",
		});
		const tradeRows = [
			buildCanonicalCexStreamEventRow(tradesContext, tradeRaw),
			buildCanonicalTradeRow(tradesContext, tradeRaw, trade),
		];

		const ohlcvContext: MarketCaptureContext = {
			...baseContext,
			feed: "OHLCV",
			timeframe: "1m",
			sourceMode: "broker_live_stream_v1",
		};
		const bar = {
			openTimeMs: TEST_EVENT_MS + 480_000,
			open: 100,
			high: 102,
			low: 99,
			close: 101,
			volume: 10,
		};
		const ohlcvRaw = createRawCapture(ohlcvContext, {
			payload: bar,
			eventTimeMs: bar.openTimeMs,
			receivedTimeMs,
			scope: "ccxt_normalized_object",
		});
		const ohlcvRows = [
			buildCanonicalCexStreamEventRow(ohlcvContext, ohlcvRaw),
			buildCanonicalOhlcvRow({
				context: ohlcvContext,
				rawCapture: ohlcvRaw,
				bar,
				isClosed: true,
				brokerVersion: receivedTimeMs,
			}),
		];

		const orderBookContext: MarketCaptureContext = {
			...baseContext,
			feed: "ORDERBOOK",
			sourceMode: "broker_live_sampling_v1",
		};
		const snapshot = {
			bids: [[100, 1]],
			asks: [[101, 2]],
			timestamp: TEST_EVENT_MS + 500_002,
			receivedTimestamp: receivedTimeMs,
			exchange: "binance",
			symbol: "TEST/FOUR-FEED",
			depthLimit: 1,
			sequence: 9,
		};
		const orderBookRaw = createRawCapture(orderBookContext, {
			payload: snapshot,
			eventTimeMs: snapshot.timestamp,
			receivedTimeMs,
			scope: "ccxt_normalized_object",
		});
		const orderBook = buildCanonicalOrderBookRows({
			context: orderBookContext,
			snapshot,
			rawCapture: orderBookRaw,
			depthLimit: 1,
		});
		const allRows = [
			...tickerRows,
			...tradeRows,
			...ohlcvRows,
			buildCanonicalCexStreamEventRow(orderBookContext, orderBookRaw),
			...orderBook.levels,
			orderBook.summary,
		];

		const inserted = await handleArchiveBatch(
			createClickHouseInserter(client),
			{
				source: "broker_read",
				deployment_id: TEST_DEPLOYMENT,
				rows: allRows,
			},
		);
		expect(inserted.inserted).toBe(allRows.length);
		expect(inserted.failed).toBe(0);

		const links = await client.query({
			query: `
				SELECT feed, raw_capture_id, raw_checksum, normalized_row_checksum
				FROM cex_stream_events
				WHERE deployment_id = {deployment:String}
				  AND capture_bundle_id = {bundle:String}
				ORDER BY feed
			`,
			query_params: {
				deployment: TEST_DEPLOYMENT,
				bundle: captureBundleId,
			},
			format: "JSONEachRow",
		});
		const rawRows = (await links.json()) as Array<{
			feed: string;
			raw_capture_id: string;
			raw_checksum: string;
			normalized_row_checksum: string;
		}>;
		expect(rawRows).toHaveLength(4);
		const expectedRaw = new Map(
			[tickerRaw, tradeRaw, ohlcvRaw, orderBookRaw].map((raw) => [
				raw.rawCaptureId,
				raw.rawChecksum,
			]),
		);
		for (const row of rawRows) {
			expect(row.raw_checksum).toBe(expectedRaw.get(row.raw_capture_id));
			expect(row.normalized_row_checksum).toMatch(/^[a-f0-9]{64}$/);
		}

		for (const [table, expected] of [
			["cex_ticker_events", tickerRows[1]],
			["cex_trades", tradeRows[1]],
			["cex_ohlcv", ohlcvRows[1]],
			["cex_order_book_depth_summary", orderBook.summary],
		] as const) {
			const result = await client.query({
				query: `
					SELECT raw_capture_id, normalized_row_checksum
					FROM ${table}${table === "cex_ohlcv" ? " FINAL" : ""}
					WHERE deployment_id = {deployment:String}
					  AND capture_bundle_id = {bundle:String}
				`,
				query_params: {
					deployment: TEST_DEPLOYMENT,
					bundle: captureBundleId,
				},
				format: "JSONEachRow",
			});
			const rows = (await result.json()) as Array<{
				raw_capture_id: string;
				normalized_row_checksum: string;
			}>;
			expect(rows).toContainEqual({
				raw_capture_id: expected?.row.raw_capture_id,
				normalized_row_checksum: expected?.row.normalized_row_checksum,
			});
		}

		const replay = await validateCanonicalMarketReplayWindow({
			clickhouseUrl: CLICKHOUSE_URL,
			username: CLICKHOUSE_USERNAME,
			password: CLICKHOUSE_PASSWORD,
			captureBundleIds: [captureBundleId],
			exchange: "binance",
			tradingPair: "TEST-FOUR-FEED",
			startTimeMs: TEST_EVENT_MS + 480_000,
			endTimeMs: TEST_EVENT_MS + 500_100,
		});
		expect(replay.rawRowsByFeed).toEqual({
			OHLCV: 1,
			ORDERBOOK: 1,
			TICKER: 1,
			TRADES: 1,
		});
		expect(replay.normalizedRows).toEqual({
			levels: 2,
			summaries: 1,
			tickers: 1,
			trades: 1,
			ohlcv: 1,
		});
	});

	test("replay validation blocks a configured window with a checksum conflict", async () => {
		if (!clickhouseAvailable || !client) return;
		await expect(
			validateCanonicalMarketReplayWindow({
				clickhouseUrl: CLICKHOUSE_URL,
				username: CLICKHOUSE_USERNAME,
				password: CLICKHOUSE_PASSWORD,
				captureBundleIds: ["integration-bundle"],
				exchange: "binance",
				tradingPair: "TEST-CANONICAL",
				startTimeMs: TEST_EVENT_MS + 300_000,
				endTimeMs: TEST_EVENT_MS + 300_100,
			}),
		).rejects.toThrow("checksum conflicts");
	});

	test("exports checksum-consistent order-book capture core as parquet", async () => {
		if (!clickhouseAvailable || !client) return;
		const outputDirectory = await mkdtemp(
			join(tmpdir(), "cex-broker-parquet-test-"),
		);
		try {
			const result = await exportCanonicalOrderBookParquet({
				clickhouseUrl: CLICKHOUSE_URL,
				username: CLICKHOUSE_USERNAME,
				password: CLICKHOUSE_PASSWORD,
				outputDirectory,
				captureBundleIds: ["integration-four-feed-bundle"],
				exchange: "binance",
				tradingPair: "TEST-FOUR-FEED",
				startTimeMs: TEST_EVENT_MS + 500_000,
				endTimeMs: TEST_EVENT_MS + 500_100,
			});
			expect(result.levelRows).toBe(2);
			expect(result.summaryRows).toBe(1);
			for (const path of [result.levelsPath, result.summaryPath]) {
				const bytes = await readFile(path);
				expect(bytes.subarray(0, 4).toString()).toBe("PAR1");
				expect(bytes.subarray(-4).toString()).toBe("PAR1");
			}
		} finally {
			await rm(outputDirectory, { recursive: true, force: true });
		}
	});

	test("orderbook views reflect inserts into orderbook_snapshots", async () => {
		if (!clickhouseAvailable || !client) {
			return;
		}

		const row = {
			source: "broker_write",
			deployment_id: TEST_DEPLOYMENT,
			account_selector: "",
			exchange: "binance",
			asset_type: "spot",
			symbol: "TEST/CH",
			event_time_ms: TEST_EVENT_MS,
			received_time_ms: TEST_EVENT_MS + 1,
			best_bid: 100,
			best_ask: 101,
			bid_size: 1.5,
			ask_size: 2,
			mid: 100.5,
			spread_bps: 99.5,
			depth_limit: 2,
			bid_levels: 2,
			ask_levels: 2,
			bids_price: [100, 99.5],
			bids_size: [1.5, 2],
			asks_price: [101, 101.5],
			asks_size: [2, 1.5],
			sequence: 42,
		};

		await client.insert({
			table: "orderbook_snapshots",
			values: [row],
			format: "JSONEachRow",
		});

		const snapshotCount = await client.query({
			query: `
				SELECT count() AS c
				FROM orderbook_snapshots
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
					AND event_time_ms = {event_time_ms:UInt64}
			`,
			query_params: {
				deployment_id: TEST_DEPLOYMENT,
				event_time_ms: TEST_EVENT_MS,
			},
			format: "JSONEachRow",
		});
		expect(
			Number(((await snapshotCount.json()) as Array<{ c: string }>)[0]?.c),
		).toBe(1);

		const tob = await client.query({
			query: `
				SELECT best_bid, best_ask, mid, spread_bps, sequence
				FROM orderbook_tob
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
					AND event_time_ms = {event_time_ms:UInt64}
			`,
			query_params: {
				deployment_id: TEST_DEPLOYMENT,
				event_time_ms: TEST_EVENT_MS,
			},
			format: "JSONEachRow",
		});
		const tobRow = (await tob.json())[0] as Record<string, unknown>;
		expect(Number(tobRow.best_bid)).toBe(100);
		expect(Number(tobRow.best_ask)).toBe(101);
		expect(Number(tobRow.mid)).toBe(100.5);
		expect(Number(tobRow.sequence)).toBe(42);

		const depth = await client.query({
			query: `
				SELECT depth_limit, bid_levels, ask_levels, bids_price, asks_price
				FROM orderbook_depth
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
					AND event_time_ms = {event_time_ms:UInt64}
			`,
			query_params: {
				deployment_id: TEST_DEPLOYMENT,
				event_time_ms: TEST_EVENT_MS,
			},
			format: "JSONEachRow",
		});
		const depthRow = (await depth.json())[0] as Record<string, unknown>;
		expect(Number(depthRow.depth_limit)).toBe(2);
		expect(Number(depthRow.bid_levels)).toBe(2);
		expect(Number(depthRow.ask_levels)).toBe(2);
		expect(depthRow.bids_price).toEqual([100, 99.5]);
		expect(depthRow.asks_price).toEqual([101, 101.5]);
	});

	test("candles_closed view returns only closed bars", async () => {
		if (!clickhouseAvailable || !client) {
			return;
		}

		const openTimeMs = TEST_EVENT_MS + 60_000;
		await client.insert({
			table: "candles",
			values: [
				{
					source: "broker_write",
					deployment_id: TEST_DEPLOYMENT,
					account_selector: "",
					exchange: "binance",
					asset_type: "spot",
					symbol: "TEST/CH",
					timeframe: "1m",
					open_time_ms: openTimeMs,
					open: 1,
					high: 2,
					low: 0.5,
					close: 1.5,
					volume: 10,
					is_closed: 0,
					broker_version: openTimeMs,
				},
				{
					source: "broker_write",
					deployment_id: TEST_DEPLOYMENT,
					account_selector: "",
					exchange: "binance",
					asset_type: "spot",
					symbol: "TEST/CH",
					timeframe: "1m",
					open_time_ms: openTimeMs + 60_000,
					open: 2,
					high: 3,
					low: 1.5,
					close: 2.5,
					volume: 12,
					is_closed: 1,
					broker_version: openTimeMs + 60_000,
				},
			],
			format: "JSONEachRow",
		});

		const closed = await client.query({
			query: `
				SELECT count() AS c
				FROM candles_closed
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
			`,
			query_params: { deployment_id: TEST_DEPLOYMENT },
			format: "JSONEachRow",
		});
		expect(Number(((await closed.json()) as Array<{ c: string }>)[0]?.c)).toBe(
			1,
		);

		const forming = await client.query({
			query: `
				SELECT count() AS c
				FROM candles FINAL
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
					AND is_closed = 0
			`,
			query_params: { deployment_id: TEST_DEPLOYMENT },
			format: "JSONEachRow",
		});
		expect(Number(((await forming.json()) as Array<{ c: string }>)[0]?.c)).toBe(
			1,
		);
	});

	test("archive forwarder inserts into base tables (not views)", async () => {
		if (!clickhouseAvailable || !client) {
			return;
		}

		const eventMs = TEST_EVENT_MS + 120_000;
		const result = await handleArchiveBatch(createClickHouseInserter(client), {
			source: "broker_write",
			deployment_id: TEST_DEPLOYMENT,
			rows: [
				{
					table: "market_data.orderbook_snapshots",
					row: {
						source: "broker_write",
						deployment_id: TEST_DEPLOYMENT,
						account_selector: "",
						exchange: "binance",
						asset_type: "spot",
						symbol: "TEST/FWD",
						event_time_ms: eventMs,
						received_time_ms: eventMs + 1,
						best_bid: 50,
						best_ask: 51,
						bid_size: 1,
						ask_size: 1,
						mid: 50.5,
						spread_bps: 10,
						depth_limit: 1,
						bid_levels: 1,
						ask_levels: 1,
						bids_price: [50],
						bids_size: [1],
						asks_price: [51],
						asks_size: [1],
					},
				},
			],
		});

		expect(result.failed).toBe(0);
		expect(result.inserted).toBe(1);

		const viaView = await client.query({
			query: `
				SELECT best_bid, best_ask
				FROM orderbook_tob
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/FWD'
					AND event_time_ms = {event_time_ms:UInt64}
			`,
			query_params: {
				deployment_id: TEST_DEPLOYMENT,
				event_time_ms: eventMs,
			},
			format: "JSONEachRow",
		});
		const viewRow = (await viaView.json())[0] as Record<string, unknown>;
		expect(Number(viewRow.best_bid)).toBe(50);
		expect(Number(viewRow.best_ask)).toBe(51);
	});

	test("schema migration adds source_cursor to the existing policy table", async () => {
		if (!clickhouseAvailable || !client) {
			return;
		}

		await client.command({
			query: `
				ALTER TABLE strategy_data.policy_evaluation_events
				DROP COLUMN IF EXISTS source_cursor
			`,
		});
		try {
			await ensureArchiveSchema(client);

			const result = await client.query({
				query: `
					SELECT name
					FROM system.columns
					WHERE database = 'strategy_data'
						AND table = 'policy_evaluation_events'
						AND name = 'source_cursor'
				`,
				format: "JSONEachRow",
			});
			expect(await result.json()).toEqual([{ name: "source_cursor" }]);
		} finally {
			await ensureArchiveSchema(client);
		}
	});

	test("archive forwarder stores policy cursors and control-plane snapshots", async () => {
		if (!clickhouseAvailable || !client) {
			return;
		}

		const eventMs = TEST_EVENT_MS + 180_000;
		const sourceCursor = "block:12345680:log:3";
		const result = await handleArchiveBatch(createClickHouseInserter(client), {
			source: "hb_runtime",
			deployment_id: TEST_DEPLOYMENT,
			rows: [
				{
					table: "strategy_data.policy_evaluation_events",
					row: {
						event_time_ms: eventMs,
						emitted_at_ms: eventMs,
						source: "hb_runtime",
						deployment_id: TEST_DEPLOYMENT,
						schema_version: "1",
						controller_id: "controller-1",
						controller_type: "layer12",
						connector_name: "binance",
						exchange: "binance",
						trading_pair: "BTC-USDT",
						market_id: "market-1",
						run_id: "run-1",
						policy_epoch: "epoch-1",
						fidelity: "live",
						lag_ms: 0,
						fallback_reason: "",
						source_cursor: sourceCursor,
						decision_kind: "quote",
						payload_json: "{}",
					},
				},
				{
					table: "strategy_data.market_identity",
					row: {
						event_time_ms: eventMs + 1,
						emitted_at_ms: eventMs + 1,
						source: "hb_runtime",
						deployment_id: TEST_DEPLOYMENT,
						schema_version: "1",
						controller_id: "controller-1",
						controller_type: "layer12",
						connector_name: "binance",
						exchange: "binance",
						trading_pair: "BTC-USDT",
						market_id: "market-1",
						run_id: "run-1",
						snapshot_reason: "startup",
						source_hash: "identity-hash",
						canonical_core_pool_id: "pool-1",
						payload_json: "{}",
					},
				},
				{
					table: "strategy_data.symbol_mapping",
					row: {
						event_time_ms: eventMs + 2,
						emitted_at_ms: eventMs + 2,
						source: "hb_runtime",
						deployment_id: TEST_DEPLOYMENT,
						schema_version: "1",
						controller_id: "controller-1",
						controller_type: "layer12",
						connector_name: "binance",
						exchange: "binance",
						trading_pair: "BTC-USDT",
						market_id: "market-1",
						run_id: "run-1",
						snapshot_reason: "startup",
						source_hash: "symbol-hash",
						payload_json: "{}",
					},
				},
			],
		});

		expect(result).toMatchObject({ inserted: 3, failed: 0, skipped: 0 });

		const policy = await client.query({
			query: `
				SELECT source_cursor
				FROM strategy_data.policy_evaluation_events
				WHERE deployment_id = {deployment_id:String}
					AND event_time_ms = {event_time_ms:Int64}
			`,
			query_params: {
				deployment_id: TEST_DEPLOYMENT,
				event_time_ms: eventMs,
			},
			format: "JSONEachRow",
		});
		expect(await policy.json()).toEqual([{ source_cursor: sourceCursor }]);

		for (const [table, sourceHash] of [
			["market_identity", "identity-hash"],
			["symbol_mapping", "symbol-hash"],
		] as const) {
			const snapshot = await client.query({
				query: `
					SELECT source_hash
					FROM strategy_data.${table}
					WHERE deployment_id = {deployment_id:String}
				`,
				query_params: { deployment_id: TEST_DEPLOYMENT },
				format: "JSONEachRow",
			});
			expect(await snapshot.json()).toEqual([{ source_hash: sourceHash }]);
		}
	});

	test("strategy v1 tables upgrade additively to the shared v2 identity", async () => {
		if (!clickhouseAvailable || !client) return;
		const tables = [
			"policy_evaluation_events",
			"strategy_policy_snapshots",
			"market_identity",
			"symbol_mapping",
			"inventory_settlement_events",
		] as const;
		for (const table of tables) {
			for (const column of [
				"producer_id",
				"producer_run_id",
				"stream_name",
				"stream_seq",
				"archive_event_id",
			]) {
				await client.command({
					query: `ALTER TABLE strategy_data.${table} DROP COLUMN IF EXISTS ${column}`,
				});
			}
		}

		await ensureArchiveSchema(client);
		const result = await client.query({
			query: `SELECT table, count() AS columns
				FROM system.columns
				WHERE database = 'strategy_data'
				  AND table IN ({tables:Array(String)})
				  AND name IN ({columns:Array(String)})
				GROUP BY table
				ORDER BY table`,
			query_params: {
				tables: [...tables],
				columns: [
					"producer_id",
					"producer_run_id",
					"stream_name",
					"stream_seq",
					"seq",
					"archive_event_id",
				],
			},
			format: "JSONEachRow",
		});
		expect(await result.json()).toEqual(
			[...tables].sort().map((table) => ({ table, columns: "6" })),
		);
	});

	test("strategy schema v2 accepts all five tables and deduplicates stable tokens", async () => {
		if (!clickhouseAvailable || !client) return;
		const eventMs = TEST_EVENT_MS + 240_000;
		const tables = [
			"policy_evaluation_events",
			"strategy_policy_snapshots",
			"market_identity",
			"symbol_mapping",
			"inventory_settlement_events",
		] as const;
		const tableFields: Record<
			(typeof tables)[number],
			Record<string, unknown>
		> = {
			policy_evaluation_events: {
				policy_epoch: "epoch-v2",
				fidelity: "hb_runtime_policy_clock",
				lag_ms: 0,
				fallback_reason: "",
				source_cursor: "block:1:log:0",
				decision_kind: "quote",
			},
			strategy_policy_snapshots: {
				snapshot_reason: "startup",
				policy_epoch: "epoch-v2",
				config_file_path: "controller.yml",
				source_hash: "policy-v2",
			},
			market_identity: {
				snapshot_reason: "startup",
				source_hash: "identity-v2",
				core_pool_id: "pool-v2",
				canonical_core_pool_id: "pool-v2",
			},
			symbol_mapping: {
				snapshot_reason: "startup",
				source_hash: "symbol-v2",
			},
			inventory_settlement_events: {
				event_kind: "inventory_snapshot",
				token: "BTC",
				account: "primary",
				reservation_id: "",
				workflow_state: "observed",
			},
		};
		const inserter = createClickHouseInserter(client);

		for (const [index, table] of tables.entries()) {
			const row = {
				event_time_ms: eventMs + index,
				emitted_at_ms: eventMs + index,
				source: "hb_runtime",
				deployment_id: TEST_DEPLOYMENT,
				schema_version: "2",
				controller_id: "controller-v2",
				controller_type: "layer12",
				connector_name: "binance",
				exchange: "binance",
				trading_pair: "BTC-USDT",
				market_id: "market-v2",
				run_id: "run-v2",
				producer_id: "hb_runtime:test:controller-v2",
				producer_run_id: "run-v2",
				stream_name: `strategy_data.${table}`,
				stream_seq: 1,
				seq: index + 1,
				archive_event_id: `run-v2:${table}:1`,
				payload_json: "{}",
				...tableFields[table],
			};
			const token = `integration-v2-${TEST_DEPLOYMENT}-${table}`;
			await inserter(`strategy_data.${table}`, [row], {
				deduplicationToken: token,
			});
			await inserter(`strategy_data.${table}`, [row], {
				deduplicationToken: token,
			});
		}

		for (const table of tables) {
			const result = await client.query({
				query: `SELECT count() AS count FROM strategy_data.${table}
					WHERE deployment_id = {deployment_id:String} AND run_id = 'run-v2'`,
				query_params: { deployment_id: TEST_DEPLOYMENT },
				format: "JSONEachRow",
			});
			expect(await result.json()).toEqual([{ count: "1" }]);
		}
	});

	test("a market-data batch replayed under its original id lands exactly once", async () => {
		if (!clickhouseAvailable || !client) return;
		// The sender re-posts a whole batch after any table in it fails, so the
		// tables that already landed are inserted a second time. cex_stream_events
		// is the sharp case: plain MergeTree, and no canonical view collapses a
		// duplicate at read time.
		const eventMs = TEST_EVENT_MS + 600_000;
		const context: MarketCaptureContext = {
			source: "broker_read",
			deploymentId: TEST_DEPLOYMENT,
			captureBundleId: "integration-replay-bundle",
			exchange: "binance",
			symbol: "TEST/REPLAY",
			assetType: "spot",
			feed: "TICKER",
			provider: "ccxt:binance",
			sourceMode: "broker_live_stream_v1",
			schemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
			provenanceComplete: true,
		};
		const rawCapture = createRawCapture(context, {
			payload: { eventTimeMs: eventMs, last: 100.5 },
			eventTimeMs: eventMs,
			receivedTimeMs: eventMs + 5,
			scope: "ccxt_normalized_object",
		});
		const batch = {
			source: "broker_read",
			deployment_id: TEST_DEPLOYMENT,
			batch_id: `integration-replay-${TEST_DEPLOYMENT}`,
			rows: [buildCanonicalCexStreamEventRow(context, rawCapture)],
		};

		const first = await handleArchiveBatch(
			createClickHouseInserter(client),
			batch,
		);
		const replay = await handleArchiveBatch(
			createClickHouseInserter(client),
			batch,
		);
		expect(first.failed).toBe(0);
		expect(replay.failed).toBe(0);

		const counted = await client.query({
			query: `SELECT count() AS count FROM market_data.cex_stream_events
				WHERE deployment_id = {deployment_id:String} AND symbol = 'TEST/REPLAY'`,
			query_params: { deployment_id: TEST_DEPLOYMENT },
			format: "JSONEachRow",
		});
		expect(await counted.json()).toEqual([{ count: "1" }]);

		// A different batch carrying the same row is a distinct insert, not a
		// replay: deduplication must not swallow genuinely re-captured data.
		await handleArchiveBatch(createClickHouseInserter(client), {
			...batch,
			batch_id: `${batch.batch_id}-other`,
		});
		const afterDistinctBatch = await client.query({
			query: `SELECT count() AS count FROM market_data.cex_stream_events
				WHERE deployment_id = {deployment_id:String} AND symbol = 'TEST/REPLAY'`,
			query_params: { deployment_id: TEST_DEPLOYMENT },
			format: "JSONEachRow",
		});
		expect(await afterDistinctBatch.json()).toEqual([{ count: "2" }]);
	});
});
