import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("market-data vendor backfill package boundary", () => {
	test("publishes a dedicated entrypoint without importing the broker server", async () => {
		const entrypoint = readFileSync(
			new URL("../src/market-data-vendor-backfill.ts", import.meta.url),
			"utf8",
		);
		expect(entrypoint).not.toContain("./index");
		expect(entrypoint).not.toContain("./server");
		const product = await import("../src/market-data-vendor-backfill");
		expect(product.runMarketDataVendorBackfill).toBeFunction();
		for (const finalV1Export of [
			"backfillRequestCodec",
			"backfillResultCodec",
			"requiredClockCodec",
			"archiveSelectionCodec",
			"promotionReceiptCodec",
			"jcsCanonicalize",
			"jcsSha256",
			"SCHEMA_MANIFEST",
			"CAPABILITY_POLICY",
			"RESOURCE_POLICY",
			"createMarketDataVendorBackfillDependencies",
		]) {
			expect(finalV1Export in product).toBe(true);
		}
		for (const provisionalExport of [
			"backfillRequestSchema",
			"parseBackfillRequest",
			"BACKFILL_REQUEST_SCHEMA_VERSION",
			"BACKFILL_RESULT_SCHEMA_VERSION",
			"BACKFILL_PROMOTION_SCHEMA_VERSION",
			"BACKFILL_STATUSES",
			"promotionReceiptId",
		]) {
			expect(provisionalExport in product).toBe(false);
		}
	});

	test("declares the package export and declaration/build roots", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as {
			exports?: Record<string, { import?: string; types?: string }>;
		};
		expect(packageJson.exports?.["./market-data-vendor-backfill"]).toEqual({
			import: "./dist/market-data-vendor-backfill.js",
			types: "./dist/market-data-vendor-backfill.d.ts",
		});
		expect(packageJson.exports).toMatchObject({
			"./market-data-vendor-backfill/schema-manifest.json":
				"./dist/market-data-vendor-backfill/schema-manifest.json",
			"./market-data-vendor-backfill/schemas/*":
				"./dist/market-data-vendor-backfill/schemas/*",
			"./market-data-vendor-backfill/policies/*":
				"./dist/market-data-vendor-backfill/policies/*",
			"./market-data-vendor-backfill/fixtures/*":
				"./dist/market-data-vendor-backfill/fixtures/*",
		});
		const build = readFileSync(new URL("../build.ts", import.meta.url), "utf8");
		expect(build).toContain("./src/market-data-vendor-backfill.ts");
		const tsconfig = readFileSync(
			new URL("../tsconfig.json", import.meta.url),
			"utf8",
		);
		expect(tsconfig).toContain('"src/market-data-vendor-backfill.ts"');
	});

	test("copies every manifest artifact and the golden fixtures into dist", async () => {
		await import("../build");
		for (const relativePath of [
			"schema-manifest.json",
			"schemas/request.schema.json",
			"schemas/result.schema.json",
			"schemas/required-clock.schema.json",
			"schemas/archive-selection.schema.json",
			"schemas/promotion-receipt.schema.json",
			"policies/capability-policy.json",
			"policies/resource-policy.json",
			"fixtures/conformance-v1.json",
		]) {
			expect(
				existsSync(
					new URL(
						`../dist/market-data-vendor-backfill/${relativePath}`,
						import.meta.url,
					),
				),
			).toBe(true);
		}
	}, 30_000);
});
