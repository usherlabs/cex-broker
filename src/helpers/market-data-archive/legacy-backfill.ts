import type {
	BrokerArchiveRow,
	BrokerArchiveSource,
} from "../broker-execution-archive/types";
import type { NormalizedOrderBookSnapshot } from "../order-book";
import { buildCanonicalOrderBookRows } from "./canonical-orderbook";
import {
	CHECKSUM_ALGORITHM,
	MARKET_CAPTURE_SCHEMA_VERSION,
	sha256Canonical,
} from "./capture-contract";
import { buildCanonicalOhlcvRow } from "./rows";
import type { MarketCaptureContext, ParsedOhlcvBar, RawCapture } from "./types";

export type LegacyOrderBookSnapshot = {
	source?: BrokerArchiveSource;
	deployment_id: string;
	account_selector?: string;
	exchange: string;
	asset_type: "spot" | "swap" | "future";
	symbol: string;
	event_time_ms: number;
	received_time_ms: number;
	depth_limit: number;
	bids_price: number[];
	bids_size: number[];
	asks_price: number[];
	asks_size: number[];
	sequence?: number;
};

export type LegacyCandle = {
	source?: BrokerArchiveSource;
	deployment_id: string;
	account_selector?: string;
	exchange: string;
	asset_type: "spot" | "swap" | "future";
	symbol: string;
	timeframe: string;
	open_time_ms: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	quote_volume?: number;
	is_closed: 0 | 1;
	broker_version: number;
};

function legacyContext(input: {
	source?: BrokerArchiveSource;
	deployment_id: string;
	account_selector?: string;
	exchange: string;
	asset_type: "spot" | "swap" | "future";
	symbol: string;
	feed: "ORDERBOOK" | "OHLCV";
	timeframe?: string;
}): MarketCaptureContext {
	return {
		source: input.source ?? "broker_write",
		deploymentId: input.deployment_id,
		accountSelector: input.account_selector,
		captureBundleId: "legacy-unavailable",
		exchange: input.exchange,
		symbol: input.symbol,
		assetType: input.asset_type,
		feed: input.feed,
		provider:
			input.feed === "ORDERBOOK"
				? "legacy:orderbook_snapshots"
				: "legacy:candles",
		sourceMode: "legacy_migration_v1",
		schemaVersion: MARKET_CAPTURE_SCHEMA_VERSION,
		checksumAlgorithm: CHECKSUM_ALGORITHM,
		provenanceComplete: false,
		timeframe: input.timeframe,
	};
}

function unavailableRaw(
	eventTimeMs: number,
	receivedTimeMs: number,
): RawCapture {
	return {
		rawCaptureId: "legacy-unavailable",
		rawCaptureScope: "ccxt_normalized_object",
		rawChecksum: "legacy-unavailable",
		redactedPayload: null,
		eventTimeMs,
		receivedTimeMs,
		checksumAlgorithm: CHECKSUM_ALGORITHM,
	};
}

function markIncomplete(row: BrokerArchiveRow): BrokerArchiveRow {
	const incomplete = {
		...row.row,
		capture_bundle_id: null,
		raw_capture_id: null,
		raw_capture_scope: null,
		raw_checksum: null,
		provenance_complete: 0,
		source_mode: "legacy_migration_v1",
	};
	return {
		table: row.table,
		row: {
			...incomplete,
			normalized_row_checksum: sha256Canonical(incomplete),
		},
	};
}

export function buildLegacyOrderBookBackfillRows(
	legacy: LegacyOrderBookSnapshot,
): BrokerArchiveRow[] {
	if (
		legacy.bids_price.length !== legacy.bids_size.length ||
		legacy.asks_price.length !== legacy.asks_size.length
	) {
		throw new Error("Legacy order-book price and size arrays must align");
	}
	const snapshot: NormalizedOrderBookSnapshot = {
		bids: legacy.bids_price.map((price, index) => [
			price,
			legacy.bids_size[index] as number,
		]),
		asks: legacy.asks_price.map((price, index) => [
			price,
			legacy.asks_size[index] as number,
		]),
		timestamp: legacy.event_time_ms,
		receivedTimestamp: legacy.received_time_ms,
		exchange: legacy.exchange,
		symbol: legacy.symbol,
		depthLimit: legacy.depth_limit,
		sequence: legacy.sequence,
	};
	const canonical = buildCanonicalOrderBookRows({
		context: legacyContext({ ...legacy, feed: "ORDERBOOK" }),
		snapshot,
		rawCapture: unavailableRaw(legacy.event_time_ms, legacy.received_time_ms),
		depthLimit: legacy.depth_limit,
	});
	return [...canonical.levels, canonical.summary].map(markIncomplete);
}

export function buildLegacyOhlcvBackfillRow(
	legacy: LegacyCandle,
): BrokerArchiveRow {
	const bar: ParsedOhlcvBar = {
		openTimeMs: legacy.open_time_ms,
		open: legacy.open,
		high: legacy.high,
		low: legacy.low,
		close: legacy.close,
		volume: legacy.volume,
		quoteVolume: legacy.quote_volume,
	};
	return markIncomplete(
		buildCanonicalOhlcvRow({
			context: legacyContext({ ...legacy, feed: "OHLCV" }),
			rawCapture: unavailableRaw(legacy.open_time_ms, legacy.open_time_ms),
			bar,
			isClosed: legacy.is_closed === 1,
			brokerVersion: legacy.broker_version,
		}),
	);
}
