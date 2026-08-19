import { describe, expect, test } from "bun:test";
import { sha256Canonical } from "../src/helpers/market-data-archive/capture-contract";
import {
	semanticDigest,
	verifySemanticPromotion,
} from "../src/helpers/market-data-vendor-backfill/semantic-verification";
import { validBackfillRequest } from "./market-data-vendor-backfill-contract.test";

const checksum = (value: string) => sha256Canonical({ value });

function rows() {
	const common = {
		capture_bundle_id: "a".repeat(64),
		exchange: "binance",
		trading_pair: "BTC-USDT",
		raw_capture_id: "raw-a",
		snapshot_id: "snapshot-a",
		schema_version: "1.0.0",
		source_time_ms: 1_700_000_899_000,
		depth_limit: 2,
		construction_mode: "sampled_top_n_snapshot",
	};
	return [
		{
			table: "market_data.cex_order_book_levels" as const,
			row: {
				...common,
				side: "bid",
				level_index: 0,
				normalized_row_checksum: checksum("level"),
			},
		},
		{
			table: "market_data.cex_order_book_depth_summary" as const,
			row: {
				...common,
				normalized_row_checksum: checksum("summary"),
			},
		},
	];
}

function evidence(overrides: Record<string, unknown> = {}) {
	return {
		candidateRows: rows(),
		conflictCount: 0,
		prefixDigestBefore: checksum("prefix"),
		prefixDigestAfter: checksum("prefix"),
		suffixDigestBefore: checksum("suffix"),
		suffixDigestAfter: checksum("suffix"),
		seamVerified: true,
		exporterCompatible: true,
		...overrides,
	};
}

describe("FIET-1017 semantic promotion verification", () => {
	test("compares logical keys/checksums and proves required-clock coverage", () => {
		const request = validBackfillRequest({
			requiredClockTargetsMs: [1_700_000_900_000],
		});
		const expected = rows();
		const result = verifySemanticPromotion({
			request,
			normalizedRows: expected,
			...evidence(),
		});
		expect(result).toEqual({
			passed: true,
			reasonCode: "semantic_promotion_verified",
			canonicalSemanticDigest: semanticDigest(expected),
			prefixDigest: checksum("prefix"),
			suffixDigest: checksum("suffix"),
			seamVerified: true,
			coverageVerified: true,
		});
	});

	test("maps every semantic verification gate to a stable fail-closed reason", () => {
		const base = {
			request: validBackfillRequest({
				requiredClockTargetsMs: [1_700_000_900_000],
				maxPriorAsOfLagMs: 2_000,
			}),
			normalizedRows: rows(),
			...evidence(),
		};
		const wrongShape = rows().map((entry) => ({
			...entry,
			row: { ...entry.row, depth_limit: 3 },
		}));
		const future = rows().map((entry) => ({
			...entry,
			row: { ...entry.row, source_time_ms: 1_700_000_901_000 },
		}));
		const stale = rows().map((entry) => ({
			...entry,
			row: { ...entry.row, source_time_ms: 1_700_000_800_000 },
		}));
		const cases: Array<[typeof base, string]> = [
			[
				{
					...base,
					candidateRows: [
						{
							...rows()[0],
							row: {
								...rows()[0]?.row,
								normalized_row_checksum: checksum("changed"),
							},
						},
						...rows().slice(1),
					],
				},
				"candidate_semantic_mismatch",
			],
			[{ ...base, conflictCount: 1 }, "candidate_checksum_conflict"],
			[
				{ ...base, prefixDigestAfter: checksum("mutated") },
				"qualified_timeline_changed",
			],
			[{ ...base, seamVerified: false }, "timeline_seam_invalid"],
			[
				{ ...base, normalizedRows: wrongShape, candidateRows: wrongShape },
				"candidate_shape_mismatch",
			],
			[{ ...base, exporterCompatible: false }, "canonical_export_incompatible"],
			[
				{ ...base, normalizedRows: future, candidateRows: future },
				"required_clock_coverage_insufficient",
			],
			[
				{ ...base, normalizedRows: stale, candidateRows: stale },
				"required_clock_coverage_insufficient",
			],
		];
		for (const [input, reasonCode] of cases) {
			expect(verifySemanticPromotion(input)).toMatchObject({
				passed: false,
				reasonCode,
			});
		}
	});
});
