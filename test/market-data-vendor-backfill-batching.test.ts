import { describe, expect, test } from "bun:test";
import { buildForwarderBatches } from "../src/helpers/market-data-vendor-backfill/batching";

describe("vendor backfill forwarder batching", () => {
	test("groups by table, respects row bounds, and reproduces batch identities", () => {
		const rows = [
			...Array.from({ length: 3 }, (_, index) => ({
				table: "market_data.cex_order_book_levels" as const,
				row: { index },
			})),
			{
				table: "market_data.cex_order_book_depth_summary" as const,
				row: { index: 4 },
			},
		];
		const input = {
			captureBundleId: "bundle-a",
			deploymentId: "worker-a",
			rows,
			maxRows: 2,
		};
		const first = buildForwarderBatches(input);
		const second = buildForwarderBatches(input);
		expect(first).toEqual(second);
		expect(first.map(({ rows }) => rows.length)).toEqual([1, 2, 1]);
		expect(first.every(({ batch_id }) => /^[a-f0-9]{64}$/.test(batch_id))).toBe(
			true,
		);
		expect(first.every(({ source }) => source === "external_backfill")).toBe(
			true,
		);
	});

	test("rejects a row that cannot fit in one body", () => {
		expect(() =>
			buildForwarderBatches({
				captureBundleId: "bundle-a",
				deploymentId: "worker-a",
				rows: [
					{
						table: "market_data.cex_order_book_levels",
						row: { payload: "x".repeat(100) },
					},
				],
				maxBytes: 20,
			}),
		).toThrow("archive_row_exceeds_byte_budget");
	});
});
