import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	runMarketDataSourceQualification,
	type SourceQualificationAdapterFactory,
} from "../scripts/market-data-source-qualification";
import { buildCryptoHftDataConformanceDocuments } from "../scripts/market-data-vendor-backfill-conformance";
import { CryptoHftDataError } from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import {
	CAPABILITY_POLICY,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";

const startTimeMs = Date.UTC(2026, 7, 18, 9, 27, 15, 308);

function adapterFactory(
	input: { failure?: Error } = {},
): SourceQualificationAdapterFactory {
	return (observer) => ({
		capabilityFor: () => ({
			provider: "cryptohftdata",
			adapterVersion: "cryptohftdata-orderbook/v2",
			providerExchangeId: "okx_spot",
			resolvedSymbol: "ARB-USDT",
		}),
		acquire: async (request) => {
			if (input.failure) {
				observer.observe({
					type: "required_clock_sample",
					target_time_ms: request.requiredClockTargetsMs[0] as number,
					source_time_ms: startTimeMs,
					lag_ms: 60_000,
					status: "stale",
					object: {
						identity: "okx_spot/2026-08-18/09/ARB-USDT_orderbook.parquet.zst",
						checksums: ["a".repeat(64)],
						attempt_count: 1,
						quarantined: false,
					},
				});
				throw input.failure;
			}
		},
	});
}

describe("market-data source qualification harness", () => {
	test("commits content-addressed secret-free evidence from the current reconstruction path", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-qualification-"));
		const plantedSecret = "qualification-provider-secret";
		try {
			const result = await runMarketDataSourceQualification({
				documents: buildCryptoHftDataConformanceDocuments(startTimeMs),
				outputDirectory: root,
				createdAt: "2026-08-25T12:00:00.000Z",
				apiKey: plantedSecret,
				adapterFactory: adapterFactory(),
			});
			expect(result.sourceAccepted).toBe(true);
			expect(result.failureReason).toBeNull();
			expect(result.qualification.qualified).toBe(true);
			expect(result.ledger.effective_policies).toMatchObject({
				capability_policy: {
					policy_id: CAPABILITY_POLICY.policy_id,
					policy_sha256: CAPABILITY_POLICY.policy_sha256,
				},
				resource_policy: {
					policy_id: RESOURCE_POLICY.policy_id,
					policy_sha256: RESOURCE_POLICY.policy_sha256,
				},
			});
			for (const fileName of [
				"arb-usdt-source-forensics.json",
				"arb-usdt-source-qualification.json",
			]) {
				expect(await readFile(path.join(root, fileName), "utf8")).not.toContain(
					plantedSecret,
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("retains a failed ledger and exposes only the stable provider reason", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-qualification-"));
		try {
			const result = await runMarketDataSourceQualification({
				documents: buildCryptoHftDataConformanceDocuments(startTimeMs),
				outputDirectory: root,
				createdAt: "2026-08-25T12:00:00.000Z",
				apiKey: "qualification-provider-secret",
				adapterFactory: adapterFactory({
					failure: new CryptoHftDataError(
						"required_clock_coverage_insufficient",
					),
				}),
			});
			expect(result.sourceAccepted).toBe(false);
			expect(result.failureReason).toBe("required_clock_coverage_insufficient");
			expect(result.qualification.qualified).toBe(false);
			expect(result.ledger.summary.affected_target_count).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
