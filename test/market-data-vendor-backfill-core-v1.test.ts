import { describe, expect, test } from "bun:test";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import type { PromotionReceiptWire } from "../src/helpers/market-data-vendor-backfill/contracts";
import { createBackfillIdempotencyKey } from "../src/helpers/market-data-vendor-backfill/contracts";
import type {
	ArchivePreflightResolution,
	BackfillDependencies,
	ForwarderPreflightResolution,
} from "../src/helpers/market-data-vendor-backfill/core";
import {
	createMarketDataVendorBackfillDependencies,
	runMarketDataVendorBackfill,
} from "../src/helpers/market-data-vendor-backfill/core";
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

function forwarderPreflight(
	overrides: Partial<ForwarderPreflightResolution> = {},
): ForwarderPreflightResolution {
	return {
		forwarderIdentity: {
			environment: "production",
			cluster: "cex-archive-primary",
		},
		authorization: {
			authorizationId:
				CONFORMANCE_FIXTURES.documents.request.production_authorization_id,
			scope: "production",
			environment: "production",
			cluster: "cex-archive-primary",
			expiresAt: "2026-08-21T12:00:00.000Z",
			credentialValidated: true,
		},
		...overrides,
	};
}

function dependencies(
	overrides: Partial<BackfillDependencies> = {},
): BackfillDependencies & { calls: string[] } {
	const calls: string[] = [];
	let resolutionCalls = 0;
	return {
		calls,
		archive: {
			resolveSelection: async () => {
				calls.push("preflight");
				resolutionCalls += 1;
				return preflight(
					resolutionCalls === 2
						? {
								selection: CONFORMANCE_FIXTURES.documents.archive_selection,
								receipts: [CONFORMANCE_FIXTURES.documents.promotion_receipt],
							}
						: {},
				);
			},
			verifyCandidate: async (_request, normalized, captureBundleId) => {
				calls.push("verify");
				return {
					passed: true,
					captureBundleId,
					canonicalSemanticDigest: normalized.canonicalSemanticDigest,
					prefixDigest: "1".repeat(64),
					suffixDigest: "2".repeat(64),
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
							identity: "object",
							checksum: "3".repeat(64),
							bytes: 100,
							rows: 1,
						},
					],
					vendorSemanticDigest: "4".repeat(64),
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
							row: { normalized_row_checksum: "5".repeat(64) },
						},
					],
					canonicalSemanticDigest: "6".repeat(64),
					vendorSemanticDigest: dataset.vendorSemanticDigest,
				};
			},
		},
		credentials: {
			resolve: async () => {
				calls.push("credentials");
				return { apiKey: "secret" };
			},
		},
		forwarder: {
			preflight: async () => {
				calls.push("forwarder-preflight");
				return forwarderPreflight();
			},
			submit: async (batch) => {
				const table = batch.rows[0]?.table;
				calls.push(
					table === "market_data.cex_order_book_capture_promotions"
						? "promotion"
						: table === "market_data.cex_order_book_capture_qualifications"
							? "qualification"
							: table === "market_data.cex_order_book_archive_selections"
								? "selection"
								: "candidate",
				);
				return { ok: true, inserted: batch.rows.length };
			},
		},
		clock: { nowMs: () => Date.parse("2026-08-20T12:00:02.000Z") },
		...overrides,
	};
}

