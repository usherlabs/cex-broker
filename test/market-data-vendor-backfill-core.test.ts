import { describe, expect, test } from "bun:test";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import type { PromotionReceiptWire } from "../src/helpers/market-data-vendor-backfill/contracts";
import type {
	ArchivePreflightResolution,
	BackfillDependencies,
} from "../src/helpers/market-data-vendor-backfill/core";
import { runMarketDataVendorBackfill } from "../src/helpers/market-data-vendor-backfill/core";
import { CryptoHftDataError } from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import { promotionReceiptFromArchiveRow } from "../src/helpers/market-data-vendor-backfill/promotion";
import { qualificationEventFromArchiveRow } from "../src/helpers/market-data-vendor-backfill/qualification";
import { resolveArchiveSelection } from "../src/helpers/market-data-vendor-backfill/selection";

const documents = {
	request: CONFORMANCE_FIXTURES.documents.request,
	requiredClock: CONFORMANCE_FIXTURES.documents.required_clock,
};

function preflight(
	overrides: Partial<ArchivePreflightResolution> = {},
): ArchivePreflightResolution {
	return {
		selection: CONFORMANCE_FIXTURES.documents.request.initial_selection,
		receipts: [],
		readerIdentity: {
			environment: "production",
			cluster: "cex-archive-primary",
		},
		...overrides,
	};
}

