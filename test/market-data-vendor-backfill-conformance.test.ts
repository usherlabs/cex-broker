import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	buildCryptoHftDataConformanceDocuments,
	buildCryptoHftDataConformanceRequest,
	toHashOnlyConformanceEvidence,
} from "../scripts/market-data-vendor-backfill-conformance";
import {
	backfillRequestCodec,
	requiredClockCodec,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import { enumerateCryptoHftDataObjects } from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import {
	CAPABILITY_POLICY,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";

describe("market-data vendor backfill provider conformance harness", () => {
	test("builds one explicitly enabled, bounded proven-profile request", () => {
		const startTimeMs = Date.UTC(2026, 7, 18, 9, 27, 15, 308);
		const documents = buildCryptoHftDataConformanceDocuments(startTimeMs);
		const request = buildCryptoHftDataConformanceRequest(startTimeMs);
		expect(backfillRequestCodec.is(documents.request)).toBe(true);
		expect(requiredClockCodec.is(documents.requiredClock)).toBe(true);
		expect(documents.request).toMatchObject({
			scope: {
				exchange: "okx",
				trading_pair: "ARB-USDT",
				market_type: "spot",
			},
			coverage_policy: {
				policy_id: "prior-asof-strict/v1",
				max_asof_lag_ms: 60_000,
				future_rows: "reject",
				missing_required_event: "fail",
			},
			product_pins: {
				capability_policy: {
					policy_id: CAPABILITY_POLICY.policy_id,
					policy_sha256: CAPABILITY_POLICY.policy_sha256,
				},
				resource_policy: {
					policy_id: RESOURCE_POLICY.policy_id,
					policy_sha256: RESOURCE_POLICY.policy_sha256,
				},
			},
		});
		expect(documents.request).not.toHaveProperty("provider");
		expect(documents.request).not.toHaveProperty("budgets");
		expect(request.scope).toMatchObject({
			exchange: "okx",
			tradingPair: "ARB-USDT",
			sourceSymbol: "ARB-USDT",
			marketType: "spot",
		});
		expect(request.budgets).toMatchObject({
			maxFiles: RESOURCE_POLICY.limits.max_files,
			maxBoundaryLookbackMs:
				CAPABILITY_POLICY.acquisition_policy.initialization_lookback_ms,
		});
		expect(request.budgets.maxBoundaryLookbackMs).toBeLessThanOrEqual(
			RESOURCE_POLICY.limits.max_boundary_lookback_ms,
		);
		expect(
			enumerateCryptoHftDataObjects(request, "okx_spot", "ARB-USDT"),
		).toEqual(["okx_spot/2026-08-18/09/ARB-USDT_orderbook.parquet.zst"]);
	});

	test("builds the independently pinned ARB-USDC conformance request", () => {
		const startTimeMs = Date.UTC(2026, 7, 18, 9, 27, 15, 308);
		const documents = buildCryptoHftDataConformanceDocuments(
			startTimeMs,
			"ARB-USDC",
		);
		const request = buildCryptoHftDataConformanceRequest(
			startTimeMs,
			"ARB-USDC",
		);
		expect(documents.request.scope.trading_pair).toBe("ARB-USDC");
		expect(request.scope).toMatchObject({
			tradingPair: "ARB-USDC",
			sourceSymbol: "ARB-USDC",
		});
		expect(
			enumerateCryptoHftDataObjects(request, "okx_spot", "ARB-USDC"),
		).toEqual(["okx_spot/2026-08-18/09/ARB-USDC_orderbook.parquet.zst"]);
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
