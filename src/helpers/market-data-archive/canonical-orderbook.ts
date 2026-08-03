import type { BrokerArchiveRow } from "../broker-execution-archive/types";
import type {
	NormalizedOrderBookSnapshot,
	OrderBookConstructionMode,
} from "../order-book";
import {
	captureCoreFields,
	normalizeTimestampMs,
	sha256Canonical,
} from "./capture-contract";
import type { MarketCaptureContext, RawCapture } from "./types";

export class OrderBookValidationError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`Invalid order-book evidence: ${reason}`);
		this.name = "OrderBookValidationError";
		this.reason = reason;
	}
}

type ValidLevel = { price: number; amount: number };

export type CanonicalOrderBookRows = {
	snapshotId: string;
	levels: BrokerArchiveRow[];
	summary: BrokerArchiveRow;
};

function parseSequence(
	value: NormalizedOrderBookSnapshot["sequence"],
): number | undefined {
	if (value === undefined) return undefined;
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/.test(value)
				? Number(value)
				: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new OrderBookValidationError(
			"sequence must be a non-negative integer",
		);
	}
	return parsed;
}

function validateSide(
	side: "bid" | "ask",
	levels: number[][],
	depthLimit: number,
): ValidLevel[] {
	if (levels.length === 0) {
		throw new OrderBookValidationError(`${side} side is missing`);
	}
	const retained = levels.slice(0, depthLimit);
	for (let index = 0; index < retained.length; index += 1) {
		const entry = retained[index];
		const price = entry?.[0];
		const amount = entry?.[1];
		if (
			!Array.isArray(entry) ||
			entry.length < 2 ||
			price === undefined ||
			amount === undefined ||
			!Number.isFinite(price) ||
			!Number.isFinite(amount) ||
			price <= 0 ||
			amount <= 0
		) {
			throw new OrderBookValidationError(
				`${side} level ${index} has a non-positive or non-finite price/amount`,
			);
		}
		if (index > 0) {
			const previous = retained[index - 1]?.[0];
			if (
				previous === undefined ||
				(side === "bid" ? price >= previous : price <= previous)
			) {
				throw new OrderBookValidationError(
					`${side} levels are not strictly ${side === "bid" ? "descending" : "ascending"}`,
				);
			}
		}
	}
	return retained.map(([price, amount]) => ({
		price: price as number,
		amount: amount as number,
	}));
}

function normalizedBands(input: readonly number[] | undefined): number[] {
	const bands = input ?? [10, 25, 50, 100];
	for (const band of bands) {
		if (!Number.isFinite(band) || band <= 0 || !Number.isInteger(band)) {
			throw new OrderBookValidationError(
				"measurement bands must be positive integer basis points",
			);
		}
	}
	return [...new Set(bands)].sort((left, right) => left - right);
}

function checksumRow(row: Record<string, unknown>): Record<string, unknown> {
	return { ...row, normalized_row_checksum: sha256Canonical(row) };
}

function commonEvidenceFields(
	context: MarketCaptureContext,
	rawCapture: RawCapture,
	input: {
		snapshotId: string;
		sequence?: number;
		depthLimit: number;
		eventTimeMs: number;
		receivedTimeMs: number;
	},
): Record<string, unknown> {
	return {
		...captureCoreFields(context, rawCapture),
		source_time_ms: input.eventTimeMs,
		received_time_ms: input.receivedTimeMs,
		snapshot_id: input.snapshotId,
		construction_mode: "sampled_top_n_snapshot",
		gap_policy: "record_gap",
		depth_limit: input.depthLimit,
		sequence: input.sequence,
		exact_l2_reconstruction_complete: 0,
	};
}

