import { describe, expect, test } from "bun:test";
import { sha256Canonical } from "../src/helpers/market-data-archive/capture-contract";
import {
	type BackfillDependencies,
	runMarketDataVendorBackfill,
} from "../src/helpers/market-data-vendor-backfill/core";
import { CryptoHftDataError } from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import { validBackfillRequest } from "./market-data-vendor-backfill-contract.test";

function dependencies(
	overrides: Partial<BackfillDependencies> = {},
): BackfillDependencies & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		archive: {
			coverage: async () => {
				calls.push("coverage");
				return { complete: false, coverageDigest: "before" };
			},
			verifyCandidate: async (_request, normalized, captureBundleId) => {
				calls.push("verify");
				return {
					passed: true,
					captureBundleId,
					canonicalSemanticDigest: normalized.canonicalSemanticDigest,
					prefixDigest: "e".repeat(64),
					suffixDigest: "f".repeat(64),
					seamVerified: true,
					coverageVerified: true,
				};
			},
		},
		providers: {
			capabilityFor: () => {
				calls.push("capability");
				return {
					provider: "cryptohftdata",
					adapterVersion: "cryptohftdata-orderbook/v1",
					providerExchangeId: "binance-futures",
					resolvedSymbol: "BTCUSDT",
				};
			},
			acquire: async () => {
				calls.push("acquire");
				return {
					objects: [
						{
							identity: "binance/2023/11/14/22/BTCUSDT.parquet.zst",
							checksum: "a".repeat(64),
							bytes: 100,
							rows: 1,
						},
					],
					vendorSemanticDigest: "b".repeat(64),
					rows: [],
				};
			},
			normalize: async (_request, _capability, dataset, captureBundleId) => {
				calls.push("normalize");
				return {
					captureBundleId,
					objects: dataset.objects,
					rows: [
						{
							table: "market_data.cex_order_book_depth_summary",
							row: { normalized_row_checksum: "c".repeat(64) },
						},
					],
					canonicalSemanticDigest: "d".repeat(64),
					vendorSemanticDigest: dataset.vendorSemanticDigest,
				};
			},
		},
		credentials: {
			resolve: async () => {
				calls.push("credentials");
				return { token: "secret-value" };
			},
		},
		forwarder: {
			submit: async (batch) => {
				calls.push(
					batch.rows[0]?.table ===
						"market_data.cex_order_book_capture_promotions"
						? "promotion"
						: "candidate",
				);
				return { ok: true, inserted: batch.rows.length };
			},
		},
		clock: { nowMs: () => 1_800_000_000_000 },
		...overrides,
	};
}

