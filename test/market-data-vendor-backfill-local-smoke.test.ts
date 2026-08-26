import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_SCHEMA_VERSION,
	type MarketDataVendorBackfillSmokeRuntime,
	parseMarketDataVendorBackfillSmokeConfiguration,
	runMarketDataVendorBackfillLocalSmoke,
	writeMarketDataVendorBackfillSmokeEvidence,
} from "../scripts/market-data-vendor-backfill-local-smoke";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import type { BackfillDomainOutcome } from "../src/helpers/market-data-vendor-backfill/core";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

const receipt = CONFORMANCE_FIXTURES.documents.promotion_receipt;

function promotedResult(): BackfillDomainOutcome {
	return {
		status: "promoted",
		reasonCode: "promotion_qualified",
		receipt,
		selection: CONFORMANCE_FIXTURES.documents.archive_selection,
	};
}

function archiveInspection() {
	return {
		candidateLevelRows: 40,
		candidateSummaryRows: 1,
		qualifiedLevelRows: 40,
		qualifiedSummaryRows: 1,
		promotionRows: 1,
		promotionReceiptIds: [receipt.receipt_id],
		coverageComplete: true,
		coverageDigest: "3".repeat(64),
		prefixDigest: "4".repeat(64),
		suffixDigest: "5".repeat(64),
	};
}

function smokeRuntime(input: {
	secret: string;
	firstResult?: BackfillDomainOutcome;
	secondStatus?: BackfillDomainOutcome["status"];
	throwMessage?: string;
	onCleanup: () => void;
}): MarketDataVendorBackfillSmokeRuntime {
	let invocation = 0;
	return {
		clickhouse: {
			image:
				"clickhouse/clickhouse-server:24.8.14.39@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b",
			imageId:
				"sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b",
			version: "24.8.14.39",
		},
		async run(documents, apiKey) {
			expect(documents.request.window.start_at).toBe(
				"2026-08-18T09:27:15.308Z",
			);
			expect(documents.request.scope).toMatchObject({
				exchange: "okx",
				trading_pair: "ARB-USDT",
				market_type: "spot",
			});
			expect(apiKey).toBe(input.secret);
			if (input.throwMessage) throw new Error(input.throwMessage);
			invocation += 1;
			if (invocation === 1) return input.firstResult ?? promotedResult();
			return {
				requestId: documents.request.request_id,
				idempotencyKey: documents.request.idempotency_key,
				status: input.secondStatus ?? "already_covered",
				reasonCode: "qualified_coverage_complete",
				selection: CONFORMANCE_FIXTURES.documents.archive_selection,
			};
		},
		async inspect() {
			return archiveInspection();
		},
		async exportQualified() {
			return {
				levelRows: 40,
				summaryRows: 1,
				promotionReceiptIds: [receipt.receipt_id],
				levelsSha256: "6".repeat(64),
				summarySha256: "7".repeat(64),
			};
		},
		async cleanup() {
			input.onCleanup();
		},
	};
}

