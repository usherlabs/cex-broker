import { redactStreamPayload } from "../broker-execution-archive/redact";
import { buildCommonArchiveTags } from "../broker-execution-archive/rows";
import type { BrokerArchiveRow } from "../broker-execution-archive/types";
import {
	canonicalSerialize,
	captureCoreFields,
	sha256Canonical,
} from "./capture-contract";
import {
	getOrderbookArchiveDepthLimit,
	splitOrderBookSide,
} from "./orderbook-depth";
import type { ParsedTicker, ParsedTrade } from "./parse-stream";
import type {
	CexStreamArchiveInput,
	MarketArchiveContext,
	MarketCaptureContext,
	OrderbookArchiveInput,
	ParsedOhlcvBar,
	RawCapture,
	TickerArchiveInput,
	TradesArchiveInput,
} from "./types";

function compactUndefined(
	record: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}

function withNormalizedChecksum(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const compact = compactUndefined(record);
	return {
		...compact,
		normalized_row_checksum: sha256Canonical(compact),
	};
}

export function buildCanonicalCexStreamEventRow(
	context: MarketCaptureContext,
	rawCapture: RawCapture,
): BrokerArchiveRow {
	const row = withNormalizedChecksum({
		...captureCoreFields(context, rawCapture),
		stream_type: context.feed,
		event_time_ms: rawCapture.eventTimeMs,
		payload_encoding: "canonical_json_v1",
		payload_json: canonicalSerialize(rawCapture.redactedPayload),
	});
	return { table: "market_data.cex_stream_events", row };
}

export function buildCanonicalTickerEventRow(
	context: MarketCaptureContext,
	rawCapture: RawCapture,
	ticker: ParsedTicker,
): BrokerArchiveRow {
	if (context.feed !== "TICKER") {
		throw new Error("Ticker row requires a TICKER capture context");
	}
	const row = withNormalizedChecksum({
		...captureCoreFields(context, rawCapture),
		source_time_ms: ticker.eventTimeMs,
		event_time_ms: ticker.eventTimeMs,
		last: ticker.last,
		bid: ticker.bid,
		ask: ticker.ask,
		high: ticker.high,
		low: ticker.low,
		open: ticker.open,
		close: ticker.close,
		base_volume: ticker.baseVolume,
		quote_volume: ticker.quoteVolume,
		change: ticker.change,
		percentage: ticker.percentage,
	});
	return { table: "market_data.cex_ticker_events", row };
}

export function buildCanonicalTradeRow(
	context: MarketCaptureContext,
	rawCapture: RawCapture,
	trade: ParsedTrade,
): BrokerArchiveRow {
	if (context.feed !== "TRADES") {
		throw new Error("Trade row requires a TRADES capture context");
	}
	const row = withNormalizedChecksum({
		...captureCoreFields(context, rawCapture),
		source_time_ms: trade.eventTimeMs,
		trade_id: trade.tradeId,
		event_time_ms: trade.eventTimeMs,
		side: trade.side,
		price: trade.price,
		amount: trade.amount,
		cost: trade.cost,
		taker_or_maker: trade.takerOrMaker,
	});
	return { table: "market_data.cex_trades", row };
}

export function buildCanonicalOhlcvRow(input: {
	context: MarketCaptureContext;
	rawCapture: RawCapture;
	bar: ParsedOhlcvBar;
	isClosed: boolean;
	brokerVersion: number;
}): BrokerArchiveRow {
	if (input.context.feed !== "OHLCV") {
		throw new Error("OHLCV row requires an OHLCV capture context");
	}
	const row = withNormalizedChecksum({
		...captureCoreFields(input.context, input.rawCapture),
		source_time_ms: input.bar.openTimeMs,
		timeframe: input.context.timeframe ?? "1m",
		open_time_ms: input.bar.openTimeMs,
		open: input.bar.open,
		high: input.bar.high,
		low: input.bar.low,
		close: input.bar.close,
		volume: input.bar.volume,
		quote_volume: input.bar.quoteVolume,
		is_closed: input.isClosed ? 1 : 0,
		broker_version: input.brokerVersion,
	});
	return { table: "market_data.cex_ohlcv", row };
}

