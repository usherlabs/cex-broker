import type {
	BrokerArchiveRow,
	BrokerArchiveSource,
} from "../broker-execution-archive/types";
import {
	CHECKSUM_ALGORITHM,
	canonicalDecimal,
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

export function buildLegacyOrderBookMigrationRows(
	legacy: LegacyOrderBookSnapshot,
): BrokerArchiveRow[] {
	if (
		legacy.bids_price.length !== legacy.bids_size.length ||
		legacy.asks_price.length !== legacy.asks_size.length
	) {
		throw new Error("Legacy order-book price and size arrays must align");
	}
	if (
		!Number.isSafeInteger(legacy.depth_limit) ||
		legacy.depth_limit <= 0 ||
		legacy.depth_limit > 500
	) {
		throw new Error("Legacy order-book depth_limit must be in 1..500");
	}
	const bids = legacy.bids_price
		.slice(0, legacy.depth_limit)
		.map((price, index) => ({
			price,
			amount: legacy.bids_size[index] as number,
		}));
	const asks = legacy.asks_price
		.slice(0, legacy.depth_limit)
		.map((price, index) => ({
			price,
			amount: legacy.asks_size[index] as number,
		}));
	if (bids.length === 0 || asks.length === 0) {
		throw new Error("Legacy order-book migration requires both sides");
	}
	for (const [side, levels] of [
		["bid", bids],
		["ask", asks],
	] as const) {
		for (let index = 0; index < levels.length; index += 1) {
			const level = levels[index] as { price: number; amount: number };
			if (
				!Number.isFinite(level.price) ||
				!Number.isFinite(level.amount) ||
				level.price <= 0 ||
				level.amount <= 0
			) {
				throw new Error(`Invalid legacy ${side} level ${index}`);
			}
			const previous = levels[index - 1]?.price;
			if (
				previous !== undefined &&
				(side === "bid" ? level.price >= previous : level.price <= previous)
			) {
				throw new Error(`Legacy ${side} levels are not strictly ordered`);
			}
		}
	}
	const bestBid = bids[0] as { price: number; amount: number };
	const bestAsk = asks[0] as { price: number; amount: number };
	if (bestBid.price >= bestAsk.price) {
		throw new Error("Legacy order-book is crossed or locked");
	}
	const midPrice = (bestBid.price + bestAsk.price) / 2;
	const snapshotId = sha256Canonical({
		exchange: legacy.exchange.trim().toLowerCase(),
		trading_pair: legacy.symbol.trim().replace("/", "-"),
		source_time_ms: legacy.event_time_ms,
		sequence: legacy.sequence,
		depth_limit: legacy.depth_limit,
		bids,
		asks,
		schema_version: MARKET_CAPTURE_SCHEMA_VERSION,
	});
	const common = {
		source: legacy.source ?? "broker_write",
		deployment_id: legacy.deployment_id,
		capture_bundle_id: null,
		exchange: legacy.exchange.trim().toLowerCase(),
		symbol: legacy.symbol.trim(),
		trading_pair: legacy.symbol.trim().replace("/", "-"),
		source_symbol: legacy.symbol.trim(),
		asset_type: legacy.asset_type,
		feed: "ORDERBOOK",
		provider: "legacy:orderbook_snapshots",
		source_mode: "legacy_migration_v1",
		source_time_ms: legacy.event_time_ms,
		received_time_ms: legacy.received_time_ms,
		raw_capture_id: null,
		raw_capture_scope: null,
		schema_version: MARKET_CAPTURE_SCHEMA_VERSION,
		checksum_algorithm: CHECKSUM_ALGORITHM,
		raw_checksum: null,
		provenance_complete: 0,
		snapshot_id: snapshotId,
		construction_mode: "sampled_top_n_snapshot",
		gap_policy: "record_gap",
		depth_limit: legacy.depth_limit,
		sequence: legacy.sequence,
		exact_l2_reconstruction_complete: 0,
	};
	// Legacy snapshots retain bounded schema-v1 levels as honest incomplete
	// diagnostics. They never invoke or manufacture a summary of either version.
	return (
		[
			["bid", bids],
			["ask", asks],
		] as const
	).flatMap(([side, levels]) =>
		levels.map(({ price, amount }, levelIndex) => {
			const row = {
				...common,
				side,
				level_index: levelIndex,
				price: Number(canonicalDecimal(price)),
				amount: Number(canonicalDecimal(amount)),
				notional: price * amount,
				mid_price: midPrice,
				spread_from_mid_bps: Math.abs((price - midPrice) / midPrice) * 10_000,
			};
			return {
				table: "market_data.cex_order_book_levels" as const,
				row: { ...row, normalized_row_checksum: sha256Canonical(row) },
			};
		}),
	);
}

export function buildLegacyOhlcvMigrationRow(
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
