import { describe, expect, test } from "bun:test";
import {
	buildCanonicalOrderBookRows,
	OrderBookValidationError,
} from "../src/helpers/market-data-archive/canonical-orderbook";
import {
	createMarketCaptureContext,
	validateExternalFallbackContext,
	validateProductionCollectorArchive,
} from "../src/helpers/market-data-archive/capture-context";
import {
	ARCHIVE_SOURCES,
	CAPTURE_FEEDS,
	CHECKSUM_ALGORITHM,
	CONSTRUCTION_MODES,
	canonicalDecimal,
	canonicalSerialize,
	createRawCapture,
	GAP_POLICIES,
	MARKET_CAPTURE_SCHEMA_VERSION,
	RAW_CAPTURE_SCOPES,
	SOURCE_MODES,
	sha256Canonical,
} from "../src/helpers/market-data-archive/capture-contract";
import {
	buildLegacyOhlcvMigrationRow,
	buildLegacyOrderBookMigrationRows,
} from "../src/helpers/market-data-archive/legacy-migration";
import {
	buildCanonicalCexStreamEventRow,
	buildCanonicalOhlcvRow,
	buildCanonicalTickerEventRow,
	buildCanonicalTradeRow,
} from "../src/helpers/market-data-archive/rows";
import type { MarketCaptureContext } from "../src/helpers/market-data-archive/types";
import type { NormalizedOrderBookSnapshot } from "../src/helpers/order-book";

const captureContext: MarketCaptureContext = {
	source: "broker_read",
	deploymentId: "collector-eu-1",
	captureBundleId: "bundle-2026-08-03",
	exchange: "binance",
	symbol: "BTC/USDT",
	assetType: "spot",
	feed: "ORDERBOOK",
	provider: "ccxt:binance",
	sourceMode: "broker_live_sampling_v1",
	schemaVersion: MARKET_CAPTURE_SCHEMA_VERSION,
	checksumAlgorithm: CHECKSUM_ALGORITHM,
	provenanceComplete: true,
};

function snapshot(
	overrides: Partial<NormalizedOrderBookSnapshot> = {},
): NormalizedOrderBookSnapshot {
	return {
		bids: [
			[100, 1],
			[99, 2],
		],
		asks: [
			[101, 3],
			[102, 4],
		],
		timestamp: 1_700_000_000_000,
		receivedTimestamp: 1_700_000_000_125,
		exchange: "binance",
		symbol: "BTC/USDT",
		depthLimit: 2,
		sequence: 42,
		...overrides,
	};
}

