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
import { normalizeOrderbookMeasurementBandsBps } from "./orderbook-depth";
import type {
	MarketCaptureContext,
	OrderbookArchiveMetadata,
	RawCapture,
} from "./types";

export const ORDERBOOK_SUMMARY_SCHEMA_VERSION = "2.0.0" as const;

export class OrderBookValidationError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`Invalid order-book evidence: ${reason}`);
		this.name = "OrderBookValidationError";
		this.reason = reason;
	}
}

type ValidLevel = { price: number; amount: number };
type BandStatus = "exact" | "censored";

export type CanonicalOrderBookRows = {
	snapshotId: string;
	levels: BrokerArchiveRow[];
	summary: BrokerArchiveRow;
};

function parseSequence(
	value: NormalizedOrderBookSnapshot["sequence"],
): number | string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") {
		if (Number.isSafeInteger(value) && value >= 0) return value;
		throw new OrderBookValidationError(
			"sequence must be a non-negative integer",
		);
	}
	if (typeof value !== "string" || !/^\d+$/.test(value)) {
		throw new OrderBookValidationError(
			"sequence must be a non-negative integer",
		);
	}
	const parsed = BigInt(value);
	if (parsed > 18_446_744_073_709_551_615n) {
		throw new OrderBookValidationError("sequence exceeds UInt64");
	}
	return parsed.toString(10);
}

function validatePositiveInteger(
	value: number,
	field: string,
	maximum = Number.MAX_SAFE_INTEGER,
): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw new OrderBookValidationError(
			`${field} must be a positive integer${maximum === 500 ? " between 1 and 500" : ""}`,
		);
	}
}

function validateSide(side: "bid" | "ask", levels: number[][]): ValidLevel[] {
	if (levels.length === 0) {
		throw new OrderBookValidationError(`${side} side is missing`);
	}
	const validated: ValidLevel[] = [];
	for (let index = 0; index < levels.length; index += 1) {
		const entry = levels[index];
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
			const previous = validated[index - 1]?.price;
			if (
				previous === undefined ||
				(side === "bid" ? price >= previous : price <= previous)
			) {
				throw new OrderBookValidationError(
					`${side} levels are not strictly ${side === "bid" ? "descending" : "ascending"}`,
				);
			}
		}
		validated.push({ price, amount });
	}
	return validated;
}

function validateMetadata(
	metadata: OrderbookArchiveMetadata,
	observedBids: ValidLevel[],
	observedAsks: ValidLevel[],
): number[] {
	if (!metadata.captureProfileId.trim()) {
		throw new OrderBookValidationError("capture_profile_id must not be empty");
	}
	validatePositiveInteger(metadata.effectiveCadenceMs, "effective_cadence_ms");
	if (metadata.requestedUpstreamDepth !== null) {
		validatePositiveInteger(
			metadata.requestedUpstreamDepth,
			"requested_upstream_depth",
			500,
		);
	}
	validatePositiveInteger(metadata.observedBidCount, "observed_bid_count");
	validatePositiveInteger(metadata.observedAskCount, "observed_ask_count");
	if (metadata.observedBidCount !== observedBids.length) {
		throw new OrderBookValidationError(
			"observed_bid_count does not match the complete observation",
		);
	}
	if (metadata.observedAskCount !== observedAsks.length) {
		throw new OrderBookValidationError(
			"observed_ask_count does not match the complete observation",
		);
	}
	const farthestBid = observedBids.at(-1)?.price;
	const farthestAsk = observedAsks.at(-1)?.price;
	if (
		!Number.isFinite(metadata.observedFarthestBid) ||
		metadata.observedFarthestBid <= 0 ||
		metadata.observedFarthestBid !== farthestBid
	) {
		throw new OrderBookValidationError(
			"observed_farthest_bid does not match the complete observation",
		);
	}
	if (
		!Number.isFinite(metadata.observedFarthestAsk) ||
		metadata.observedFarthestAsk <= 0 ||
		metadata.observedFarthestAsk !== farthestAsk
	) {
		throw new OrderBookValidationError(
			"observed_farthest_ask does not match the complete observation",
		);
	}
	for (const [side, evidence] of [
		["bid", metadata.exhaustionEvidence.bid],
		["ask", metadata.exhaustionEvidence.ask],
	] as const) {
		if (
			evidence.validated !== true ||
			typeof evidence.exhausted !== "boolean" ||
			!evidence.source.trim()
		) {
			throw new OrderBookValidationError(
				`${side} exhaustion evidence must be validated and source-bound`,
			);
		}
	}
	try {
		return normalizeOrderbookMeasurementBandsBps(metadata.measurementBandsBps);
	} catch (error) {
		throw new OrderBookValidationError(
			error instanceof Error ? error.message : "invalid measurement bands",
		);
	}
}

