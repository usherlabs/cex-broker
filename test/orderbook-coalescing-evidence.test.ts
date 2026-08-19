import { describe, expect, test } from "bun:test";
import {
	CEX_ORDERBOOK_COALESCING_EVIDENCE_SCHEMA,
	serializeCexOrderBookCoalescingEvidence,
	sha256CexOrderBookCoalescingEvidence,
	validateCexOrderBookCoalescingEvidence,
} from "../src/helpers/public-market-data-feed";

function snapshot(venue: "binance" | "mexc") {
	return {
		bids: [[100, 1]],
		asks: [[101, 2]],
		timestamp: 1_700_000_000_000,
		exchange: venue,
		symbol: "BTC/USDT",
		depthLimit: 100,
	};
}

function coverage() {
	return {
		covered: true,
		mid: 100.5,
		bandBps: 50,
		bid: {
			covered: true,
			boundaryPrice: 99.9975,
			farthestPrice: 99.9,
			retainedCount: 100,
			exhausted: false,
		},
		ask: {
			covered: true,
			boundaryPrice: 101.0025,
			farthestPrice: 101.1,
			retainedCount: 100,
			exhausted: false,
		},
		diagnostics: [],
	};
}

function proofCase(venue: "binance" | "mexc") {
	const book = snapshot(venue);
	const bandCoverage = [coverage()];
	return {
		venue,
		profileId: `${venue}:l2-diff:500`,
		observations: Array.from({ length: 5 }, (_, index) => ({
			index,
			conservative: { live: book, rehydrated: book },
			coalesced: { live: book, rehydrated: book },
			coverage: {
				conservativeLive: bandCoverage,
				conservativeRehydrated: bandCoverage,
				coalescedLive: bandCoverage,
				coalescedRehydrated: bandCoverage,
			},
			snapshotHashes: {
				conservativeLive: "a".repeat(64),
				conservativeRehydrated: "a".repeat(64),
				coalescedLive: "a".repeat(64),
				coalescedRehydrated: "a".repeat(64),
			},
		})),
		cexVerdicts: {
			logicalPayloadsEqual: true,
			canonicalArchiveEqual: true,
			liveReplayInputsEqual: true,
			bandCoverageComplete: true,
			reducedPhysicalWork: true,
			physicalWork: {
				conservative: {
					workers: 2,
					watchIterations: 10,
					frames: 10,
					archiveDecisions: 10,
				},
				coalesced: {
					workers: 1,
					watchIterations: 5,
					frames: 5,
					archiveDecisions: 5,
				},
			},
		},
		insufficientReplayCase: {
			archiveDepth: 25,
			policyDepth: 100,
			rejected: true,
			observations: [
				{
					index: 0,
					coverage: [{ ...coverage(), covered: false }],
					diagnostics: ["50bps bid retained inside boundary"],
				},
			],
		},
	};
}

function evidence() {
	return {
		schemaVersion: CEX_ORDERBOOK_COALESCING_EVIDENCE_SCHEMA,
		policyDepth: 100,
		archiveDepth: 100,
		bandsBps: [50],
		cases: [proofCase("binance"), proofCase("mexc")],
	};
}

describe("CEX ORDERBOOK coalescing Proof A", () => {
	test("serializes canonical UTF-8 JSON followed by exactly one LF", () => {
		const bytes = serializeCexOrderBookCoalescingEvidence(evidence());
		expect(bytes.at(-1)).toBe(0x0a);
		expect(bytes.at(-2)).not.toBe(0x0a);
		expect(new TextDecoder().decode(bytes)).not.toContain("\n\n");
		expect(sha256CexOrderBookCoalescingEvidence(evidence())).toMatch(
			/^[0-9a-f]{64}$/,
		);
	});

	test("accepts exactly one ordered Binance and MEXC case", () => {
		expect(validateCexOrderBookCoalescingEvidence(evidence())).toEqual(
			evidence(),
		);
	});

	test("rejects self hashes, nondeterministic metadata, and wrong venue order", () => {
		expect(() =>
			validateCexOrderBookCoalescingEvidence({
				...evidence(),
				sha256: "a".repeat(64),
			}),
		).toThrow("field set");
		expect(() =>
			validateCexOrderBookCoalescingEvidence({
				...evidence(),
				cases: [proofCase("mexc"), proofCase("binance")],
			}),
		).toThrow("Binance then MEXC");
	});
});