describe("market-data vendor backfill local smoke", () => {
	test("requires explicit opt-in, an API key, and a safe positive-control timestamp", () => {
		expect(() => parseMarketDataVendorBackfillSmokeConfiguration({})).toThrow(
			"market_data_vendor_backfill_smoke_not_enabled",
		);
		expect(() =>
			parseMarketDataVendorBackfillSmokeConfiguration({
				MARKET_DATA_VENDOR_BACKFILL_SMOKE_ENABLED: "1",
				CRYPTOHFTDATA_API_KEY: "secret",
			}),
		).toThrow("market_data_vendor_backfill_smoke_start_invalid");
		expect(() =>
			parseMarketDataVendorBackfillSmokeConfiguration({
				MARKET_DATA_VENDOR_BACKFILL_SMOKE_ENABLED: "1",
				MARKET_DATA_VENDOR_BACKFILL_SMOKE_START_MS: "1787045235308",
			}),
		).toThrow("cryptohftdata_api_key_missing");

		expect(
			parseMarketDataVendorBackfillSmokeConfiguration({
				MARKET_DATA_VENDOR_BACKFILL_SMOKE_ENABLED: "1",
				MARKET_DATA_VENDOR_BACKFILL_SMOKE_START_MS: "1787045235308",
				CRYPTOHFTDATA_API_KEY: "secret",
			}),
		).toEqual({
			startTimeMs: 1_787_045_235_308,
			apiKey: "secret",
		});
	});

	test("proves promotion, qualified export, and an idempotent second invocation", async () => {
		const secret = "vault-only-provider-secret";
		let cleaned = false;
		const evidence = await runMarketDataVendorBackfillLocalSmoke(
			{ startTimeMs: 1_787_045_235_308, apiKey: secret },
			{
				createRuntime: async (documents) => {
					expect(documents.request.schema_id).toBe(
						"https://schemas.usher.so/market-data-vendor-backfill-request/v1",
					);
					expect(documents.requiredClock.clock_sha256).toBe(
						documents.request.required_clock.clock_sha256,
					);
					return smokeRuntime({
						secret,
						onCleanup: () => (cleaned = true),
					});
				},
				nowMs: (() => {
					let value = 1_751_364_700_000;
					return () => value++;
				})(),
				sourceIdentity: async () => ({
					gitCommit: "8".repeat(40),
					gitDirty: false,
					packageVersion: "1.2.3",
				}),
			},
		);

		expect(evidence).toMatchObject({
			schemaVersion: MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_SCHEMA_VERSION,
			status: "passed",
			firstResult: { status: "promoted", reasonCode: "promotion_qualified" },
			secondResult: {
				status: "already_covered",
				reasonCode: "qualified_coverage_complete",
			},
			archive: {
				candidateLevelRows: 40,
				qualifiedLevelRows: 40,
				promotionRows: 1,
			},
			export: { levelRows: 40, summaryRows: 1 },
		});
		expect(cleaned).toBe(true);
		expect(JSON.stringify(evidence)).not.toContain(secret);
	});

	test("fails closed and still cleans up without reflecting an exception or credential", async () => {
		const secret = "never-reflect-this-provider-secret";
		let cleaned = false;
		const evidence = await runMarketDataVendorBackfillLocalSmoke(
			{ startTimeMs: 1_787_045_235_308, apiKey: secret },
			{
				createRuntime: async () =>
					smokeRuntime({
						secret,
						throwMessage: `download exposed ${secret}`,
						onCleanup: () => (cleaned = true),
					}),
				nowMs: () => 1_751_364_700_000,
				sourceIdentity: async () => ({
					gitCommit: "8".repeat(40),
					gitDirty: true,
					packageVersion: "1.2.3",
				}),
			},
		);

		expect(evidence).toMatchObject({
			status: "failed",
			phase: "first_run",
			reasonCode: "unexpected_smoke_failure",
		});
		expect(cleaned).toBe(true);
		expect(JSON.stringify(evidence)).not.toContain(secret);
		expect(JSON.stringify(evidence)).not.toContain("download exposed");
	});

	test("retains a closed provider subreason without retaining diagnostics", async () => {
		const evidence = await runMarketDataVendorBackfillLocalSmoke(
			{
				startTimeMs: 1_787_045_235_308,
				apiKey: "vault-only-provider-secret",
			},
			{
				createRuntime: async () =>
					smokeRuntime({
						secret: "vault-only-provider-secret",
						firstResult: {
							status: "vendor_fetch_failed",
							reasonCode: "vendor_fetch_failed",
							reasonSubcode: "update_chain_gap",
							diagnostics: { unsafe: "not-retained" },
						},
						onCleanup: () => {},
					}),
				nowMs: (() => {
					let value = 1_751_364_700_000;
					return () => value++;
				})(),
				sourceIdentity: async () => ({
					gitCommit: "8".repeat(40),
					gitDirty: true,
					packageVersion: "1.2.3",
				}),
			},
		);

		expect(evidence).toMatchObject({
			status: "failed",
			phase: "first_run",
			firstResult: {
				status: "vendor_fetch_failed",
				reasonCode: "vendor_fetch_failed",
				reasonSubcode: "update_chain_gap",
			},
		});
		expect(JSON.stringify(evidence)).not.toContain("not-retained");
	});

	test("atomically writes evidence with owner-only permissions", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "market-data-vendor-backfill-smoke-test-"),
		);
		temporaryDirectories.push(directory);
		const evidencePath = join(directory, "evidence.json");
		const evidence = {
			schemaVersion: MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_SCHEMA_VERSION,
			status: "failed" as const,
			startedAtMs: 1,
			completedAtMs: 2,
			durationMs: 1,
			phase: "configuration" as const,
			reasonCode: "configuration_invalid",
		};

		await writeMarketDataVendorBackfillSmokeEvidence(evidencePath, evidence);

		expect(JSON.parse(await readFile(evidencePath, "utf8"))).toEqual(evidence);
		expect((await stat(evidencePath)).mode & 0o777).toBe(0o600);
		expect((await readFile(evidencePath, "utf8")).endsWith("\n")).toBe(true);
	});

	test("exposes a manual-only protected workflow and local package command", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		);
		expect(packageJson.scripts["test:smoke:market-data-vendor-backfill"]).toBe(
			"bun run scripts/market-data-vendor-backfill-local-smoke.ts",
		);

		const workflow = await readFile(
			new URL(
				"../.github/workflows/market-data-vendor-backfill-smoke.yml",
				import.meta.url,
			),
			"utf8",
		);
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toContain(
			"environment: market-data-vendor-backfill-smoke",
		);
		expect(workflow).toContain("secrets.CRYPTOHFTDATA_API_KEY");
		expect(workflow).toContain(
			"vars.MARKET_DATA_VENDOR_BACKFILL_SMOKE_START_MS",
		);
		expect(workflow).toContain("if: always()");
		expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m);
	});
});
