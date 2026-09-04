import type { NormalizedOrderBookSnapshot } from "../order-book";

const VERIFIED_PROFILE_DEPTH = 500;
const VERIFIED_COALESCING_EXCHANGES = new Set(["binance", "mexc"]);

export type OrderBookAcquisitionProfile = {
	id: string;
	upstreamLimit?: number;
	upstreamOptions?: Record<string, unknown>;
	guaranteedRetainedDepth?: number;
	coalescingSupported: boolean;
	bidExhaustionEvidence: boolean;
	askExhaustionEvidence: boolean;
	exhaustionEvidenceValidated: true;
};

export type OrderBookAcquisitionProfileInput = {
	exchange: string;
	requestedDepth: number | undefined;
	archiveDepth: number;
	enabledProfileIds?: ReadonlySet<string>;
};

export function resolveConservativeOrderBookAcquisitionProfile(
	input: OrderBookAcquisitionProfileInput,
): OrderBookAcquisitionProfile {
	const exchange = input.exchange.trim().toLowerCase();
	if (input.requestedDepth === undefined) {
		return {
			id: `${exchange}:conservative:default`,
			upstreamLimit: undefined,
			guaranteedRetainedDepth: undefined,
			coalescingSupported: false,
			bidExhaustionEvidence: false,
			askExhaustionEvidence: false,
			exhaustionEvidenceValidated: true,
		};
	}
	return {
		id: `${exchange}:conservative:limit:${input.requestedDepth}`,
		upstreamLimit: input.requestedDepth,
		guaranteedRetainedDepth: input.requestedDepth,
		coalescingSupported: false,
		bidExhaustionEvidence: false,
		askExhaustionEvidence: false,
		exhaustionEvidenceValidated: true,
	};
}

export function resolveOrderBookAcquisitionProfile(
	input: OrderBookAcquisitionProfileInput,
): OrderBookAcquisitionProfile {
	const exchange = input.exchange.trim().toLowerCase();
	const requiredDepth = Math.max(input.requestedDepth ?? 0, input.archiveDepth);
	const candidateProfileId = `${exchange}:l2-diff:${VERIFIED_PROFILE_DEPTH}`;
	if (
		VERIFIED_COALESCING_EXCHANGES.has(exchange) &&
		input.enabledProfileIds?.has(candidateProfileId) === true &&
		requiredDepth <= VERIFIED_PROFILE_DEPTH
	) {
		return {
			id: candidateProfileId,
			upstreamLimit: VERIFIED_PROFILE_DEPTH,
			guaranteedRetainedDepth: VERIFIED_PROFILE_DEPTH,
			coalescingSupported: true,
			bidExhaustionEvidence: false,
			askExhaustionEvidence: false,
			exhaustionEvidenceValidated: true,
		};
	}

	return resolveConservativeOrderBookAcquisitionProfile(input);
}

export function projectOrderBookSnapshot(
	snapshot: NormalizedOrderBookSnapshot,
	requestedDepth: number | undefined,
): NormalizedOrderBookSnapshot {
	const retainedDepth = Math.max(snapshot.bids.length, snapshot.asks.length);
	if (requestedDepth === undefined) {
		return { ...snapshot, depthLimit: retainedDepth };
	}
	return {
		...snapshot,
		bids: snapshot.bids.slice(0, requestedDepth),
		asks: snapshot.asks.slice(0, requestedDepth),
		depthLimit: requestedDepth,
	};
}

type SideCoverage = {
	covered: boolean;
	boundaryPrice: number;
	farthestPrice?: number;
	retainedCount: number;
	exhausted: boolean;
};

export type OrderBookBandCoverage = {
	covered: boolean;
	mid: number;
	bandBps: number;
	bid: SideCoverage;
	ask: SideCoverage;
	diagnostics: string[];
};

export type ImmediateHedgeabilityEvidence = OrderBookBandCoverage & {
	/** Base quantity that can be sold immediately into displayed bids. */
	bidDepth: number;
	/** Base quantity that can be bought immediately from displayed asks. */
	askDepth: number;
	limitingSide: "bid" | "ask" | "balanced";
	liquidityCap: number;
};

export function evaluateOrderBookBandCoverage(
	snapshot: Pick<NormalizedOrderBookSnapshot, "bids" | "asks">,
	bandBps: number,
	options: { bidExhausted?: boolean; askExhausted?: boolean } = {},
): OrderBookBandCoverage {
	const bestBid = snapshot.bids[0]?.[0];
	const bestAsk = snapshot.asks[0]?.[0];
	if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
		throw new Error("ORDERBOOK band coverage requires a best bid and ask");
	}
	const mid = ((bestBid as number) + (bestAsk as number)) / 2;
	const bidBoundary = mid * (1 - bandBps / 10_000);
	const askBoundary = mid * (1 + bandBps / 10_000);
	const farthestBid = snapshot.bids.at(-1)?.[0];
	const farthestAsk = snapshot.asks.at(-1)?.[0];
	const bidCovered =
		options.bidExhausted === true ||
		(Number.isFinite(farthestBid) && (farthestBid as number) <= bidBoundary);
	const askCovered =
		options.askExhausted === true ||
		(Number.isFinite(farthestAsk) && (farthestAsk as number) >= askBoundary);
	const diagnostics: string[] = [];
	if (!bidCovered) {
		diagnostics.push(
			`${bandBps}bps bid boundary=${bidBoundary} farthest=${String(farthestBid)} retained=${snapshot.bids.length}`,
		);
	}
	if (!askCovered) {
		diagnostics.push(
			`${bandBps}bps ask boundary=${askBoundary} farthest=${String(farthestAsk)} retained=${snapshot.asks.length}`,
		);
	}
	return {
		covered: bidCovered && askCovered,
		mid,
		bandBps,
		bid: {
			covered: bidCovered,
			boundaryPrice: bidBoundary,
			farthestPrice: farthestBid,
			retainedCount: snapshot.bids.length,
			exhausted: options.bidExhausted === true,
		},
		ask: {
			covered: askCovered,
			boundaryPrice: askBoundary,
			farthestPrice: farthestAsk,
			retainedCount: snapshot.asks.length,
			exhausted: options.askExhausted === true,
		},
		diagnostics,
	};
}

/**
 * Derives the L2 inputs used to cap immediately hedgeable counterpart liquidity.
 * A result is exact only when `covered` is true; otherwise the two depth values
 * are conservative lower bounds because the retained book ends inside the band.
 */
export function evaluateImmediateHedgeability(
	snapshot: Pick<NormalizedOrderBookSnapshot, "bids" | "asks">,
	bandBps: number,
	options: { bidExhausted?: boolean; askExhausted?: boolean } = {},
): ImmediateHedgeabilityEvidence {
	const coverage = evaluateOrderBookBandCoverage(snapshot, bandBps, options);
	const bidDepth = snapshot.bids.reduce((total, level) => {
		const [price = Number.NaN, amount = 0] = level;
		return price >= coverage.bid.boundaryPrice ? total + amount : total;
	}, 0);
	const askDepth = snapshot.asks.reduce((total, level) => {
		const [price = Number.NaN, amount = 0] = level;
		return price <= coverage.ask.boundaryPrice ? total + amount : total;
	}, 0);
	return {
		...coverage,
		bidDepth,
		askDepth,
		limitingSide:
			bidDepth < askDepth ? "bid" : askDepth < bidDepth ? "ask" : "balanced",
		liquidityCap: Math.min(bidDepth, askDepth),
	};
}
