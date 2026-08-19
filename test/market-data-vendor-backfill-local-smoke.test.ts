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
import type { BackfillResult } from "../src/helpers/market-data-vendor-backfill/contracts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

function promotedResult(): BackfillResult {
	return {
		schemaVersion: "market-data-vendor-backfill-result/v1",
		requestId: "cryptohftdata-conformance-1751364600000",
		idempotencyKey: "a".repeat(64),
		status: "promoted",
		reasonCode: "promotion_committed",
		receipt: {
			schemaVersion: "market-data-vendor-backfill-promotion-receipt/v1",
			requestId: "cryptohftdata-conformance-1751364600000",
			idempotencyKey: "a".repeat(64),
			status: "passing",
			source: "external_backfill",
			provider: "cryptohftdata",
			adapterVersion: "cryptohftdata-orderbook/v1",
			captureBundleId: "b".repeat(64),
			exchange: "binance",
			tradingPair: "BTC-USDT",
			marketType: "spot",
			feed: "ORDERBOOK",
			startTimeMs: 1_751_364_600_000,
			endTimeMs: 1_751_364_660_000,
			depth: 20,
			constructionMode: "sampled_top_n_snapshot",
			canonicalSchemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
			vendorSemanticDigest: "c".repeat(64),
			canonicalSemanticDigest: "d".repeat(64),
			prefixDigest: "e".repeat(64),
			suffixDigest: "f".repeat(64),
			seamVerified: true,
			coverageVerified: true,
			datasetObjects: [
				{
					identity: "binance_spot/2025-07-01/10/BTCUSDT_orderbook.parquet.zst",
					checksum: "1".repeat(64),
					bytes: 123,
					rows: 456,
				},
			],
			verificationTimeMs: 1_751_364_700_000,
			receiptId: "2".repeat(64),
		},
	};
}

function archiveInspection() {
	return {
		candidateLevelRows: 40,
		candidateSummaryRows: 1,
		qualifiedLevelRows: 40,
		qualifiedSummaryRows: 1,
		promotionRows: 1,
		promotionReceiptIds: ["2".repeat(64)],
		coverageComplete: true,
		coverageDigest: "3".repeat(64),
		prefixDigest: "4".repeat(64),
		suffixDigest: "5".repeat(64),
	};
}

function smokeRuntime(input: {
	secret: string;
	secondStatus?: BackfillResult["status"];
	throwMessage?: string;
	onCleanup: () => void;
}): MarketDataVendorBackfillSmokeRuntime {
	let invocation = 0;
	return {
		clickhouse: {
			image: "clickhouse/clickhouse-server:24.8",
			imageId: "sha256:clickhouse-image",
			version: "24.8.14.39",
		},
		async run(request, apiKey) {
			expect(request.window.startTimeMs).toBe(1_751_364_600_000);
			expect(apiKey).toBe(input.secret);
			if (input.throwMessage) throw new Error(input.throwMessage);
			invocation += 1;
			if (invocation === 1) return promotedResult();
			return {
				schemaVersion: "market-data-vendor-backfill-result/v1",
				requestId: request.requestId,
				idempotencyKey: request.idempotencyKey,
				status: input.secondStatus ?? "already_covered",
				reasonCode: "qualified_coverage_complete",
			};
		},
		async inspect() {
			return archiveInspection();
		},
		async exportQualified() {
			return {
				levelRows: 40,
				summaryRows: 1,
				promotionReceiptIds: ["2".repeat(64)],
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
				MARKET_DATA_VENDOR_BACKFILL_SMOKE_START_MS: "1751364600000",
			}),
		).toThrow("cryptohftdata_api_key_missing");

		expect(
			parseMarketDataVendorBackfillSmokeConfiguration({
				MARKET_DATA_VENDOR_BACKFILL_SMOKE_ENABLED: "1",
				MARKET_DATA_VENDOR_BACKFILL_SMOKE_START_MS: "1751364600000",
				CRYPTOHFTDATA_API_KEY: "secret",
			}),
		).toEqual({
			startTimeMs: 1_751_364_600_000,
			apiKey: "secret",
		});
	});

	test("proves promotion, qualified export, and an idempotent second invocation", async () => {
		const secret = "vault-only-provider-secret";
		let cleaned = false;
		const evidence = await runMarketDataVendorBackfillLocalSmoke(
			{ startTimeMs: 1_751_364_600_000, apiKey: secret },
			{
				createRuntime: async () =>
					smokeRuntime({ secret, onCleanup: () => (cleaned = true) }),
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
			firstResult: { status: "promoted", reasonCode: "promotion_committed" },
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
			{ startTimeMs: 1_751_364_600_000, apiKey: secret },
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
