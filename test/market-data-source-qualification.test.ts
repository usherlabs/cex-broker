import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	runMarketDataSourceQualification,
	type SourceQualificationAdapterFactory,
} from "../scripts/market-data-source-qualification";
import { buildCryptoHftDataConformanceDocuments } from "../scripts/market-data-vendor-backfill-conformance";
import {
	CryptoHftDataError,
	enumerateCryptoHftDataObjects,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import {
	CAPABILITY_POLICY,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";

const startTimeMs = Date.UTC(2026, 7, 18, 9, 27, 15, 308);

function adapterFactory(
	input: { failure?: Error; tape?: unknown[] } = {},
): SourceQualificationAdapterFactory {
	return (observer, options) => ({
		capabilityFor: () => ({
			provider: "cryptohftdata",
			adapterVersion: "cryptohftdata-orderbook/v2",
			providerExchangeId: "okx_spot",
			resolvedSymbol: "ARB-USDT",
		}),
		acquire: async (request) => {
			const identities = enumerateCryptoHftDataObjects(
				request,
				"okx_spot",
				"ARB-USDT",
			);
			for (const identity of identities) {
				observer.observe({
					type: "provider_object_boundary",
					object: {
						identity,
						checksums: ["a".repeat(64)],
						attempt_count: 1,
						quarantined: false,
					},
				});
			}
			const targetTime = request.requiredClockTargetsMs[0] as number;
			if (input.failure) {
				observer.observe({
					type: "required_clock_sample",
					target_time_ms: targetTime,
					source_time_ms: targetTime - 60_000,
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
			observer.observe({
				type: "required_clock_sample",
				target_time_ms: targetTime,
				source_time_ms: targetTime - 1_000,
				lag_ms: 1_000,
				status: "covered",
				object: {
					identity: identities.at(-1) as string,
					checksums: ["a".repeat(64)],
					attempt_count: 1,
					quarantined: false,
				},
			});
			if (options?.policyNeutralTapeSink) {
				await options.policyNeutralTapeSink.writeBatch(input.tape ?? []);
				await options.policyNeutralTapeSink.complete({
					expectedObjectIdentities: identities,
					observedObjects: identities.map((identity) => ({
						identity,
						checksum: "a".repeat(64),
						bytes: 1,
						rows: 1,
					})),
					stateCount: input.tape?.length ?? 0,
				});
			}
			return {};
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
				inspectSourceObject: async () => ({
					checksum: "a".repeat(64),
					schemaValid: true,
					sequenceValid: true,
					missingRows: false,
					completeSnapshotDefect: false,
					alternateOrderingClosesGap: false,
					staleWithValidPriorState: true,
				}),
			});
			expect(result.sourceAccepted).toBe(false);
			expect(result.failureReason).toBe("required_clock_coverage_insufficient");
			expect(result.qualification.qualified).toBe(false);
			expect(result.qualification.derivation_eligible).toBe(true);
			expect(result.qualification.candidate_c_source_enumeration_eligible).toBe(
				true,
			);
			expect(result.ledger.summary.affected_target_count).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("streams a full-window tape only after strict bootstrap and enumeration gates pass", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-qualification-"));
		const tape = [{ tapeState: "initialization", sourceTimeMs: startTimeMs }];
		try {
			const bootstrap = await runMarketDataSourceQualification({
				documents: buildCryptoHftDataConformanceDocuments(startTimeMs),
				outputDirectory: root,
				createdAt: "2026-08-25T11:59:00.000Z",
				apiKey: "qualification-provider-secret",
				ledgerFileName: "bootstrap-ledger.json",
				qualificationFileName: "bootstrap-qualification.json",
				adapterFactory: adapterFactory(),
			});
			const batches: unknown[][] = [];
			let completed = false;
			const result = await runMarketDataSourceQualification({
				documents: buildCryptoHftDataConformanceDocuments(startTimeMs),
				outputDirectory: root,
				createdAt: "2026-08-25T12:00:00.000Z",
				apiKey: "qualification-provider-secret",
				adapterFactory: adapterFactory({ tape }),
				bootstrapQualification: bootstrap.qualification,
				candidateCInputTapeSink: {
					async writeBatch(states) {
						batches.push([...states]);
					},
					async complete() {
						completed = true;
					},
					async abort() {},
				},
			});
			expect(result.qualification.qualified).toBe(true);
			expect(result.qualification.candidate_c_source_enumeration_eligible).toBe(
				true,
			);
			expect(result.candidateCInputTapeEligible).toBe(true);
			expect(batches).toEqual([tape]);
			expect(completed).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
