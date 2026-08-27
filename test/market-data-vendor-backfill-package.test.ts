import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
		for (const currentExport of [
			"backfillRequestCodec",
			"backfillResultV2Codec",
			"requiredClockCodec",
			"archiveSelectionCodec",
			"promotionReceiptCodec",
			"jcsCanonicalize",
			"jcsSha256",
			"PREPARATION_SCHEMA_MANIFEST_V3",
			"CAPABILITY_POLICY",
			"RESOURCE_POLICY",
			"createMarketDataVendorBackfillDependencies",
		]) {
			expect(currentExport in product).toBe(true);
		}
		for (const removedExport of [
			"BACKFILL_RESULT_SCHEMA_ID",
			"backfillResultCodec",
			"finalizeBackfillResult",
			"SCHEMA_MANIFEST",
			"LEGACY_RESOURCE_POLICY",
			"backfillRequestSchema",
			"parseBackfillRequest",
			"BACKFILL_REQUEST_SCHEMA_VERSION",
			"BACKFILL_RESULT_SCHEMA_VERSION",
			"BACKFILL_PROMOTION_SCHEMA_VERSION",
			"BACKFILL_STATUSES",
			"promotionReceiptId",
		]) {
			expect(removedExport in product).toBe(false);
		}
	});

	test("declares the package export and declaration/build roots", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as {
			exports?: Record<string, { import?: string; types?: string }>;
			bin?: Record<string, string>;
		};
		expect(packageJson.bin).toEqual({
			"cex-broker": "dist/commands/cli.js",
			"market-data-vendor-backfill":
				"dist/commands/market-data-vendor-backfill.js",
			"cex-canonical-orderbook-export":
				"dist/commands/cex-canonical-orderbook-export.js",
		});
		expect(packageJson.exports?.["./market-data-vendor-backfill"]).toEqual({
			import: "./dist/market-data-vendor-backfill.js",
			types: "./dist/market-data-vendor-backfill.d.ts",
		});
		expect(packageJson.exports).not.toHaveProperty(
			"./market-data-vendor-backfill/schema-manifest.json",
		);
		const build = readFileSync(new URL("../build.ts", import.meta.url), "utf8");
		expect(build).toContain("./src/market-data-vendor-backfill.ts");
		const tsconfig = readFileSync(
			new URL("../tsconfig.json", import.meta.url),
			"utf8",
		);
		expect(tsconfig).toContain('"src/market-data-vendor-backfill.ts"');
	});

	test("copies only the twelve current manifest artifacts and v3 fixture", async () => {
		await import("../build");
		for (const relativePath of [
			"schema-manifest.json",
			"schemas/backfill-request-v1.schema.json",
			"schemas/backfill-result-v2.schema.json",
			"schemas/required-clock-v1.schema.json",
			"schemas/archive-selection-v1.schema.json",
			"schemas/promotion-receipt-v1.schema.json",
			"schemas/canonical-orderbook-export-request-v1.schema.json",
			"schemas/canonical-orderbook-export-result-v2.schema.json",
			"schemas/preparation-product-pin-v2.schema.json",
			"schemas/order-book-levels-parquet-projection-v1.schema.json",
			"schemas/order-book-depth-summary-parquet-projection-v1.schema.json",
			"schemas/source-forensics-ledger-v1.schema.json",
			"schemas/source-qualification-record-v1.schema.json",
			"policies/capability-policy.json",
			"policies/resource-policy.json",
			"fixtures/conformance-v3.json",
		]) {
			expect(
				existsSync(
					new URL(
						`../dist/market-data-preparation/${relativePath}`,
						import.meta.url,
					),
				),
			).toBe(true);
		}
		const requestSchema = readFileSync(
			new URL(
				"../dist/market-data-preparation/schemas/backfill-request-v1.schema.json",
				import.meta.url,
			),
			"utf8",
		).toLowerCase();
		expect(requestSchema).not.toContain("observer");
		expect(requestSchema).not.toContain("forensic");
		expect(
			existsSync(
				new URL("../dist/market-data-vendor-backfill", import.meta.url),
			),
		).toBe(false);
		for (const relativePath of [
			"dist/market-data-vendor-backfill.js",
			"dist/market-data-preparation.js",
			"dist/commands/market-data-vendor-backfill.js",
			"dist/commands/cex-canonical-orderbook-export.js",
		]) {
			const source = readFileSync(
				new URL(`../${relativePath}`, import.meta.url),
				"utf8",
			);
			for (const forbidden of [
				"fiet_tee_commit",
				"market-data-vendor-backfill-result/v1",
				"market-data-vendor-backfill-capabilities/v1",
				"market-data-vendor-backfill-capabilities/v2",
				"market-data-vendor-backfill-resources/v1",
			]) {
				expect(source, `${relativePath} retains ${forbidden}`).not.toContain(
					forbidden,
				);
			}
		}
		const python = spawnSync(
			"python3",
			[
				new URL(
					"../scripts/verify-market-data-preparation-fixture.py",
					import.meta.url,
				).pathname,
				"--assets",
				new URL("../dist/market-data-preparation", import.meta.url).pathname,
				"--fixture",
				new URL(
					"../dist/market-data-preparation/fixtures/conformance-v3.json",
					import.meta.url,
				).pathname,
			],
			{ encoding: "utf8" },
		);
		expect(python.stderr).toBe("");
		expect(python.status).toBe(0);
		expect(JSON.parse(python.stdout)).toMatchObject({
			fixture_id: "cex-market-data-preparation-conformance/v3",
			schema_count: 12,
			projection_descriptor_count: 2,
		});
	}, 30_000);
});