export function buildCanonicalOrderBookRows(input: {
	context: MarketCaptureContext;
	snapshot: NormalizedOrderBookSnapshot;
	rawCapture: RawCapture;
	depthLimit: number;
	measurementBandsBps?: readonly number[];
	constructionMode?: OrderBookConstructionMode;
}): CanonicalOrderBookRows {
	if (
		!Number.isSafeInteger(input.depthLimit) ||
		input.depthLimit <= 0 ||
		input.depthLimit > 500
	) {
		throw new OrderBookValidationError(
			"depth limit must be an integer between 1 and 500",
		);
	}
	if (input.context.feed !== "ORDERBOOK") {
		throw new OrderBookValidationError("capture context feed is not ORDERBOOK");
	}
	if (input.constructionMode === "exact_l2_reconstruction") {
		throw new OrderBookValidationError(
			"exact L2 requires a complete continuity proof and is unsupported",
		);
	}

	let eventTimeMs: number;
	let receivedTimeMs: number;
	try {
		eventTimeMs = normalizeTimestampMs(
			input.snapshot.timestamp,
			"source_time_ms",
		);
		receivedTimeMs = normalizeTimestampMs(
			input.snapshot.receivedTimestamp,
			"received_time_ms",
		);
	} catch (error) {
		throw new OrderBookValidationError(
			error instanceof Error ? error.message : "invalid timestamp",
		);
	}
	if (receivedTimeMs < eventTimeMs) {
		throw new OrderBookValidationError(
			"received timestamp precedes source timestamp",
		);
	}

	const bids = validateSide("bid", input.snapshot.bids, input.depthLimit);
	const asks = validateSide("ask", input.snapshot.asks, input.depthLimit);
	const bestBid = bids[0] as ValidLevel;
	const bestAsk = asks[0] as ValidLevel;
	if (bestBid.price >= bestAsk.price) {
		throw new OrderBookValidationError("book is crossed or locked");
	}
	const sequence = parseSequence(input.snapshot.sequence);
	const midPrice = (bestBid.price + bestAsk.price) / 2;
	const spread = bestAsk.price - bestBid.price;
	const spreadBps = (spread / midPrice) * 10_000;
	const snapshotId = sha256Canonical({
		exchange: input.context.exchange.trim().toLowerCase(),
		trading_pair: input.context.symbol.trim().replace("/", "-"),
		source_time_ms: eventTimeMs,
		sequence,
		depth_limit: input.depthLimit,
		bids,
		asks,
		schema_version: input.context.schemaVersion,
	});
	const common = commonEvidenceFields(input.context, input.rawCapture, {
		snapshotId,
		sequence,
		depthLimit: input.depthLimit,
		eventTimeMs,
		receivedTimeMs,
	});

	const levels: BrokerArchiveRow[] = (
		[
			["bid", bids],
			["ask", asks],
		] as const
	).flatMap(([side, sideLevels]) =>
		sideLevels.map(({ price, amount }, levelIndex) => {
			const row = checksumRow({
				...common,
				side,
				level_index: levelIndex,
				price,
				amount,
				notional: price * amount,
				mid_price: midPrice,
				spread_from_mid_bps: Math.abs((price - midPrice) / midPrice) * 10_000,
			});
			return { table: "market_data.cex_order_book_levels", row };
		}),
	);

	const bands = normalizedBands(input.measurementBandsBps);
	const bidDepth = bands.map((band) => {
		const minimumPrice = bestBid.price * (1 - band / 10_000);
		return bids
			.filter(({ price }) => price >= minimumPrice)
			.reduce((sum, { amount }) => sum + amount, 0);
	});
	const askDepth = bands.map((band) => {
		const maximumPrice = bestAsk.price * (1 + band / 10_000);
		return asks
			.filter(({ price }) => price <= maximumPrice)
			.reduce((sum, { amount }) => sum + amount, 0);
	});
	const summaryRow = checksumRow({
		...common,
		best_bid: bestBid.price,
		best_ask: bestAsk.price,
		best_bid_amount: bestBid.amount,
		best_ask_amount: bestAsk.amount,
		mid_price: midPrice,
		spread,
		spread_bps: spreadBps,
		staleness_ms: receivedTimeMs - eventTimeMs,
		bid_level_count: bids.length,
		ask_level_count: asks.length,
		measurement_bands_bps: bands,
		bid_depth_by_band: bidDepth,
		ask_depth_by_band: askDepth,
	});

	return {
		snapshotId,
		levels,
		summary: {
			table: "market_data.cex_order_book_depth_summary",
			row: summaryRow,
		},
	};
}
