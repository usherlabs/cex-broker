import type { BrokerMarketType } from "../market-type";
import type { NormalizedOrderBookSnapshot } from "../order-book";
import type { BrokerArchiveRow } from "../broker-execution-archive/types";

export type MarketArchiveTable =
	| "market_data.orderbook_snapshots"
	| "market_data.candles"
	| "market_data.cex_stream_events"
	| "market_data.cex_ticker_events"
	| "market_data.cex_trades";

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
	exchange: string;
	symbol: string;
	assetType: BrokerMarketType;
	timeframe?: string;
	accountSelector?: string;
	deploymentId: string;
};

export type OrderbookSnapshotArchiveInput = MarketArchiveContext & {
	snapshot: NormalizedOrderBookSnapshot;
};

/** @deprecated Use OrderbookSnapshotArchiveInput */
export type OrderbookTobArchiveInput = OrderbookSnapshotArchiveInput;

export type OhlcvArchiveInput = MarketArchiveContext & {
	payload: unknown;
	receivedTimestamp: number;
	timeframe: string;
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
]);

export function isMarketArchiveTable(
	table: string,
): table is MarketArchiveTable {
	return MARKET_ARCHIVE_TABLES.has(table);
}

export type { BrokerArchiveRow };
