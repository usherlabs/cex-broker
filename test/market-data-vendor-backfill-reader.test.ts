import { describe, expect, test } from "bun:test";
import { sha256Canonical } from "../src/helpers/market-data-archive/capture-contract";
import {
	type ArchiveQueryClient,
	QualifiedOrderBookArchiveReader,
} from "../src/helpers/market-data-vendor-backfill/archive-reader";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import type { NormalizedBackfill } from "../src/helpers/market-data-vendor-backfill/core";
import { semanticDigest } from "../src/helpers/market-data-vendor-backfill/semantic-verification";
import { validBackfillRequest } from "./market-data-vendor-backfill-contract.test";

const digest = (value: string) => sha256Canonical({ value });

const verificationBaseline = {
	selection: CONFORMANCE_FIXTURES.documents.request.initial_selection,
	receipts: [],
	readerIdentity: {
		environment: "production",
		cluster: "cex-archive-primary",
	},
	verificationBaseline: {
		prefixDigest: sha256Canonical([]),
		suffixDigest: sha256Canonical([]),
	},
};

function normalized(): NormalizedBackfill {
	const common = {
		source: "external_backfill",
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
	const rows = [
		{
			table: "market_data.cex_order_book_levels" as const,
			row: {
				...common,
				side: "bid",
				level_index: 0,
				normalized_row_checksum: digest("level"),
			},
		},
		{
			table: "market_data.cex_order_book_depth_summary" as const,
			row: { ...common, normalized_row_checksum: digest("summary") },
		},
	];
	return {
		captureBundleId: "a".repeat(64),
		objects: [
			{ identity: "object", checksum: digest("object"), bytes: 1, rows: 2 },
		],
		rows,
		vendorSemanticDigest: digest("vendor"),
		canonicalSemanticDigest: semanticDigest(rows),
	};
}

describe("qualification-aware archive reader", () => {
	test("coverage reads only the qualified view and applies prior-as-of lag", async () => {
		const queries: string[] = [];
		const client: ArchiveQueryClient = {
			query: async (sql) => {
				queries.push(sql);
				return [
					{
						source_time_ms: 1_700_000_899_000,
						normalized_row_checksum: digest("summary"),
					},
				];
			},
		};
		const reader = new QualifiedOrderBookArchiveReader(client);
		const result = await reader.coverage(
			validBackfillRequest({
				requiredClockTargetsMs: [1_700_000_900_000],
				maxPriorAsOfLagMs: 2_000,
			}),
		);
		expect(result.complete).toBe(true);
		expect(result.coverageDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(queries[0]).toContain(
			"market_data.cex_order_book_depth_summary_replay_qualified",
		);
		expect(queries[0]).not.toContain(
			"market_data.cex_order_book_depth_summary_canonical",
		);
		for (const boundaryQuery of queries.slice(1)) {
			expect(boundaryQuery).toContain(
				"market_data.cex_order_book_levels_replay_qualified",
			);
			expect(boundaryQuery).toContain(
				"market_data.cex_order_book_depth_summary_replay_qualified",
			);
			expect(boundaryQuery).toContain("boundary_start_ms");
			expect(boundaryQuery).toContain("boundary_end_ms");
		}
	});

	test("candidate verification uses unqualified canonical evidence and conflict views", async () => {
		const candidate = normalized();
		const queries: string[] = [];
		const client: ArchiveQueryClient = {
			query: async (sql) => {
				queries.push(sql);
				if (sql.includes("levels_conflicts")) return [{ conflicts: "0" }];
				if (sql.includes("levels_canonical")) {
					return candidate.rows
						.filter(({ table }) => table.endsWith("levels"))
						.map(({ row }) => row);
				}
				if (sql.includes("depth_summary_canonical")) {
					return candidate.rows
						.filter(({ table }) => table.endsWith("depth_summary"))
						.map(({ row }) => row);
				}
				return [];
			},
		};
		const reader = new QualifiedOrderBookArchiveReader(client);
		const result = await reader.verifyCandidate(
			validBackfillRequest({
				requiredClockTargetsMs: [1_700_000_900_000],
				maxPriorAsOfLagMs: 2_000,
			}),
			candidate,
			candidate.captureBundleId,
			verificationBaseline,
		);
		expect(result.passed).toBe(true);
		expect(queries.some((sql) => sql.includes("levels_canonical"))).toBe(true);
		expect(queries.some((sql) => sql.includes("levels_conflicts"))).toBe(true);
	});

	test("seam validation compares UInt64 sequence strings without precision loss", async () => {
		const candidate = normalized();
		const level = candidate.rows[0];
		const summary = candidate.rows[1];
		if (!level || !summary) throw new Error("synthetic rows missing");
		level.row.sequence = "9007199254740993";
		summary.row.sequence = "9007199254740993";
		candidate.rows.push({
			table: "market_data.cex_order_book_depth_summary",
			row: {
				...summary.row,
				raw_capture_id: "raw-b",
				snapshot_id: "snapshot-b",
				source_time_ms: 1_700_000_899_001,
				sequence: "9007199254740992",
				normalized_row_checksum: digest("summary-b"),
			},
		});
		candidate.canonicalSemanticDigest = semanticDigest(candidate.rows);
		const client: ArchiveQueryClient = {
			query: async (sql) => {
				if (sql.includes("levels_conflicts")) return [{ conflicts: "0" }];
				if (sql.includes("levels_canonical")) {
					return candidate.rows
						.filter(({ table }) => table.endsWith("levels"))
						.map(({ row }) => row);
				}
				if (sql.includes("depth_summary_canonical")) {
					return candidate.rows
						.filter(({ table }) => table.endsWith("depth_summary"))
						.map(({ row }) => row);
				}
				return [];
			},
		};
		const result = await new QualifiedOrderBookArchiveReader(
			client,
		).verifyCandidate(
			validBackfillRequest({
				requiredClockTargetsMs: [1_700_000_900_000],
				maxPriorAsOfLagMs: 2_000,
			}),
			candidate,
			candidate.captureBundleId,
			verificationBaseline,
		);
		expect(result).toMatchObject({
			passed: false,
			reasonCode: "timeline_seam_invalid",
		});
	});
});