describe("runMarketDataVendorBackfill", () => {
	test("validates before any dependency I/O", async () => {
		const deps = dependencies();
		const result = await runMarketDataVendorBackfill(
			{ ...validBackfillRequest(), idempotencyKey: "bad" },
			deps,
		);
		expect(result.status).toBe("capability_unsupported");
		expect(result.reasonCode).toBe("request_invalid");
		expect(deps.calls).toEqual([]);
	});

	test("returns already covered before capability or credentials", async () => {
		const deps = dependencies({
			archive: {
				coverage: async () => {
					deps.calls.push("coverage");
					return { complete: true, coverageDigest: "covered" };
				},
				verifyCandidate: async () => {
					throw new Error("must not verify");
				},
			},
		});
		const result = await runMarketDataVendorBackfill(
			validBackfillRequest(),
			deps,
		);
		expect(result.status).toBe("already_covered");
		expect(deps.calls).toEqual(["coverage"]);
	});

	test("checks capability before credentials", async () => {
		const deps = dependencies({
			providers: {
				capabilityFor: () => {
					deps.calls.push("capability");
					return undefined;
				},
				acquire: async () => {
					throw new Error("must not acquire");
				},
				normalize: async () => {
					throw new Error("must not normalize");
				},
			},
		});
		const result = await runMarketDataVendorBackfill(
			validBackfillRequest(),
			deps,
		);
		expect(result.status).toBe("capability_unsupported");
		expect(deps.calls).toEqual(["coverage", "capability"]);
	});

	test("submits candidates, verifies semantics, commits promotion last, and rechecks coverage", async () => {
		let coverageCalls = 0;
		const deps = dependencies();
		deps.archive.coverage = async () => {
			deps.calls.push("coverage");
			coverageCalls += 1;
			return {
				complete: coverageCalls === 2,
				coverageDigest: coverageCalls === 2 ? "after" : "before",
			};
		};
		const result = await runMarketDataVendorBackfill(
			validBackfillRequest(),
			deps,
		);
		expect(result.status).toBe("promoted");
		expect(result.receipt?.receiptId).toMatch(/^[a-f0-9]{64}$/);
		expect(deps.calls).toEqual([
			"coverage",
			"capability",
			"credentials",
			"acquire",
			"normalize",
			"candidate",
			"verify",
			"promotion",
			"coverage",
		]);
		expect(JSON.stringify(result)).not.toContain("secret-value");
		expect(result.receipt?.receiptId).toBe(
			sha256Canonical(
				result.receipt && {
					...result.receipt,
					receiptId: undefined,
					verificationTimeMs: undefined,
				},
			),
		);
	});

	test("retries the same deterministic batch identity after an ambiguous failure", async () => {
		let coverageCalls = 0;
		let submissionCalls = 0;
		const batchIds: string[] = [];
		const deps = dependencies();
		deps.archive.coverage = async () => ({
			complete: ++coverageCalls === 2,
			coverageDigest: "coverage",
		});
		deps.forwarder.submit = async (batch) => {
			batchIds.push(batch.batch_id);
			submissionCalls += 1;
			if (submissionCalls === 1) throw new Error("ambiguous transport failure");
			return { ok: true, inserted: batch.rows.length };
		};
		const result = await runMarketDataVendorBackfill(
			validBackfillRequest(),
			deps,
		);
		expect(result.status).toBe("promoted");
		expect(batchIds[0]).toBe(batchIds[1]);
		expect(new Set(batchIds).size).toBe(2);
	});

	test("never reflects dependency error text that may contain credentials", async () => {
		const secret = "provider-secret-from-response-body";
		const deps = dependencies();
		deps.providers.acquire = async () => {
			throw new Error(`provider rejected credential ${secret}`);
		};
		const result = await runMarketDataVendorBackfill(
			validBackfillRequest(),
			deps,
		);
		expect(result).toMatchObject({
			status: "vendor_fetch_failed",
			reasonCode: "provider_dataset_invalid",
		});
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	test("maps every terminal dependency gate to a closed status and stable reason", async () => {
		const missingCredentials = dependencies();
		missingCredentials.credentials.resolve = async () => undefined;
		expect(
			await runMarketDataVendorBackfill(
				validBackfillRequest(),
				missingCredentials,
			),
		).toMatchObject({
			status: "credentials_missing",
			reasonCode: "provider_credentials_missing",
		});

		const fetchFailed = dependencies();
		fetchFailed.providers.acquire = async () => {
			throw new CryptoHftDataError("budget_max_rows_exceeded");
		};
		expect(
			await runMarketDataVendorBackfill(validBackfillRequest(), fetchFailed),
		).toMatchObject({
			status: "vendor_fetch_failed",
			reasonCode: "budget_max_rows_exceeded",
		});

		const ingestFailed = dependencies({ retry: { maxAttempts: 1 } });
		ingestFailed.forwarder.submit = async () => ({ ok: false, inserted: 0 });
		expect(
			await runMarketDataVendorBackfill(validBackfillRequest(), ingestFailed),
		).toMatchObject({
			status: "archive_ingest_failed",
			reasonCode: "candidate_batch_rejected",
		});

		const verificationFailed = dependencies();
		verificationFailed.archive.verifyCandidate = async (
			_request,
			_normalized,
			captureBundleId,
		) => ({
			passed: false,
			captureBundleId,
			canonicalSemanticDigest: "d".repeat(64),
			prefixDigest: "e".repeat(64),
			suffixDigest: "f".repeat(64),
			seamVerified: false,
			coverageVerified: false,
			reasonCode: "timeline_seam_invalid",
		});
		expect(
			await runMarketDataVendorBackfill(
				validBackfillRequest(),
				verificationFailed,
			),
		).toMatchObject({
			status: "promotion_verification_failed",
			reasonCode: "timeline_seam_invalid",
		});

		let coverageCalls = 0;
		const coverageFailed = dependencies();
		coverageFailed.archive.coverage = async () => ({
			complete: false,
			coverageDigest: `coverage-${++coverageCalls}`,
		});
		expect(
			await runMarketDataVendorBackfill(validBackfillRequest(), coverageFailed),
		).toMatchObject({
			status: "post_backfill_coverage_insufficient",
			reasonCode: "qualified_coverage_incomplete",
		});
	});
});
