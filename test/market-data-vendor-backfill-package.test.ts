import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
		const build = readFileSync(new URL("../build.ts", import.meta.url), "utf8");
		expect(build).toContain("./src/market-data-vendor-backfill.ts");
		const tsconfig = readFileSync(
			new URL("../tsconfig.json", import.meta.url),
			"utf8",
		);
		expect(tsconfig).toContain('"src/market-data-vendor-backfill.ts"');
	});
});