function checksumRow(row: Record<string, unknown>): Record<string, unknown> {
	return { ...row, normalized_row_checksum: sha256Canonical(row) };
}

function commonEvidenceFields(
	context: MarketCaptureContext,
	rawCapture: RawCapture,
	input: {
		snapshotId: string;
		sequence?: number | string;
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

function sideBandEvidence(input: {
	levels: ValidLevel[];
	boundaries: number[];
	side: "bid" | "ask";
	exhausted: boolean;
}): { depths: number[]; statuses: BandStatus[] } {
	const farthest = input.levels.at(-1)?.price as number;
	const depths = input.boundaries.map((boundary) =>
		input.levels
			.filter(({ price }) =>
				input.side === "bid" ? price >= boundary : price <= boundary,
			)
			.reduce((sum, { amount }) => sum + amount, 0),
	);
	const statuses = input.boundaries.map<BandStatus>((boundary) => {
		const boundaryReached =
			input.side === "bid" ? farthest <= boundary : farthest >= boundary;
		return boundaryReached || input.exhausted ? "exact" : "censored";
	});
	return { depths, statuses };
}

export function buildCanonicalOrderBookRows(input: {
	context: MarketCaptureContext;
	snapshot: NormalizedOrderBookSnapshot;
	rawCapture: RawCapture;
	depthLimit: number;
	archiveMetadata: OrderbookArchiveMetadata;
	constructionMode?: OrderBookConstructionMode;
}): CanonicalOrderBookRows {
	validatePositiveInteger(input.depthLimit, "depth limit", 500);
	if (input.context.feed !== "ORDERBOOK") {
		throw new OrderBookValidationError("capture context feed is not ORDERBOOK");
	}
	if (input.context.schemaVersion !== "1.0.0") {
		throw new OrderBookValidationError(
			"ORDERBOOK raw and level capture schema must be 1.0.0",
		);
	}
	if (!input.context.provenanceComplete) {
		throw new OrderBookValidationError(
			"summary v2 requires complete live provenance",
		);
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

	const observedBids = validateSide("bid", input.snapshot.bids);
	const observedAsks = validateSide("ask", input.snapshot.asks);
	const bestBid = observedBids[0] as ValidLevel;
	const bestAsk = observedAsks[0] as ValidLevel;
	if (bestBid.price >= bestAsk.price) {
		throw new OrderBookValidationError("book is crossed or locked");
	}
	const bands = validateMetadata(
		input.archiveMetadata,
		observedBids,
		observedAsks,
	);
	const bids = observedBids.slice(0, input.depthLimit);
	const asks = observedAsks.slice(0, input.depthLimit);
	const retainedFarthestBid = bids.at(-1) as ValidLevel;
	const retainedFarthestAsk = asks.at(-1) as ValidLevel;
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

	const bidBoundaries = bands.map((band) => midPrice * (1 - band / 10_000));
	const askBoundaries = bands.map((band) => midPrice * (1 + band / 10_000));
	const bidEvidence = sideBandEvidence({
		levels: observedBids,
		boundaries: bidBoundaries,
		side: "bid",
		exhausted: input.archiveMetadata.exhaustionEvidence.bid.exhausted,
	});
	const askEvidence = sideBandEvidence({
		levels: observedAsks,
		boundaries: askBoundaries,
		side: "ask",
		exhausted: input.archiveMetadata.exhaustionEvidence.ask.exhausted,
	});
	const summaryRow = checksumRow({
		...common,
		schema_version: ORDERBOOK_SUMMARY_SCHEMA_VERSION,
		capture_profile_id: input.archiveMetadata.captureProfileId,
		effective_cadence_ms: input.archiveMetadata.effectiveCadenceMs,
		requested_upstream_depth: input.archiveMetadata.requestedUpstreamDepth,
		observed_bid_count: input.archiveMetadata.observedBidCount,
		observed_ask_count: input.archiveMetadata.observedAskCount,
		observed_farthest_bid: input.archiveMetadata.observedFarthestBid,
		observed_farthest_ask: input.archiveMetadata.observedFarthestAsk,
		retained_farthest_bid: retainedFarthestBid.price,
		retained_farthest_ask: retainedFarthestAsk.price,
		bid_exhausted: input.archiveMetadata.exhaustionEvidence.bid.exhausted
			? 1
			: 0,
		ask_exhausted: input.archiveMetadata.exhaustionEvidence.ask.exhausted
			? 1
			: 0,
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
		bid_boundary_price_by_band: bidBoundaries,
		ask_boundary_price_by_band: askBoundaries,
		bid_depth_by_band: bidEvidence.depths,
		ask_depth_by_band: askEvidence.depths,
		bid_status_by_band: bidEvidence.statuses,
		ask_status_by_band: askEvidence.statuses,
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
