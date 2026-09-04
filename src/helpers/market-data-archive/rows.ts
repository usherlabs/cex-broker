import { redactStreamPayload } from "../broker-execution-archive/redact";
import { buildCommonArchiveTags } from "../broker-execution-archive/rows";
import type { BrokerArchiveRow } from "../broker-execution-archive/types";
import {
	canonicalSerialize,
	captureCoreFields,
	sha256Canonical,
} from "./capture-contract";
import type { ParsedTicker, ParsedTrade } from "./parse-stream";
import type {
	CexStreamArchiveInput,
	MarketCaptureContext,
	ParsedOhlcvBar,
	RawCapture,
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

function legacyMarketFields(
	context: MarketCaptureContext,
	rawCapture: RawCapture,
): Record<string, unknown> {
	return {
		account_selector: context.accountSelector,
		broker_observed_timestamp: new Date(
			rawCapture.receivedTimeMs,
		).toISOString(),
	};
}

/**
 * ClickHouse stores the legacy ticker and trade values as Decimal(18,8).
 * Normalize before computing the canonical checksum so the digest describes
 * the value that can actually be queried back from storage.
 */
function legacyDecimal8(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Number(value.toFixed(8));
}

export function buildCanonicalCexStreamEventRow(
	context: MarketCaptureContext,
	rawCapture: RawCapture,
	options?: {
		payloadEncoding?: "canonical_json_v1" | "orderbook_metadata_only_v1";
	},
): BrokerArchiveRow {
	const payloadEncoding = options?.payloadEncoding ?? "canonical_json_v1";
	if (
		payloadEncoding === "orderbook_metadata_only_v1" &&
		context.feed !== "ORDERBOOK"
	) {
		throw new Error("Metadata-only raw encoding requires an ORDERBOOK context");
	}
	const row = withNormalizedChecksum({
		...captureCoreFields(context, rawCapture),
		...legacyMarketFields(context, rawCapture),
		stream_type: context.feed,
		event_time_ms: rawCapture.eventTimeMs,
		payload_encoding: payloadEncoding,
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
		...legacyMarketFields(context, rawCapture),
		source_time_ms: ticker.eventTimeMs,
		event_time_ms: ticker.eventTimeMs,
		last: legacyDecimal8(ticker.last),
		bid: legacyDecimal8(ticker.bid),
		ask: legacyDecimal8(ticker.ask),
		high: legacyDecimal8(ticker.high),
		low: legacyDecimal8(ticker.low),
		open: legacyDecimal8(ticker.open),
		close: legacyDecimal8(ticker.close),
		base_volume: legacyDecimal8(ticker.baseVolume),
		quote_volume: legacyDecimal8(ticker.quoteVolume),
		change: legacyDecimal8(ticker.change),
		percentage: legacyDecimal8(ticker.percentage),
		payload_json: JSON.stringify(rawCapture.redactedPayload),
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
		...legacyMarketFields(context, rawCapture),
		source_time_ms: trade.eventTimeMs,
		trade_id: trade.tradeId,
		event_time_ms: trade.eventTimeMs,
		side: trade.side,
		price: legacyDecimal8(trade.price),
		amount: legacyDecimal8(trade.amount),
		cost: legacyDecimal8(trade.cost),
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
