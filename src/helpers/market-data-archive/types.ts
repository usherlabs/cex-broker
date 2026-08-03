import type {
	BrokerArchiveRow,
	BrokerArchiveSource,
} from "../broker-execution-archive/types";
import type { BrokerMarketType } from "../market-type";
import type { NormalizedOrderBookSnapshot } from "../order-book";

export type MarketArchiveTable =
	| "market_data.orderbook_snapshots"
	| "market_data.candles"
	| "market_data.cex_stream_events"
	| "market_data.cex_ticker_events"
	| "market_data.cex_trades"
	| "market_data.cex_ohlcv"
	| "market_data.cex_order_book_levels"
	| "market_data.cex_order_book_depth_summary";

export type CexStreamType =
	| "BALANCE"
	| "ORDERS"
	| "ORDERBOOK"
	| "TRADES"
	| "TICKER"
	| "OHLCV";

export type ParsedOhlcvBar = {
	openTimeMs: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	quoteVolume?: number;
};

export type OhlcvArchiveCandidate = {
	bar: ParsedOhlcvBar;
	isClosed: boolean;
	brokerVersion: number;
};

export type MarketArchiveContext = {
	source?: BrokerArchiveSource;
	exchange: string;
	symbol: string;
	assetType: BrokerMarketType;
	timeframe?: string;
	accountSelector?: string;
	deploymentId: string;
};

export type CaptureFeed = "ORDERBOOK" | "TICKER" | "TRADES" | "OHLCV";
export type CaptureSourceMode =
	| "broker_live_stream_v1"
	| "broker_live_sampling_v1"
	| "broker_current_snapshot_v1"
	| "broker_bootstrap_fetch_v1"
	| "external_ccxt_fallback_v1"
	| "external_hummingbot_fallback_v1"
	| "legacy_migration_v1";
export type RawCaptureScope =
	| "ccxt_normalized_object"
	| "broker_visible_payload"
	| "exchange_wire_frame";

export type MarketCaptureContext = MarketArchiveContext & {
	source: BrokerArchiveSource;
	captureBundleId: string;
	feed: CaptureFeed;
	provider: string;
	sourceMode: CaptureSourceMode;
	schemaVersion: string;
	checksumAlgorithm: string;
	provenanceComplete: boolean;
};

export type RawCapture = {
	rawCaptureId: string;
	rawCaptureScope: RawCaptureScope;
	rawChecksum: string;
	redactedPayload: unknown;
	eventTimeMs: number;
	receivedTimeMs: number;
	checksumAlgorithm: string;
};

export type OrderbookArchiveInput = MarketArchiveContext & {
	snapshot: NormalizedOrderBookSnapshot;
};

/** @deprecated Use OrderbookArchiveInput */
export type OrderbookSnapshotArchiveInput = OrderbookArchiveInput;

/** @deprecated Use OrderbookArchiveInput */
export type OrderbookTobArchiveInput = OrderbookArchiveInput;

export type OhlcvArchiveInput = MarketArchiveContext & {
	payload: unknown;
	receivedTimestamp: number;
	timeframe: string;
	sourceMode?: "broker_live_stream_v1" | "broker_bootstrap_fetch_v1";
};

export type TradesArchiveInput = MarketArchiveContext & {
	payload: unknown;
	receivedTimestamp: number;
};

export type TickerArchiveInput = MarketArchiveContext & {
	payload: unknown;
	receivedTimestamp: number;
};

export type CexStreamArchiveInput = MarketArchiveContext & {
	streamType: CexStreamType;
	payload: unknown;
	receivedTimestamp: number;
	eventTimeMs?: number;
};

const MARKET_ARCHIVE_TABLES = new Set<string>([
	"market_data.orderbook_snapshots",
	"market_data.candles",
	"market_data.cex_stream_events",
	"market_data.cex_ticker_events",
	"market_data.cex_trades",
	"market_data.cex_ohlcv",
	"market_data.cex_order_book_levels",
	"market_data.cex_order_book_depth_summary",
]);

export function isMarketArchiveTable(
	table: string,
): table is MarketArchiveTable {
	return MARKET_ARCHIVE_TABLES.has(table);
}

export type { BrokerArchiveRow };
