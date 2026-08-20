import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	buildCryptoHftDataConformanceRequest,
	toHashOnlyConformanceEvidence,
} from "../scripts/market-data-vendor-backfill-conformance";

describe("market-data vendor backfill provider conformance harness", () => {
	test("builds one explicitly enabled, bounded proven-profile request", () => {
		const request = buildCryptoHftDataConformanceRequest(
			Date.UTC(2026, 7, 18, 9, 27, 15, 308),
		);
		expect(request.scope).toMatchObject({
			exchange: "okx",
			tradingPair: "ARB-USDT",
			sourceSymbol: "ARB-USDT",
			marketType: "spot",
		});
		expect(request.budgets).toMatchObject({
			maxFiles: 1,
			maxBoundaryLookbackMs: 0,
		});
	});

	test("projects only identities, counts, and hashes—not decoded rows or secrets", () => {
		const secret = "licensed-provider-payload-and-secret";
		const evidence = toHashOnlyConformanceEvidence(
			{
				provider: "cryptohftdata",
				adapterVersion: "cryptohftdata-orderbook/v2",
				providerExchangeId: "okx_spot",
				resolvedSymbol: "ARB-USDT",
			},
			{
				objects: [
					{
						identity: "okx_spot/object.parquet.zst",
						checksum: "a".repeat(64),
						bytes: 123,
						rows: 2,
					},
				],
				rows: [{ licensed: secret }],
				vendorSemanticDigest: "b".repeat(64),
			},
		);
		expect(evidence).not.toHaveProperty("rows");
		expect(JSON.stringify(evidence)).not.toContain(secret);
	});

	test("is exposed only as an explicit opt-in package script", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		expect(
			packageJson.scripts["test:conformance:market-data-vendor-backfill"],
		).toBe("bun run scripts/market-data-vendor-backfill-conformance.ts");
	});
});
