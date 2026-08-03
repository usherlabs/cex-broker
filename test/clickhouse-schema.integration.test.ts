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
import { buildCanonicalOrderBookRows } from "../src/helpers/market-data-archive/canonical-orderbook";
import { createRawCapture } from "../src/helpers/market-data-archive/capture-contract";
import { buildLegacyOhlcvMigrationRow } from "../src/helpers/market-data-archive/legacy-migration";
import {
	buildCanonicalCexStreamEventRow,
	buildCanonicalOhlcvRow,
	buildCanonicalTickerEventRow,
	buildCanonicalTradeRow,
} from "../src/helpers/market-data-archive/rows";
import type { MarketCaptureContext } from "../src/helpers/market-data-archive/types";

const CLICKHOUSE_URL =
	process.env.CLICKHOUSE_TEST_URL?.trim() ||
	`http://${process.env.CLICKHOUSE_HOST?.trim() || "localhost"}:${process.env.CLICKHOUSE_PORT?.trim() || "18123"}`;

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

async function probeClickHouse(): Promise<boolean> {
	const probe = createClient({
		url: CLICKHOUSE_URL,
		database: "market_data",
	});
	try {
		const result = await probe.query({
			query: "SELECT 1 AS ok",
			format: "JSONEachRow",
		});
		const rows = (await result.json()) as Array<{ ok: number }>;
		return rows[0]?.ok === 1;
	} catch {
		return false;
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
		"market_identity",
		"symbol_mapping",
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
		clickhouseAvailable = await probeClickHouse();
		if (!clickhouseAvailable) {
			return;
		}
		client = createClient({
			url: CLICKHOUSE_URL,
			database: "market_data",
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
		expect(await tableEngine("cex_order_book_levels_canonical")).toBe("View");
		expect(await tableEngine("cex_order_book_levels_conflicts")).toBe("View");
		expect(await tableEngine("cex_ohlcv")).toBe("ReplacingMergeTree");
		expect(await tableEngine("cex_ohlcv_closed")).toBe("View");
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
});
