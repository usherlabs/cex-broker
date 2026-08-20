import { describe, expect, test } from "bun:test";
import { sha256Canonical } from "../src/helpers/market-data-archive/capture-contract";
import {
	type ArchiveQueryClient,
	createClickHouseArchiveQueryClient,
	QualifiedOrderBookArchiveReader,
} from "../src/helpers/market-data-vendor-backfill/archive-reader";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import { decodeBackfillRunDocuments } from "../src/helpers/market-data-vendor-backfill/contracts";

const request = decodeBackfillRunDocuments({
	request: CONFORMANCE_FIXTURES.documents.request,
	requiredClock: CONFORMANCE_FIXTURES.documents.required_clock,
});

const options = {
	nowMs: () => Date.parse("2026-08-20T12:00:02.000Z"),
};

const archiveIdentity = {
	environment: "production",
	cluster: "cex-archive-primary",
};

describe("final-v1 qualification-aware archive reader", () => {
	test("encodes typed ClickHouse string arrays as array literals", async () => {
		let requestedUrl = "";
		const client = createClickHouseArchiveQueryClient({
			url: "http://archive.invalid:8123",
			fetch: async (input) => {
				requestedUrl = String(input);
				return new Response("");
			},
		});

		await client.query("SELECT {ids:Array(String)}", {
			ids: ["abc", "def"],
		});

		expect(new URL(requestedUrl).searchParams.get("param_ids")).toBe(
			"['abc','def']",
		);
	});

	test("returns the original stored selection and validated receipt content", async () => {
		const queries: string[] = [];
		const client: ArchiveQueryClient = {
			query: async (sql) => {
				queries.push(sql);
				if (sql.includes("cex_archive_cluster_identity")) {
					return [
						{
							environment: "production",
							cluster: "cex-archive-primary",
						},
					];
				}
				if (sql.includes("cex_order_book_archive_selections")) {
					return [
						{
							selection_sha256:
								CONFORMANCE_FIXTURES.identities.selection_sha256,
							selection_json: JSON.stringify(
								CONFORMANCE_FIXTURES.documents.archive_selection,
							),
						},
					];
				}
				if (sql.includes("cex_order_book_capture_promotions")) {
					return [
						{
							receipt_id: CONFORMANCE_FIXTURES.identities.receipt_id,
							receipt_json: JSON.stringify(
								CONFORMANCE_FIXTURES.documents.promotion_receipt,
							),
							promotion_identity_sha256:
								CONFORMANCE_FIXTURES.identities.promotion_identity_sha256,
						},
					];
				}
				throw new Error(`unexpected query: ${sql}`);
			},
		};
		const resolved = await new QualifiedOrderBookArchiveReader(
			client,
			options,
		).resolveSelection(request);
		expect(resolved.selection).toEqual(
			CONFORMANCE_FIXTURES.documents.archive_selection,
		);
		expect(resolved.receipts).toEqual([
			CONFORMANCE_FIXTURES.documents.promotion_receipt,
		]);
		expect(resolved.readerIdentity).toEqual(archiveIdentity);
		expect(queries).toHaveLength(3);
	});

	test("rejects conflicting stored content for one selection identity", async () => {
		const client: ArchiveQueryClient = {
			query: async (sql) => {
				if (sql.includes("cex_archive_cluster_identity")) {
					return [archiveIdentity];
				}
				if (sql.includes("cex_order_book_archive_selections")) {
					return [
						{
							selection_sha256:
								CONFORMANCE_FIXTURES.identities.selection_sha256,
							selection_json: JSON.stringify(
								CONFORMANCE_FIXTURES.documents.archive_selection,
							),
						},
						{
							selection_sha256:
								CONFORMANCE_FIXTURES.identities.selection_sha256,
							selection_json: JSON.stringify({
								...CONFORMANCE_FIXTURES.documents.archive_selection,
								resolved_at: "2026-08-20T12:00:03.000Z",
							}),
						},
					];
				}
				return [];
			},
		};
		await expect(
			new QualifiedOrderBookArchiveReader(client, options).resolveSelection(
				request,
			),
		).rejects.toThrow();
	});

	test("maps qualified-summary query failures to a closed reader reason", async () => {
		const client: ArchiveQueryClient = {
			query: async (sql) => {
				if (sql.includes("cex_archive_cluster_identity")) {
					return [archiveIdentity];
				}
				if (sql.includes("cex_order_book_archive_selections")) return [];
				throw new Error("unsafe ClickHouse response detail");
			},
		};
		try {
			await new QualifiedOrderBookArchiveReader(
				client,
				options,
			).resolveSelection(request);
			throw new Error("reader unexpectedly resolved");
		} catch (error) {
			expect(error).toMatchObject({
				reason: "archive_qualified_summary_query_failed",
			});
			expect(String(error)).not.toContain("unsafe ClickHouse response detail");
		}
	});

	test("builds exact support anchors from qualified archive evidence", async () => {
		const receipt = CONFORMANCE_FIXTURES.documents.promotion_receipt;
		const client: ArchiveQueryClient = {
			query: async (sql) => {
				if (sql.includes("cex_archive_cluster_identity")) {
					return [archiveIdentity];
				}
				if (sql.includes("cex_order_book_archive_selections")) return [];
				if (sql.includes("'level' AS table")) return [];
				if (sql.includes("depth_summary_replay_qualified")) {
					return [
						{
							capture_bundle_id: receipt.capture_bundle_id,
							raw_capture_id: "4".repeat(64),
							snapshot_id: "5".repeat(64),
							source_time_ms: String(Date.parse("2026-08-18T09:27:15.308Z")),
							normalized_row_checksum: "6".repeat(64),
							source: "external_backfill",
						},
					];
				}
				if (sql.includes("cex_order_book_capture_qualifications")) {
					return [
						{
							capture_bundle_id: receipt.capture_bundle_id,
							qualification_event_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f104",
							state: "qualified",
							receipt_id: receipt.receipt_id,
							promotion_identity_sha256: receipt.promotion_identity_sha256,
							window_start_ms: String(request.window.startTimeMs),
							window_end_ms: String(request.window.endTimeMs),
						},
					];
				}
				if (sql.includes("cex_order_book_capture_promotions")) {
					return [
						{
							receipt_id: receipt.receipt_id,
							receipt_json: JSON.stringify(receipt),
							promotion_identity_sha256: receipt.promotion_identity_sha256,
						},
					];
				}
				throw new Error(`unexpected query: ${sql}`);
			},
		};
		const resolved = await new QualifiedOrderBookArchiveReader(
			client,
			options,
		).resolveSelection(request);
		expect(resolved.selection.coverage_class).toBe("complete");
		expect(resolved.selection.support_anchors).toEqual([
			{
				capture_bundle_id: receipt.capture_bundle_id,
				raw_capture_id: "4".repeat(64),
				snapshot_id: "5".repeat(64),
				source_time: "2026-08-18T09:27:15.308Z",
				normalized_summary_checksum: "6".repeat(64),
				metadata_ref: {
					capture_origin: "vendor_historical_backfill",
					qualification_event_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f104",
					receipt_id: receipt.receipt_id,
				},
			},
		]);
		expect(resolved.verificationBaseline).toEqual({
			prefixDigest: sha256Canonical([]),
			suffixDigest: sha256Canonical([]),
		});
	});
});
