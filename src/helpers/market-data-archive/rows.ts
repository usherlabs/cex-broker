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
