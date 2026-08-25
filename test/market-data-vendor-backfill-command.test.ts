import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	createBackfillDependenciesFromEnv,
	runMarketDataVendorBackfillFileJob,
} from "../src/commands/market-data-vendor-backfill";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import type { BackfillDependencies } from "../src/helpers/market-data-vendor-backfill/core";
import { CryptoHftDataError } from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import {
	LEGACY_CAPABILITY_POLICY,
	LEGACY_RESOURCE_POLICY,
	PREVIOUS_CAPABILITY_POLICY,
} from "../src/helpers/market-data-vendor-backfill/legacy-manifests";
import {
	CAPABILITY_POLICY,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";

const NOW_MS = Date.parse("2026-08-20T12:00:03.000Z");
const RELEASE = {
	packageVersion: "0.2.47",
	gitHead: "a".repeat(40),
};

async function createAttempt(
	request: string | object = CONFORMANCE_FIXTURES.documents.request,
) {
	const root = await mkdtemp(path.join(os.tmpdir(), "cex-backfill-command-"));
	const requestPath = path.join(root, "request.json");
	const resultPath = path.join(root, "result.json");
	const executablePath = path.join(root, "market-data-vendor-backfill.js");
	await writeFile(
		requestPath,
		typeof request === "string" ? request : JSON.stringify(request),
	);
	await writeFile(
		path.join(root, "required-clock.json"),
		JSON.stringify(CONFORMANCE_FIXTURES.documents.required_clock),
	);
	await writeFile(executablePath, "test executable bytes");
	return { root, requestPath, resultPath, executablePath };
}

function alreadyCoveredDependencies(): BackfillDependencies {
	return {
		archive: {
			async resolveSelection() {
				return {
					selection: CONFORMANCE_FIXTURES.documents.archive_selection,
					receipts: [CONFORMANCE_FIXTURES.documents.promotion_receipt],
					readerIdentity: {
						environment: "production",
						cluster: "cex-archive-primary",
					},
				};
			},
			async verifyCandidate() {
				throw new Error("must not verify an already-covered request");
			},
		},
		providers: {
			capabilityFor() {
				throw new Error("must not probe provider capability");
			},
			async acquire() {
				throw new Error("must not acquire vendor data");
			},
			async normalize() {
				throw new Error("must not normalize vendor data");
			},
		},
		credentials: {
			async resolve() {
				throw new Error("must not resolve vendor credentials");
			},
		},
		forwarder: {
			async preflight(input) {
				return {
					forwarderIdentity: input.target,
					authorization: {
						authorizationId: input.authorizationId,
						scope: "production",
						environment: input.target.environment,
						cluster: input.target.cluster,
						expiresAt: "2026-08-20T13:00:00.000Z",
						credentialValidated: true,
					},
				};
			},
			async submit() {
				throw new Error("must not submit already-covered data");
			},
		},
		clock: { nowMs: () => NOW_MS },
	};
}

function requestWithCurrentPolicies() {
	const request = structuredClone(CONFORMANCE_FIXTURES.documents.request);
	request.product_pins = {
		capability_policy: {
			policy_id: CAPABILITY_POLICY.policy_id,
			policy_sha256: CAPABILITY_POLICY.policy_sha256,
		},
		resource_policy: {
			policy_id: RESOURCE_POLICY.policy_id,
			policy_sha256: RESOURCE_POLICY.policy_sha256,
		},
	};
	return request;
}

function failingProviderDependencies(
	error: CryptoHftDataError,
): BackfillDependencies {
	return {
		archive: {
			async resolveSelection() {
				return {
					selection: CONFORMANCE_FIXTURES.documents.request.initial_selection,
					receipts: [],
					readerIdentity: {
						environment: "production",
						cluster: "cex-archive-primary",
					},
				};
			},
			async verifyCandidate() {
				throw new Error("must not verify a failed provider acquisition");
			},
		},
		providers: {
			capabilityFor() {
				return {
					provider: "cryptohftdata",
					adapterVersion: "cryptohftdata-orderbook/v2",
					providerExchangeId: "okx_spot",
					resolvedSymbol: "ARB-USDT",
				};
			},
			async acquire() {
				throw error;
			},
			async normalize() {
				throw new Error("must not normalize a failed provider acquisition");
			},
		},
		credentials: {
			async resolve() {
				return { token: "available" };
			},
		},
		forwarder: {
			async preflight(input) {
				return {
					forwarderIdentity: input.target,
					authorization: {
						authorizationId: input.authorizationId,
						scope: "production",
						environment: input.target.environment,
						cluster: input.target.cluster,
						expiresAt: "2026-08-20T13:00:00.000Z",
						credentialValidated: true,
					},
				};
			},
			async submit() {
				throw new Error("must not submit a failed provider acquisition");
			},
		},
		clock: { nowMs: () => NOW_MS },
	};
}

describe("market-data-vendor-backfill command", () => {
	test("writes a CEX-owned v2 already-covered result with its self hash", async () => {
		const attempt = await createAttempt();
		try {
			const result = await runMarketDataVendorBackfillFileJob({
				...attempt,
				release: RELEASE,
				dependencies: alreadyCoveredDependencies(),
				nowMs: () => NOW_MS,
				randomUuid: () => "018f0f4d-7b32-7a30-8f4d-1d2a6e40f120",
			});
			expect(result.outcome.status).toBe("already_covered");
			expect(result.producer).toEqual({
				product_id: "market-data-vendor-backfill",
				product_version: "market-data-vendor-backfill/v1",
				package: {
					name: "@usherlabs/cex-broker",
					version: "0.2.47",
					git_head: RELEASE.gitHead,
				},
				executable_sha256: createHash("sha256")
					.update("test executable bytes")
					.digest("hex"),
				runtime: { name: "node", version: process.versions.node },
			});
			const onDisk = JSON.parse(await readFile(attempt.resultPath, "utf8"));
			expect(onDisk.result_sha256).toBe(result.result_sha256);
			expect(JSON.stringify(onDisk)).not.toContain("fiet_tee_commit");
		} finally {
			await rm(attempt.root, { recursive: true, force: true });
		}
	});

	test("invalid JSON is handled before dependency construction", async () => {
		const attempt = await createAttempt("{not-json\n");
		try {
			let dependencyConstructions = 0;
			const result = await runMarketDataVendorBackfillFileJob({
				...attempt,
				release: RELEASE,
				createDependencies() {
					dependencyConstructions += 1;
					return alreadyCoveredDependencies();
				},
			});
			expect(result.outcome.status).toBe("request_invalid");
			expect(result.request_file_sha256).toBe(
				createHash("sha256").update("{not-json\n").digest("hex"),
			);
			expect(dependencyConstructions).toBe(0);
		} finally {
			await rm(attempt.root, { recursive: true, force: true });
		}
	});

	test.each([
		{
			name: "capability v1 with resource v1",
			capability: LEGACY_CAPABILITY_POLICY,
			resource: LEGACY_RESOURCE_POLICY,
		},
		{
			name: "capability v2 with resource v2",
			capability: PREVIOUS_CAPABILITY_POLICY,
			resource: RESOURCE_POLICY,
		},
		{
			name: "capability v3 with resource v1",
			capability: CAPABILITY_POLICY,
			resource: LEGACY_RESOURCE_POLICY,
		},
	] as const)("rejects $name before constructing dependencies", async ({
		capability,
		resource,
	}) => {
		const request = requestWithCurrentPolicies();
		request.product_pins = {
			capability_policy: {
				policy_id: capability.policy_id,
				policy_sha256: capability.policy_sha256,
			},
			resource_policy: {
				policy_id: resource.policy_id,
				policy_sha256: resource.policy_sha256,
			},
		};
		const attempt = await createAttempt(request);
		let dependencyConstructions = 0;
		try {
			const result = await runMarketDataVendorBackfillFileJob({
				...attempt,
				release: RELEASE,
				createDependencies() {
					dependencyConstructions += 1;
					return alreadyCoveredDependencies();
				},
			});
			expect(result.outcome.status).toBe("request_invalid");
			expect(result.outcome.reason_subcode).toBe(
				"current_policy_tuple_required",
			);
			expect(dependencyConstructions).toBe(0);
		} finally {
			await rm(attempt.root, { recursive: true, force: true });
		}
	});

	test.each([
		{
			name: "sequence",
			reason: "update_chain_gap",
			diagnostics: {
				sequence_gap_count: 2,
				first_sequence_gap_event_time_ms: 1_700_000_000_000,
				last_sequence_gap_event_time_ms: 1_700_000_001_000,
				event_time_ms: 1_700_000_000_000,
				expected_previous_sequence: "200",
				observed_previous_sequence: "199",
				observed_final_sequence: "201",
			},
		},
		{
			name: "provider object",
			reason: "provider_object_corrupt",
			diagnostics: {
				dataset_object_identity:
					"okx_spot/2026-08-20/12/ARB-USDT_orderbook.parquet.zst",
				dataset_object_checksum: "d".repeat(64),
				failure_phase: "decode",
				attempt_count: 3,
				quarantined: true,
				provider_response_body: "reflected-secret",
			},
		},
		{
			name: "required clock",
			reason: "required_clock_coverage_insufficient",
			diagnostics: {
				total_target_count: 2,
				covered_target_count: 1,
				missing_target_count: 1,
				unanchored_target_count: 1,
				future_state_target_count: 0,
				max_prior_asof_lag_ms: 5_000,
				covered_target_count_lag_1000_ms: 0,
				covered_target_count_lag_2000_ms: 0,
				covered_target_count_lag_5000_ms: 1,
				covered_target_count_lag_10000_ms: 1,
				covered_target_count_lag_30000_ms: 1,
				covered_target_count_lag_60000_ms: 1,
			},
		},
	] as const)("commits a safe result-v2 projection for a $name failure", async ({
		reason,
		diagnostics,
	}) => {
		const attempt = await createAttempt(requestWithCurrentPolicies());
		try {
			const result = await runMarketDataVendorBackfillFileJob({
				...attempt,
				release: RELEASE,
				createDependencies(sensitiveValues) {
					sensitiveValues.add("reflected-secret");
					return failingProviderDependencies(
						new CryptoHftDataError(reason, diagnostics),
					);
				},
				nowMs: () => NOW_MS,
				randomUuid: () => "018f0f4d-7b32-7a30-8f4d-1d2a6e40f120",
			});
			expect(result.schema_id).toBe(
				"https://schemas.usher.so/market-data-vendor-backfill-result/v2",
			);
			expect(result.outcome).toMatchObject({
				status: "vendor_fetch_failed",
				reason_subcode: reason,
			});
			expect(result.producer.package.git_head).toBe(RELEASE.gitHead);
			expect(result.capability_policy.policy_id).toBe(
				CAPABILITY_POLICY.policy_id,
			);
			expect(result.resource_policy.policy_id).toBe(RESOURCE_POLICY.policy_id);
			expect(
				Object.keys(result.outcome.diagnostics).length,
			).toBeLessThanOrEqual(64);
			expect(result.outcome.diagnostics).not.toHaveProperty(
				"provider_response_body",
			);
			expect(JSON.stringify(result)).not.toContain("reflected-secret");
		} finally {
			await rm(attempt.root, { recursive: true, force: true });
		}
	});

	test("environment construction uses a closed allowlist and resolves vendor credentials lazily", async () => {
		const accessed = new Set<string>();
		const values: Record<string, string> = {
			CLICKHOUSE_URL: "http://clickhouse.test",
			CLICKHOUSE_USER: "archive-user",
			CLICKHOUSE_PASSWORD: "archive-password",
			CEX_BROKER_ARCHIVE_FORWARDER_URL: "http://forwarder.test",
			CEX_BROKER_ARCHIVE_FORWARDER_TOKEN: "forwarder-token",
			CRYPTOHFTDATA_API_KEY: "vendor-key",
			VAULT_TOKEN: "must-not-read",
			ATTEST_URL: "must-not-read",
		};
		const environment = new Proxy(values, {
			get(target, property, receiver) {
				if (typeof property === "string") accessed.add(property);
				return Reflect.get(target, property, receiver);
			},
		});
		const sensitiveValues = new Set<string>();
		const dependencies = createBackfillDependenciesFromEnv(
			environment,
			sensitiveValues,
		);
		expect(accessed.has("CRYPTOHFTDATA_API_KEY")).toBe(false);
		expect(accessed.has("VAULT_TOKEN")).toBe(false);
		expect(await dependencies.credentials.resolve("cryptohftdata")).toEqual({
			apiKey: "vendor-key",
		});
		expect(sensitiveValues).toEqual(
			new Set(["archive-password", "forwarder-token", "vendor-key"]),
		);
		expect(accessed.has("VAULT_TOKEN")).toBe(false);
		expect(accessed.has("ATTEST_URL")).toBe(false);
	});
});