function dependencies(): BackfillDependencies & { calls: string[] } {
	const calls: string[] = [];
	let storedReceipt: PromotionReceiptWire | undefined;
	let qualification:
		| ReturnType<typeof qualificationEventFromArchiveRow>
		| undefined;
	return {
		calls,
		archive: {
			resolveSelection: async (request) => {
				calls.push("preflight");
				if (!storedReceipt || !qualification) return preflight();
				return preflight({
					selection: resolveArchiveSelection({
						request,
						bundles: [
							{
								captureBundleId: storedReceipt.capture_bundle_id,
								captureOrigin: "vendor_historical_backfill",
								startTimeMs: request.window.startTimeMs,
								endTimeMs: request.window.endTimeMs,
								qualification: {
									qualificationEventId: qualification.qualification_event_id,
									state: qualification.state,
									receiptId: qualification.receipt_id,
									promotionIdentitySha256:
										qualification.promotion_identity_sha256,
								},
								supportAnchors: request.requiredClockTargetsMs.map(
									(target, index) => ({
										captureBundleId: storedReceipt.capture_bundle_id,
										rawCaptureId: `${index + 1}`.repeat(64),
										snapshotId: `${index + 3}`.repeat(64),
										sourceTimeMs: target - 1,
										normalizedSummaryChecksum: `${index + 5}`.repeat(64),
									}),
								),
							},
						],
						resolvedAtMs: Date.parse("2026-08-20T12:00:02.000Z"),
					}),
					receipts: [storedReceipt],
				});
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
					adapterVersion: "cryptohftdata-orderbook/v2",
					providerExchangeId: "okx_spot",
					resolvedSymbol: "ARB-USDT",
				};
			},
			acquire: async () => {
				calls.push("acquire");
				return {
					objects: [
						{
							identity: "okx/2026/08/20/12/ARB-USDT.parquet.zst",
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
			preflight: async () => {
				calls.push("forwarder-preflight");
				return {
					forwarderIdentity: {
						environment: "production",
						cluster: "cex-archive-primary",
					},
					authorization: {
						authorizationId:
							CONFORMANCE_FIXTURES.documents.request
								.production_authorization_id,
						scope: "production",
						environment: "production",
						cluster: "cex-archive-primary",
						expiresAt: "2026-08-21T12:00:00.000Z",
						credentialValidated: true,
					},
				};
			},
			submit: async (batch) => {
				const entry = batch.rows[0];
				if (!entry) throw new Error("missing synthetic row");
				if (entry.table === "market_data.cex_order_book_capture_promotions") {
					calls.push("promotion");
					const parsed = promotionReceiptFromArchiveRow(entry.row);
					if (!("schema_id" in parsed))
						throw new Error("expected final receipt");
					storedReceipt = parsed;
				} else if (
					entry.table === "market_data.cex_order_book_capture_qualifications"
				) {
					calls.push("qualification");
					qualification = qualificationEventFromArchiveRow(entry.row);
				} else if (
					entry.table === "market_data.cex_order_book_archive_selections"
				) {
					calls.push("selection");
				} else {
					calls.push("candidate");
				}
				return { ok: true, inserted: batch.rows.length };
			},
		},
		clock: {
			nowMs: () => Date.parse("2026-08-20T12:00:02.000Z"),
		},
	};
}

describe("runMarketDataVendorBackfill final-v1 resilience", () => {
	test("validates before any dependency I/O", async () => {
		const deps = dependencies();
		const result = await runMarketDataVendorBackfill(
			{
				...documents,
				request: { ...documents.request, idempotency_key: "bad" },
			},
			deps,
		);
		expect(result).toMatchObject({
			status: "request_invalid",
			reasonCode: "request_invalid",
		});
		expect(deps.calls).toEqual([]);
	});

	test("returns already covered before capability or credentials", async () => {
		const deps = dependencies();
		deps.archive.resolveSelection = async () => {
			deps.calls.push("preflight");
			return preflight({
				selection: CONFORMANCE_FIXTURES.documents.archive_selection,
				receipts: [CONFORMANCE_FIXTURES.documents.promotion_receipt],
			});
		};
		const result = await runMarketDataVendorBackfill(documents, deps);
		expect(result.status).toBe("already_covered");
		expect(deps.calls).toEqual(["preflight", "forwarder-preflight"]);
	});

	test("checks capability before credentials", async () => {
		const deps = dependencies();
		deps.providers.capabilityFor = () => {
			deps.calls.push("capability");
			return undefined;
		};
		const result = await runMarketDataVendorBackfill(documents, deps);
		expect(result.status).toBe("capability_unsupported");
		expect(deps.calls).toEqual([
			"preflight",
			"forwarder-preflight",
			"capability",
		]);
	});

	test("submits candidates, receipt, qualification, and exact selection", async () => {
		const deps = dependencies();
		const result = await runMarketDataVendorBackfill(documents, deps);
		expect(result.status).toBe("promoted");
		expect(result.receipt?.receipt_id).toMatch(/^[a-f0-9]{64}$/);
		expect(result.selection?.receipt_ids).toEqual([result.receipt?.receipt_id]);
		expect(deps.calls).toEqual([
			"preflight",
			"forwarder-preflight",
			"capability",
			"credentials",
			"acquire",
			"normalize",
			"candidate",
			"verify",
			"promotion",
			"qualification",
			"preflight",
			"selection",
		]);
		expect(JSON.stringify(result)).not.toContain("secret-value");
	});

	test("retries the same deterministic batch identity after an ambiguous failure", async () => {
		const deps = dependencies();
		const submit = deps.forwarder.submit;
		const batchIds: string[] = [];
		let first = true;
		deps.forwarder.submit = async (batch) => {
			batchIds.push(batch.batch_id);
			if (first) {
				first = false;
				throw new Error("ambiguous transport failure");
			}
			return submit(batch);
		};
		const result = await runMarketDataVendorBackfill(documents, deps);
		expect(result.status).toBe("promoted");
		expect(batchIds[0]).toBe(batchIds[1]);
		expect(new Set(batchIds).size).toBe(4);
	});

	test("never reflects dependency error text that may contain credentials", async () => {
		const secret = "provider-secret-from-response-body";
		const deps = dependencies();
		deps.providers.acquire = async () => {
			throw new Error(`provider rejected credential ${secret}`);
		};
		const result = await runMarketDataVendorBackfill(documents, deps);
		expect(result).toMatchObject({
			status: "vendor_fetch_failed",
			reasonCode: "vendor_fetch_failed",
			reasonSubcode: "provider_dataset_invalid",
			diagnostics: { error_class: "Error", failure_phase: "acquire" },
		});
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	test("retains only adapter-authored safe provider diagnostics", async () => {
		const deps = dependencies();
		deps.providers.acquire = async () => {
			throw new CryptoHftDataError("required_clock_coverage_insufficient", {
				target_time_ms: 1_700_000_900_000,
				source_time_ms: 1_700_000_890_000,
				asof_lag_ms: 10_000,
				max_prior_asof_lag_ms: 5_000,
			});
		};

		expect(await runMarketDataVendorBackfill(documents, deps)).toMatchObject({
			status: "vendor_fetch_failed",
			reasonCode: "vendor_fetch_failed",
			reasonSubcode: "required_clock_coverage_insufficient",
			diagnostics: {
				target_time_ms: 1_700_000_900_000,
				source_time_ms: 1_700_000_890_000,
				asof_lag_ms: 10_000,
				max_prior_asof_lag_ms: 5_000,
			},
		});
	});

	test("maps every terminal dependency gate to a closed final-v1 outcome", async () => {
		const missingCredentials = dependencies();
		missingCredentials.credentials.resolve = async () => undefined;
		expect(
			await runMarketDataVendorBackfill(documents, missingCredentials),
		).toMatchObject({
			status: "credentials_missing",
			reasonCode: "provider_credentials_missing",
		});

		const fetchFailed = dependencies();
		fetchFailed.providers.acquire = async () => {
			throw new CryptoHftDataError("budget_max_rows_exceeded");
		};
		expect(
			await runMarketDataVendorBackfill(documents, fetchFailed),
		).toMatchObject({
			status: "vendor_fetch_failed",
			reasonCode: "vendor_fetch_failed",
			reasonSubcode: "resource_limit_exceeded",
		});

		const ingestFailed = dependencies();
		ingestFailed.retry = { maxAttempts: 1 };
		ingestFailed.forwarder.submit = async () => ({ ok: false, inserted: 0 });
		expect(
			await runMarketDataVendorBackfill(documents, ingestFailed),
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
			await runMarketDataVendorBackfill(documents, verificationFailed),
		).toMatchObject({
			status: "promotion_verification_failed",
			reasonCode: "timeline_seam_invalid",
		});

		const coverageFailed = dependencies();
		coverageFailed.archive.resolveSelection = async () => {
			coverageFailed.calls.push("preflight");
			return preflight();
		};
		expect(
			await runMarketDataVendorBackfill(documents, coverageFailed),
		).toMatchObject({
			status: "promotion_verification_failed",
			reasonCode: "qualified_coverage_incomplete",
		});
	});
});
