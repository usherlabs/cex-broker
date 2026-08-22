import { describe, expect, test } from "bun:test";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import {
	archiveSelectionCodec,
	decodeBackfillRunDocuments,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	type ArchiveBundleEvidence,
	resolveArchiveSelection,
} from "../src/helpers/market-data-vendor-backfill/selection";

const request = decodeBackfillRunDocuments({
	request: CONFORMANCE_FIXTURES.documents.request,
	requiredClock: CONFORMANCE_FIXTURES.documents.required_clock,
});

function evidence(
	captureOrigin: ArchiveBundleEvidence["captureOrigin"],
	overrides: Partial<ArchiveBundleEvidence> = {},
): ArchiveBundleEvidence {
	const receipt = CONFORMANCE_FIXTURES.documents.promotion_receipt;
	return {
		captureBundleId:
			captureOrigin === "production_capture" ? "a".repeat(64) : "b".repeat(64),
		captureOrigin,
		startTimeMs: request.window.startTimeMs,
		endTimeMs: request.window.endTimeMs,
		qualification:
			captureOrigin === "production_capture"
				? null
				: {
						qualificationEventId: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f130",
						state: "qualified",
						receiptId: receipt.receipt_id,
						promotionIdentitySha256: receipt.promotion_identity_sha256,
					},
		supportAnchors: [
			{
				captureBundleId:
					captureOrigin === "production_capture"
						? "a".repeat(64)
						: "b".repeat(64),
				rawCaptureId: "c".repeat(64),
				snapshotId: "d".repeat(64),
				sourceTimeMs: Date.parse("2026-08-18T09:27:15.500Z"),
				normalizedSummaryChecksum: "e".repeat(64),
			},
		],
		...overrides,
	};
}

function firstSupportAnchor(bundle: ArchiveBundleEvidence) {
	const anchor = bundle.supportAnchors[0];
	if (!anchor) throw new Error("synthetic bundle lacks its support anchor");
	return anchor;
}

describe("exact archive selection resolver", () => {
	test("authoritative_window reuses complete production coverage when no qualified vendor exists", () => {
		const selection = resolveArchiveSelection({
			request,
			bundles: [evidence("production_capture")],
			resolvedAtMs: Date.parse("2026-08-20T12:00:02.000Z"),
		});

		expect(selection.coverage_class).toBe("complete");
		expect(selection.bundles).toHaveLength(1);
		expect(selection.bundles[0]?.capture_origin).toBe("production_capture");
	});

	test("authoritative_window falls back to complete production when qualified vendor coverage is stale", () => {
		const target = request.requiredClockTargetsMs[0] as number;
		const productionEvidence = evidence("production_capture");
		const vendorEvidence = evidence("vendor_historical_backfill");
		const selection = resolveArchiveSelection({
			request,
			bundles: [
				evidence("production_capture", {
					supportAnchors: [
						{
							...firstSupportAnchor(productionEvidence),
							sourceTimeMs: target - 1,
						},
					],
				}),
				evidence("vendor_historical_backfill", {
					supportAnchors: [
						{
							...firstSupportAnchor(vendorEvidence),
							sourceTimeMs: target - request.maxPriorAsOfLagMs - 1,
						},
					],
				}),
			],
			resolvedAtMs: target,
		});

		expect(selection.coverage_class).toBe("complete");
		expect(
			selection.bundles.map(({ capture_origin }) => capture_origin),
		).toEqual(["production_capture"]);
	});

	test("authoritative_window selects only qualified vendor bundles", () => {
		const selection = resolveArchiveSelection({
			request,
			bundles: [
				evidence("production_capture"),
				evidence("vendor_historical_backfill"),
			],
			resolvedAtMs: Date.parse("2026-08-20T12:00:02.000Z"),
		});
		expect(archiveSelectionCodec.decode(selection)).toEqual(selection);
		expect(selection.coverage_class).toBe("complete");
		expect(selection.precedence).toEqual(["vendor"]);
		expect(selection.bundles).toHaveLength(1);
		expect(selection.bundles[0]?.capture_origin).toBe(
			"vendor_historical_backfill",
		);
		expect(selection.support_anchors).toHaveLength(1);
	});

	test("fill_gaps preserves production evidence and uses archive-wins precedence", () => {
		const selection = resolveArchiveSelection({
			request: { ...request, sourcePolicy: "fill_gaps" },
			bundles: [
				evidence("vendor_historical_backfill"),
				evidence("production_capture"),
			],
			resolvedAtMs: Date.parse("2026-08-20T12:00:02.000Z"),
		});
		expect(selection.precedence).toEqual(["archive", "vendor"]);
		expect(
			selection.bundles.map(({ capture_origin }) => capture_origin),
		).toEqual(["production_capture"]);
		expect(selection.support_anchors[0]?.metadata_ref.capture_origin).toBe(
			"production_capture",
		);
	});

	test("accepts the exact lag boundary and rejects future or stale vendor-only coverage", () => {
		const target = request.requiredClockTargetsMs[0] as number;
		const vendorEvidence = evidence("vendor_historical_backfill");
		const atBoundary = evidence("vendor_historical_backfill", {
			supportAnchors: [
				{
					...firstSupportAnchor(vendorEvidence),
					sourceTimeMs: target - request.maxPriorAsOfLagMs,
				},
			],
		});
		expect(
			resolveArchiveSelection({
				request,
				bundles: [atBoundary],
				resolvedAtMs: target,
			}).coverage_class,
		).toBe("complete");
		for (const sourceTimeMs of [
			target + 1,
			target - request.maxPriorAsOfLagMs - 1,
		]) {
			const unsupported = evidence("vendor_historical_backfill", {
				supportAnchors: [
					{
						...firstSupportAnchor(atBoundary),
						sourceTimeMs,
					},
				],
			});
			expect(
				resolveArchiveSelection({
					request,
					bundles: [unsupported],
					resolvedAtMs: target,
				}).coverage_class,
			).toBe("missing");
		}
	});

	test("returns the original valid stored selection without creating a new identity", () => {
		const stored = resolveArchiveSelection({
			request,
			bundles: [evidence("vendor_historical_backfill")],
			resolvedAtMs: Date.parse("2026-08-20T12:00:02.000Z"),
		});
		const reused = resolveArchiveSelection({
			request,
			bundles: [],
			resolvedAtMs: Date.parse("2026-08-20T13:00:00.000Z"),
			storedSelection: stored,
		});
		expect(reused).toEqual(stored);
		expect(reused.selection_sha256).toBe(stored.selection_sha256);
		expect(() =>
			resolveArchiveSelection({
				request,
				bundles: [],
				resolvedAtMs: Date.now(),
				storedSelection: { ...stored, resolved_at: "2026-08-20T13:00:00.000Z" },
			}),
		).toThrow("selection_sha256");
	});
});