function scalarTimestampMs(value: number | string | boolean | null): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		if (/^\d+$/.test(value)) {
			const numeric = Number.parseInt(value, 10);
			if (Number.isFinite(numeric)) {
				return numeric;
			}
		}
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return Date.now();
}

function parseSequence(
	value: number | string | boolean | undefined,
): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && /^\d+$/.test(value)) {
		return Number.parseInt(value, 10);
	}
	return undefined;
}

function topOfBookLevel(
	levels: number[][],
): { price: number; size: number } | null {
	const level = levels[0];
	if (!level || level.length < 2) {
		return null;
	}
	const price = level[0];
	const size = level[1];
	if (
		price === undefined ||
		size === undefined ||
		!Number.isFinite(price) ||
		!Number.isFinite(size)
	) {
		return null;
	}
	return { price, size };
}

function computeSpreadBps(bestBid: number, bestAsk: number): number {
	if (bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) {
		return 0;
	}
	const mid = (bestBid + bestAsk) / 2;
	if (mid <= 0) {
		return 0;
	}
	return ((bestAsk - bestBid) / mid) * 10_000;
}

function buildOrderbookArchiveTags(
	input: OrderbookArchiveInput,
	receivedTimeMs: number,
) {
	return buildCommonArchiveTags({
		source: input.source,
		deploymentId: input.deploymentId,
		accountSelector: input.accountSelector,
		exchange: input.exchange,
		symbol: input.symbol,
		brokerObservedTimestamp: new Date(receivedTimeMs).toISOString(),
	});
}

export function buildOrderbookSnapshotRow(
	input: OrderbookArchiveInput,
): BrokerArchiveRow | null {
	const bid = topOfBookLevel(input.snapshot.bids);
	const ask = topOfBookLevel(input.snapshot.asks);
	if (!bid || !ask) {
		return null;
	}

	const archiveDepthLimit = getOrderbookArchiveDepthLimit();
	const bids = splitOrderBookSide(input.snapshot.bids, archiveDepthLimit);
	const asks = splitOrderBookSide(input.snapshot.asks, archiveDepthLimit);
	if (bids.prices.length === 0 || asks.prices.length === 0) {
		return null;
	}

	const eventTimeMs = scalarTimestampMs(input.snapshot.timestamp);
	const receivedTimeMs = input.snapshot.receivedTimestamp;
	const mid = (bid.price + ask.price) / 2;
	const sequence = parseSequence(input.snapshot.sequence);

	return {
		table: "market_data.orderbook_snapshots",
		row: compactUndefined({
			...buildOrderbookArchiveTags(input, receivedTimeMs),
			asset_type: input.assetType,
			event_time_ms: eventTimeMs,
			received_time_ms: receivedTimeMs,
			best_bid: bid.price,
			best_ask: ask.price,
			bid_size: bid.size,
			ask_size: ask.size,
			mid,
			spread_bps: computeSpreadBps(bid.price, ask.price),
			depth_limit: archiveDepthLimit,
			bid_levels: bids.prices.length,
			ask_levels: asks.prices.length,
			bids_price: bids.prices,
			bids_size: bids.sizes,
			asks_price: asks.prices,
			asks_size: asks.sizes,
			sequence,
		}),
	};
}

/** @deprecated Use buildOrderbookSnapshotRow */
export const buildOrderbookTobRow = buildOrderbookSnapshotRow;

/** @deprecated Use buildOrderbookSnapshotRow */
export const buildOrderbookDepthRow = buildOrderbookSnapshotRow;