describe("final-v1 CEX backfill runner", () => {
	test("dependency factory rejects incomplete integrations before a run", () => {
		const deps = dependencies();
		delete (deps.forwarder as Partial<BackfillDependencies["forwarder"]>)
			.preflight;
		expect(() => createMarketDataVendorBackfillDependencies(deps)).toThrow(
			"Backfill dependency forwarder.preflight is required",
		);
	});

	test("returns request_invalid before dependency I/O", async () => {
		const deps = dependencies();
		const outcome = await runMarketDataVendorBackfill(
			{
				...documents,
				request: { ...documents.request, provider: "forbidden" },
			},
			deps,
		);
		expect(outcome).toMatchObject({
			status: "request_invalid",
			reasonCode: "request_invalid",
		});
		expect(deps.calls).toEqual([]);
	});

	test("returns the exact stored selection and receipt on a qualified hit", async () => {
		const deps = dependencies();
		deps.archive.resolveSelection = async () => {
			deps.calls.push("preflight");
			return preflight({
				selection: CONFORMANCE_FIXTURES.documents.archive_selection,
				receipts: [CONFORMANCE_FIXTURES.documents.promotion_receipt],
			});
		};
		const outcome = await runMarketDataVendorBackfill(documents, deps);
		expect(outcome).toMatchObject({
			status: "already_covered",
			selection: CONFORMANCE_FIXTURES.documents.archive_selection,
			receipt: CONFORMANCE_FIXTURES.documents.promotion_receipt,
		});
		expect(deps.calls).toEqual(["preflight", "forwarder-preflight"]);
	});

	test("fails cluster identity and production authorization before capability or credentials", async () => {
		for (const mismatch of [
			{
				archive: {
					readerIdentity: { environment: "production", cluster: "wrong" },
				},
			},
			{
				forwarder: {
					forwarderIdentity: {
						environment: "staging",
						cluster: "cex-archive-primary",
					},
				},
			},
			{
				forwarder: {
					authorization: {
						...forwarderPreflight().authorization,
						expiresAt: "2026-08-20T12:00:01.999Z",
					},
				},
			},
		]) {
			const deps = dependencies();
			deps.archive.resolveSelection = async () => {
				deps.calls.push("preflight");
				return preflight(mismatch.archive ?? {});
			};
			deps.forwarder.preflight = async () => {
				deps.calls.push("forwarder-preflight");
				return forwarderPreflight(mismatch.forwarder ?? {});
			};
			const outcome = await runMarketDataVendorBackfill(documents, deps);
			expect(outcome.status).toBe("archive_preflight_failed");
			expect(deps.calls[0]).toBe("preflight");
			expect(deps.calls).not.toContain("capability");
			expect(deps.calls).not.toContain("credentials");
		}
	});

	test("rejects predictable resource-policy scope before credentials", async () => {
		const deps = dependencies();
		const request = {
			...documents.request,
			window: {
				start_at: "2026-07-19T00:00:00.000Z",
				end_at: "2026-08-20T00:00:00.000Z",
			},
		};
		request.idempotency_key = createBackfillIdempotencyKey(request);
		const outcome = await runMarketDataVendorBackfill(
			{ request, requiredClock: documents.requiredClock },
			deps,
		);
		expect(outcome).toMatchObject({
			status: "capability_unsupported",
			reasonSubcode: "resource_policy_scope_exceeded",
		});
		expect(deps.calls).toEqual(["preflight", "forwarder-preflight"]);
	});

	test("maps resource exhaustion to the closed vendor subreason", async () => {
		const deps = dependencies();
		deps.providers.acquire = async () => {
			throw new CryptoHftDataError("budget_max_rows_exceeded");
		};
		const outcome = await runMarketDataVendorBackfill(documents, deps);
		expect(outcome).toMatchObject({
			status: "vendor_fetch_failed",
			reasonSubcode: "resource_limit_exceeded",
		});
	});

	test("commits receipt then qualification, verifies selection, and persists the original selection", async () => {
		const deps = dependencies();
		let storedReceipt: PromotionReceiptWire | undefined;
		let qualification:
			| ReturnType<typeof qualificationEventFromArchiveRow>
			| undefined;
		let resolutionCalls = 0;
		deps.forwarder.submit = async (batch) => {
			const entry = batch.rows[0];
			if (!entry) throw new Error("missing synthetic row");
			if (entry.table === "market_data.cex_order_book_capture_promotions") {
				deps.calls.push("promotion");
				const parsed = promotionReceiptFromArchiveRow(entry.row);
				if (!("schema_id" in parsed)) throw new Error("expected final receipt");
				storedReceipt = parsed;
			} else if (
				entry.table === "market_data.cex_order_book_capture_qualifications"
			) {
				deps.calls.push("qualification");
				qualification = qualificationEventFromArchiveRow(entry.row);
			} else if (
				entry.table === "market_data.cex_order_book_archive_selections"
			) {
				deps.calls.push("selection");
			} else {
				deps.calls.push("candidate");
			}
			return { ok: true, inserted: batch.rows.length };
		};
		deps.archive.resolveSelection = async (decoded) => {
			deps.calls.push("preflight");
			resolutionCalls += 1;
			if (resolutionCalls === 1) return preflight();
			if (!storedReceipt || !qualification) {
				throw new Error("promotion evidence was not committed first");
			}
			return preflight({
				selection: resolveArchiveSelection({
					request: decoded,
					bundles: [
						{
							captureBundleId: storedReceipt.capture_bundle_id,
							captureOrigin: "vendor_historical_backfill",
							startTimeMs: decoded.window.startTimeMs,
							endTimeMs: decoded.window.endTimeMs,
							qualification: {
								qualificationEventId: qualification.qualification_event_id,
								state: qualification.state,
								receiptId: qualification.receipt_id,
								promotionIdentitySha256:
									qualification.promotion_identity_sha256,
							},
							supportAnchors: [
								{
									captureBundleId: storedReceipt.capture_bundle_id,
									rawCaptureId: "a".repeat(64),
									snapshotId: "b".repeat(64),
									sourceTimeMs:
										(decoded.requiredClockTargetsMs[0] as number) - 1,
									normalizedSummaryChecksum: "c".repeat(64),
								},
							],
						},
					],
					resolvedAtMs: Date.parse("2026-08-20T12:00:02.000Z"),
				}),
				receipts: [storedReceipt],
			});
		};
		const outcome = await runMarketDataVendorBackfill(documents, deps);
		expect(outcome.status).toBe("promoted");
		expect(outcome.selection?.receipt_ids).toEqual([
			outcome.receipt?.receipt_id,
		]);
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
	});

	test("maps post-promotion selection failure to promotion_verification_failed", async () => {
		const deps = dependencies();
		let calls = 0;
		deps.archive.resolveSelection = async () => {
			deps.calls.push("preflight");
			calls += 1;
			if (calls === 2) {
				throw Object.assign(new Error("post promotion query failed"), {
					reason: "archive_qualified_summary_query_failed",
				});
			}
			return preflight();
		};
		const outcome = await runMarketDataVendorBackfill(documents, deps);
		expect(outcome).toMatchObject({
			status: "promotion_verification_failed",
			reasonCode: "post_promotion_selection_failed",
			reasonSubcode: "archive_qualified_summary_query_failed",
		});
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
		]);
	});
});
