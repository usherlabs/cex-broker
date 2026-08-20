import { describe, expect, test } from "bun:test";
import { validateExternalBackfillBatch } from "../services/archive-forwarder/market-data-backfill-contract";
import { handleArchiveRequest } from "../services/archive-forwarder/request";
import {
	ArchiveForwarderTelemetry,
	type ArchiveMetricsRecorder,
} from "../services/archive-forwarder/telemetry";
import { buildForwarderBatches } from "../src/helpers/market-data-vendor-backfill/batching";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import {
	finalizeQualificationEvent,
	qualificationEventToArchiveRow,
} from "../src/helpers/market-data-vendor-backfill/qualification";
import { promotionReceiptToArchiveRow } from "../src/helpers/market-data-vendor-backfill/promotion";
import { archiveSelectionToArchiveRow } from "../src/helpers/market-data-vendor-backfill/selection";

function envelope(row: ReturnType<typeof promotionReceiptToArchiveRow>) {
	return buildForwarderBatches({
		captureBundleId:
			CONFORMANCE_FIXTURES.documents.promotion_receipt.capture_bundle_id,
		deploymentId: "market-data-vendor-backfill",
		rows: [row],
	})[0]!;
}

const noopRecorder: ArchiveMetricsRecorder = {
	recordCounter: () => {},
	setObservableGauge: () => {},
};

function post(body: unknown): Request {
	return new Request("http://localhost/archive", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("final-v1 external backfill forwarder evidence admission", () => {
	test("admits independently validated receipt, qualification, and selection rows", () => {
		const receipt = CONFORMANCE_FIXTURES.documents.promotion_receipt;
		const qualification = finalizeQualificationEvent({
			capture_bundle_id: receipt.capture_bundle_id,
			state: "qualified",
			receipt_id: receipt.receipt_id,
			promotion_identity_sha256: receipt.promotion_identity_sha256,
			window: receipt.window,
			event_at: "2026-08-20T12:00:02.000Z",
			reason_code: "promotion_verified",
		});
		for (const row of [
			promotionReceiptToArchiveRow(receipt),
			qualificationEventToArchiveRow(qualification),
			archiveSelectionToArchiveRow(
				CONFORMANCE_FIXTURES.documents.request,
				CONFORMANCE_FIXTURES.documents.archive_selection,
			),
		]) {
			expect(validateExternalBackfillBatch(envelope(row))).toEqual({ ok: true });
		}
	});

	test("admits quarantine and revocation as append-only state transitions", () => {
		const receipt = CONFORMANCE_FIXTURES.documents.promotion_receipt;
		for (const state of ["quarantined", "revoked"] as const) {
			const event = finalizeQualificationEvent({
				capture_bundle_id: receipt.capture_bundle_id,
				state,
				receipt_id: receipt.receipt_id,
				promotion_identity_sha256: receipt.promotion_identity_sha256,
				window: receipt.window,
				event_at: "2026-08-20T13:00:00.000Z",
				reason_code: state === "revoked" ? "operator_revoked" : "integrity_review",
			});
			expect(
				validateExternalBackfillBatch(
					envelope(qualificationEventToArchiveRow(event)),
				),
			).toEqual({ ok: true });
		}
	});

	test("rejects identity/content tampering and mixed evidence kinds", () => {
		const receipt = promotionReceiptToArchiveRow(
			CONFORMANCE_FIXTURES.documents.promotion_receipt,
		);
		const selection = archiveSelectionToArchiveRow(
			CONFORMANCE_FIXTURES.documents.request,
			CONFORMANCE_FIXTURES.documents.archive_selection,
		);
		for (const row of [
			{ ...receipt, row: { ...receipt.row, receipt_id: "0".repeat(64) } },
			{
				...selection,
				row: {
					...selection.row,
					selection_json: String(selection.row.selection_json).replace(
						'"complete"',
						'"partial"',
					),
				},
			},
		]) {
			expect(validateExternalBackfillBatch(envelope(row))).toMatchObject({
				ok: false,
			});
		}
		const mixed = {
			...envelope(receipt),
			rows: [receipt, selection],
		};
		expect(validateExternalBackfillBatch(mixed)).toMatchObject({ ok: false });
	});

	test("applies the final-v1 validator to every evidence kind over HTTP", async () => {
		const receipt = CONFORMANCE_FIXTURES.documents.promotion_receipt;
		const qualification = finalizeQualificationEvent({
			capture_bundle_id: receipt.capture_bundle_id,
			state: "qualified",
			receipt_id: receipt.receipt_id,
			promotion_identity_sha256: receipt.promotion_identity_sha256,
			window: receipt.window,
			event_at: "2026-08-20T12:00:02.000Z",
			reason_code: "promotion_verified",
		});
		const selection = archiveSelectionToArchiveRow(
			CONFORMANCE_FIXTURES.documents.request,
			CONFORMANCE_FIXTURES.documents.archive_selection,
		);
		for (const row of [
			promotionReceiptToArchiveRow(receipt),
			qualificationEventToArchiveRow(qualification),
			selection,
		]) {
			const response = await handleArchiveRequest(post(envelope(row)), {
				inserter: async () => {},
				telemetry: new ArchiveForwarderTelemetry(noopRecorder),
			});
			expect(response.status).toBe(200);
		}
		const tampered = {
			...selection,
			row: { ...selection.row, selection_sha256: "0".repeat(64) },
		};
		const response = await handleArchiveRequest(post(envelope(tampered)), {
			inserter: async () => {
				throw new Error("must not insert tampered evidence");
			},
			telemetry: new ArchiveForwarderTelemetry(noopRecorder),
		});
		expect(response.status).toBe(400);
	});
});
