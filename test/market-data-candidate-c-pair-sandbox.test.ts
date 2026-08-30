import { describe, expect, test } from "bun:test";
import { candidateCInputTapePairArtifactFileNames } from "../scripts/market-data-candidate-c-pair-sandbox";

describe("Candidate C pair sandbox artifacts", () => {
	test("uses pair-scoped Parquet names so the second pair cannot overwrite the first", () => {
		const usdc = candidateCInputTapePairArtifactFileNames("ARB-USDC");
		const usdt = candidateCInputTapePairArtifactFileNames("ARB-USDT");

		expect(usdc).toEqual({
			levels: "arb-usdc-order-book-levels.parquet",
			summary: "arb-usdc-order-book-depth-summary.parquet",
		});
		expect(usdt).toEqual({
			levels: "arb-usdt-order-book-levels.parquet",
			summary: "arb-usdt-order-book-depth-summary.parquet",
		});
		expect(new Set([...Object.values(usdc), ...Object.values(usdt)]).size).toBe(
			4,
		);
	});
});