describe("canonical market capture contract", () => {
	test("canonical rows on legacy tables retain every legacy archive field", () => {
		const context = {
			...captureContext,
			feed: "TICKER" as const,
			accountSelector: "spot:primary",
		};
		const payload = {
			timestamp: 1_700_000_000_000,
			last: 100.5,
			bid: 100,
			ask: 101,
		};
		const raw = createRawCapture(context, {
			payload,
			eventTimeMs: payload.timestamp,
			receivedTimeMs: 1_700_000_000_123,
			scope: "ccxt_normalized_object",
		});
		const stream = buildCanonicalCexStreamEventRow(context, raw);
		const ticker = buildCanonicalTickerEventRow(context, raw, {
			eventTimeMs: payload.timestamp,
			last: payload.last,
			bid: payload.bid,
			ask: payload.ask,
		});
		for (const row of [stream.row, ticker.row]) {
			expect(row.account_selector).toBe("spot:primary");
			expect(row.broker_observed_timestamp).toBe("2023-11-14T22:13:20.123Z");
		}
		expect(ticker.row.payload_json).toBe(JSON.stringify(payload));
	});

	test("canonical legacy Decimal(18,8) fields are normalized before checksumming", () => {
		const tickerContext = {
			...captureContext,
			feed: "TICKER" as const,
		};
		const tickerRaw = createRawCapture(tickerContext, {
			payload: { percentage: 0.2650375939849624 },
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		const ticker = buildCanonicalTickerEventRow(tickerContext, tickerRaw, {
			eventTimeMs: 1_700_000_000_000,
			percentage: 0.2650375939849624,
		});
		expect(ticker.row.percentage).toBe(0.26503759);

		const tradeContext = { ...captureContext, feed: "TRADES" as const };
		const tradeRaw = createRawCapture(tradeContext, {
			payload: [{ id: "trade-precise", price: 100.123456789 }],
			eventTimeMs: 1_700_000_000_001,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		const trade = buildCanonicalTradeRow(tradeContext, tradeRaw, {
			tradeId: "trade-precise",
			eventTimeMs: 1_700_000_000_001,
			price: 100.123456789,
			amount: 0.123456789,
			cost: 12.345678999,
		});
		expect(trade.row).toMatchObject({
			price: 100.12345679,
			amount: 0.12345679,
			cost: 12.345679,
		});
	});

	test("production contexts require a deployment-owned capture bundle", () => {
		expect(() =>
			createMarketCaptureContext({
				source: "broker_read",
				deploymentId: "collector-a",
				exchange: "binance",
				symbol: "BTC/USDT",
				assetType: "spot",
				feed: "TRADES",
				sourceMode: "broker_live_stream_v1",
				environment: "production",
			}),
		).toThrow("capture_bundle_id");
		const development = createMarketCaptureContext({
			source: "broker_write",
			deploymentId: "local-a",
			exchange: "binance",
			symbol: "BTC/USDT",
			assetType: "spot",
			feed: "TRADES",
			sourceMode: "broker_live_stream_v1",
			environment: "development",
		});
		expect(development.captureBundleId).toBe("development:local-a");
	});

	test("FIET-901 production collector requires broker_read", () => {
		expect(() =>
			validateProductionCollectorArchive({
				source: "broker_write",
				captureBundleId: "bundle-a",
			}),
		).toThrow("broker_read");
		expect(() =>
			validateProductionCollectorArchive({
				source: "broker_read",
				captureBundleId: "bundle-a",
			}),
		).not.toThrow();
	});

	test("external fallback rows cannot cross venue or omit their reason", () => {
		expect(() =>
			validateExternalFallbackContext({
				configuredExchange: "binance",
				configuredSymbol: "BTC/USDT",
				rowExchange: "kraken",
				rowSymbol: "BTC/USDT",
				provider: "hummingbot:kraken",
				sourceMode: "external_hummingbot_fallback_v1",
				fallbackReason: "primary feed unavailable",
			}),
		).toThrow("cross-venue");
		expect(() =>
			validateExternalFallbackContext({
				configuredExchange: "binance",
				configuredSymbol: "BTC/USDT",
				rowExchange: "binance",
				rowSymbol: "BTC/USDT",
				provider: "ccxt:binance",
				sourceMode: "external_ccxt_fallback_v1",
				fallbackReason: "",
			}),
		).toThrow("fallback reason");
	});

	test("uses closed, versioned registries", () => {
		expect(ARCHIVE_SOURCES).toEqual(["broker_read", "broker_write"]);
		expect(CAPTURE_FEEDS).toEqual(["ORDERBOOK", "TICKER", "TRADES", "OHLCV"]);
		expect(SOURCE_MODES).toContain("legacy_migration_v1");
		expect(CONSTRUCTION_MODES).toContain("sampled_top_n_snapshot");
		expect(GAP_POLICIES).toContain("record_gap");
		expect(RAW_CAPTURE_SCOPES).toContain("ccxt_normalized_object");
	});

	test("canonical serialization sorts keys, normalizes numbers, and omits undefined", () => {
		expect(
			canonicalSerialize({ z: -0, b: 1e-7, omitted: undefined, a: [2, 1.5] }),
		).toBe('{"a":[2,1.5],"b":0.0000001,"z":0}');
		expect(canonicalDecimal(1e-7)).toBe("0.0000001");
		expect(() => canonicalSerialize({ bad: Number.NaN })).toThrow("finite");
	});

	test("checksums are deterministic and exclude checksum fields", () => {
		const left = sha256Canonical({
			b: 2,
			normalized_row_checksum: "old-a",
			a: 1,
		});
		const right = sha256Canonical({
			a: 1,
			b: 2,
			normalized_row_checksum: "old-b",
		});
		expect(left).toBe(right);
		expect(left).toHaveLength(64);
	});

	test("raw captures redact secrets and reproduce identity", () => {
		const first = createRawCapture(captureContext, {
			payload: { apiSecret: "do-not-retain", bids: [[100, 1]] },
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		const retried = createRawCapture(captureContext, {
			payload: { bids: [[100, 1]], apiSecret: "different-secret" },
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});

		expect(JSON.stringify(first.redactedPayload)).not.toContain(
			"do-not-retain",
		);
		expect(first.rawCaptureId).toBe(retried.rawCaptureId);
		expect(first.rawChecksum).toBe(retried.rawChecksum);
		const changedEvidence = createRawCapture(captureContext, {
			payload: { bids: [[99, 1]] },
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		expect(changedEvidence.rawCaptureId).not.toBe(first.rawCaptureId);
	});

	test("canonical raw, ticker, trade, and OHLCV rows share capture linkage", () => {
		const tickerContext = { ...captureContext, feed: "TICKER" as const };
		const raw = createRawCapture(tickerContext, {
			payload: { last: 100, bid: 99, ask: 101 },
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		const stream = buildCanonicalCexStreamEventRow(tickerContext, raw);
		const ticker = buildCanonicalTickerEventRow(tickerContext, raw, {
			eventTimeMs: 1_700_000_000_000,
			last: 100,
			bid: 99,
			ask: 101,
		});
		expect(stream.row.raw_capture_id).toBe(raw.rawCaptureId);
		expect(ticker.row.raw_capture_id).toBe(raw.rawCaptureId);
		expect(String(stream.row.normalized_row_checksum)).toHaveLength(64);
		expect(String(ticker.row.normalized_row_checksum)).toHaveLength(64);

		const tradeContext = { ...captureContext, feed: "TRADES" as const };
		const tradeRaw = createRawCapture(tradeContext, {
			payload: [{ id: "trade-1", price: 100, amount: 0.5 }],
			eventTimeMs: 1_700_000_000_001,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		const trade = buildCanonicalTradeRow(tradeContext, tradeRaw, {
			tradeId: "trade-1",
			eventTimeMs: 1_700_000_000_001,
			side: "buy",
			price: 100,
			amount: 0.5,
		});
		expect(trade.table).toBe("market_data.cex_trades");

		const ohlcvContext = {
			...captureContext,
			feed: "OHLCV" as const,
			sourceMode: "broker_bootstrap_fetch_v1" as const,
			timeframe: "1m",
		};
		const ohlcvRaw = createRawCapture(ohlcvContext, {
			payload: [[1_700_000_000_000, 1, 2, 0.5, 1.5, 10]],
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		const ohlcv = buildCanonicalOhlcvRow({
			context: ohlcvContext,
			rawCapture: ohlcvRaw,
			bar: {
				openTimeMs: 1_700_000_000_000,
				open: 1,
				high: 2,
				low: 0.5,
				close: 1.5,
				volume: 10,
			},
			isClosed: true,
			brokerVersion: 1_700_000_000_125,
		});
		expect(ohlcv.table).toBe("market_data.cex_ohlcv");
		expect(ohlcv.row).toMatchObject({
			source_mode: "broker_bootstrap_fetch_v1",
			is_closed: 1,
			raw_capture_id: ohlcvRaw.rawCaptureId,
		});
	});

	test("OHLCV live updates retain one replacement key while changing evidence versions", () => {
		const context = {
			...captureContext,
			feed: "OHLCV" as const,
			sourceMode: "broker_live_stream_v1" as const,
			timeframe: "1m",
		};
		const formingBar = {
			openTimeMs: 1_700_000_000_000,
			open: 100,
			high: 101,
			low: 99,
			close: 100.5,
			volume: 10,
		};
		const formingRaw = createRawCapture(context, {
			payload: formingBar,
			eventTimeMs: formingBar.openTimeMs,
			receivedTimeMs: 1_700_000_030_000,
			scope: "ccxt_normalized_object",
		});
		const forming = buildCanonicalOhlcvRow({
			context,
			rawCapture: formingRaw,
			bar: formingBar,
			isClosed: false,
			brokerVersion: 1_700_000_030_000,
		});
		const closedBar = { ...formingBar, high: 102, close: 101, volume: 14 };
		const closedRaw = createRawCapture(context, {
			payload: closedBar,
			eventTimeMs: closedBar.openTimeMs,
			receivedTimeMs: 1_700_000_060_001,
			scope: "ccxt_normalized_object",
		});
		const closed = buildCanonicalOhlcvRow({
			context,
			rawCapture: closedRaw,
			bar: closedBar,
			isClosed: true,
			brokerVersion: 1_700_000_060_001,
		});

		for (const logicalKey of [
			"exchange",
			"trading_pair",
			"timeframe",
			"open_time_ms",
			"schema_version",
		]) {
			expect(closed.row[logicalKey]).toBe(forming.row[logicalKey]);
		}
		expect(forming.row.source_mode).toBe("broker_live_stream_v1");
		expect(forming.row.is_closed).toBe(0);
		expect(closed.row.is_closed).toBe(1);
		expect(Number(closed.row.broker_version)).toBeGreaterThan(
			Number(forming.row.broker_version),
		);
		expect(closed.row.raw_capture_id).not.toBe(forming.row.raw_capture_id);
		expect(closed.row.normalized_row_checksum).not.toBe(
			forming.row.normalized_row_checksum,
		);
	});
});

describe("canonical order-book normalization", () => {
	test("emits one checksummed row per retained level and one summary", () => {
		const raw = createRawCapture(captureContext, {
			payload: snapshot(),
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		const result = buildCanonicalOrderBookRows({
			context: captureContext,
			snapshot: snapshot(),
			rawCapture: raw,
			depthLimit: 2,
			measurementBandsBps: [100, 50, 100],
		});

		expect(result.levels).toHaveLength(4);
		expect(result.levels[0]?.table).toBe("market_data.cex_order_book_levels");
		expect(result.levels.map((entry) => entry.row.side)).toEqual([
			"bid",
			"bid",
			"ask",
			"ask",
		]);
		expect(result.levels[0]?.row).toMatchObject({
			capture_bundle_id: "bundle-2026-08-03",
			raw_capture_id: raw.rawCaptureId,
			construction_mode: "sampled_top_n_snapshot",
			gap_policy: "record_gap",
			level_index: 0,
			price: 100,
			amount: 1,
			notional: 100,
		});
		expect(result.summary.table).toBe(
			"market_data.cex_order_book_depth_summary",
		);
		expect(result.summary.row.measurement_bands_bps).toEqual([50, 100]);
		expect(result.summary.row.bid_depth_by_band).toEqual([1, 3]);
		expect(result.summary.row.ask_depth_by_band).toEqual([3, 7]);
		expect(String(result.summary.row.normalized_row_checksum)).toHaveLength(64);

		const retried = buildCanonicalOrderBookRows({
			context: captureContext,
			snapshot: snapshot({ receivedTimestamp: 1_700_000_009_999 }),
			rawCapture: raw,
			depthLimit: 2,
			measurementBandsBps: [50, 100],
		});
		expect(retried.snapshotId).toBe(result.snapshotId);
	});

	test.each([
		{ name: "missing side", overrides: { asks: [] } },
		{ name: "zero amount", overrides: { bids: [[100, 0]] } },
		{
			name: "non-monotonic bids",
			overrides: {
				bids: [
					[99, 1],
					[100, 1],
				],
			},
		},
		{ name: "locked book", overrides: { bids: [[101, 1]] } },
		{ name: "invalid timestamp", overrides: { timestamp: -1 } },
	])("rejects the whole $name snapshot", ({ overrides }) => {
		const book = snapshot(overrides as Partial<NormalizedOrderBookSnapshot>);
		const raw = createRawCapture(captureContext, {
			payload: book,
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		expect(() =>
			buildCanonicalOrderBookRows({
				context: captureContext,
				snapshot: book,
				rawCapture: raw,
				depthLimit: 2,
			}),
		).toThrow(OrderBookValidationError);
	});

	test("never emits exact L2 without continuity proof", () => {
		const raw = createRawCapture(captureContext, {
			payload: snapshot(),
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_125,
			scope: "ccxt_normalized_object",
		});
		expect(() =>
			buildCanonicalOrderBookRows({
				context: captureContext,
				snapshot: snapshot(),
				rawCapture: raw,
				depthLimit: 2,
				constructionMode: "exact_l2_reconstruction",
			}),
		).toThrow("continuity proof");
	});
});

describe("legacy canonical migration", () => {
	test("leaves unavailable provenance null and is deterministic on rerun", () => {
		const legacy = {
			source: "broker_write" as const,
			deployment_id: "legacy-deploy",
			exchange: "binance",
			asset_type: "spot" as const,
			symbol: "BTC/USDT",
			event_time_ms: 1_700_000_000_000,
			received_time_ms: 1_700_000_000_010,
			depth_limit: 2,
			bids_price: [100, 99],
			bids_size: [1, 2],
			asks_price: [101, 102],
			asks_size: [3, 4],
			sequence: 42,
		};
		const first = buildLegacyOrderBookMigrationRows(legacy);
		const second = buildLegacyOrderBookMigrationRows(legacy);
		expect(second).toEqual(first);
		expect(first).toHaveLength(5);
		for (const { row } of first) {
			expect(row).toMatchObject({
				capture_bundle_id: null,
				raw_capture_id: null,
				raw_capture_scope: null,
				raw_checksum: null,
				provenance_complete: 0,
				source_mode: "legacy_migration_v1",
			});
		}
	});

	test("migrates candles into cex_ohlcv without invented raw evidence", () => {
		const migrated = buildLegacyOhlcvMigrationRow({
			deployment_id: "legacy-deploy",
			exchange: "binance",
			asset_type: "spot",
			symbol: "BTC/USDT",
			timeframe: "1m",
			open_time_ms: 1_700_000_000_000,
			open: 100,
			high: 102,
			low: 99,
			close: 101,
			volume: 12,
			is_closed: 1,
			broker_version: 7,
		});
		expect(migrated.table).toBe("market_data.cex_ohlcv");
		expect(migrated.row).toMatchObject({
			capture_bundle_id: null,
			raw_capture_id: null,
			raw_checksum: null,
			provenance_complete: 0,
			source_mode: "legacy_migration_v1",
			is_closed: 1,
		});
	});
});