export function buildCandleRow(input: {
	context: MarketArchiveContext;
	bar: ParsedOhlcvBar;
	isClosed: boolean;
	brokerVersion: number;
	receivedTimestamp: number;
}): BrokerArchiveRow {
	const { context, bar, isClosed, brokerVersion, receivedTimestamp } = input;
	const tags = buildCommonArchiveTags({
		source: context.source,
		deploymentId: context.deploymentId,
		accountSelector: context.accountSelector,
		exchange: context.exchange,
		symbol: context.symbol,
		brokerObservedTimestamp: new Date(receivedTimestamp).toISOString(),
	});

	return {
		table: "market_data.candles",
		row: compactUndefined({
			...tags,
			asset_type: context.assetType,
			timeframe: context.timeframe ?? "1m",
			open_time_ms: bar.openTimeMs,
			open: bar.open,
			high: bar.high,
			low: bar.low,
			close: bar.close,
			volume: bar.volume,
			quote_volume: bar.quoteVolume,
			is_closed: isClosed ? 1 : 0,
			broker_version: brokerVersion,
		}),
	};
}

export function buildCexStreamEventRow(
	input: CexStreamArchiveInput,
): BrokerArchiveRow {
	const receivedTimeMs = input.receivedTimestamp;
	const redactedPayload = redactStreamPayload(input.payload);
	const tags = buildCommonArchiveTags({
		source: input.source,
		deploymentId: input.deploymentId,
		accountSelector: input.accountSelector,
		exchange: input.exchange,
		symbol: input.symbol,
		brokerObservedTimestamp: new Date(receivedTimeMs).toISOString(),
	});

	return {
		table: "market_data.cex_stream_events",
		row: compactUndefined({
			...tags,
			asset_type: input.assetType,
			stream_type: input.streamType,
			event_time_ms: input.eventTimeMs ?? receivedTimeMs,
			received_time_ms: receivedTimeMs,
			payload_json: JSON.stringify(redactedPayload),
		}),
	};
}

export function buildCexTickerEventRow(
	input: TickerArchiveInput,
	ticker: ParsedTicker,
): BrokerArchiveRow {
	const receivedTimeMs = input.receivedTimestamp;
	const tags = buildCommonArchiveTags({
		source: input.source,
		deploymentId: input.deploymentId,
		accountSelector: input.accountSelector,
		exchange: input.exchange,
		symbol: input.symbol,
		brokerObservedTimestamp: new Date(receivedTimeMs).toISOString(),
	});

	return {
		table: "market_data.cex_ticker_events",
		row: compactUndefined({
			...tags,
			asset_type: input.assetType,
			event_time_ms: ticker.eventTimeMs,
			received_time_ms: receivedTimeMs,
			last: ticker.last,
			bid: ticker.bid,
			ask: ticker.ask,
			high: ticker.high,
			low: ticker.low,
			open: ticker.open,
			close: ticker.close,
			base_volume: ticker.baseVolume,
			quote_volume: ticker.quoteVolume,
			change: ticker.change,
			percentage: ticker.percentage,
			payload_json: JSON.stringify(redactStreamPayload(input.payload)),
		}),
	};
}

export function buildCexTradeRow(
	input: TradesArchiveInput,
	trade: ParsedTrade,
): BrokerArchiveRow {
	const receivedTimeMs = input.receivedTimestamp;
	const tags = buildCommonArchiveTags({
		source: input.source,
		deploymentId: input.deploymentId,
		accountSelector: input.accountSelector,
		exchange: input.exchange,
		symbol: input.symbol,
		brokerObservedTimestamp: new Date(receivedTimeMs).toISOString(),
	});

	return {
		table: "market_data.cex_trades",
		row: compactUndefined({
			...tags,
			asset_type: input.assetType,
			trade_id: trade.tradeId,
			event_time_ms: trade.eventTimeMs,
			received_time_ms: receivedTimeMs,
			side: trade.side,
			price: trade.price,
			amount: trade.amount,
			cost: trade.cost,
			taker_or_maker: trade.takerOrMaker,
		}),
	};
}
