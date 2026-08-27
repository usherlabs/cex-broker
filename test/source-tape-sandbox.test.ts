import { describe, expect, test } from "bun:test";
import { buildCryptoHftDataConformanceDocuments } from "../scripts/market-data-vendor-backfill-conformance";
import {
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID,
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
} from "../src/helpers/market-data-preparation/contracts";
import {
	decodeBackfillRunDocuments,
	finalizeArchiveSelection,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	createSourceTapeArchiveSink,
	SOURCE_TAPE_CONSTRUCTION_MODE,
} from "../src/helpers/source-tape";
import {
	promoteAndExportSourceTapeSandbox,
	verifySourceTapeArchive,
} from "../src/helpers/source-tape-sandbox";

describe("source-tape disposable sandbox archive path", () => {
	test("verifies exact streamed semantics then uses normal receipt, qualification, selection, and exporter identities", async () => {
		const base = decodeBackfillRunDocuments(
			buildCryptoHftDataConformanceDocuments(
				Date.UTC(2026, 7, 18, 9, 27, 15, 308),
			),
		);
		const request = {
			...base,
			depth: 100,
			target: { environment: "sandbox", cluster: "cex-archive-local" },
			constructionMode: SOURCE_TAPE_CONSTRUCTION_MODE,
		};
		const forwardedRows: Array<{
			table: string;
			row: Record<string, unknown>;
		}> = [];
		const object = {
			identity: "okx_spot/2026-08-18/09/ARB-USDT_orderbook.parquet.zst",
			checksum: "c".repeat(64),
			bytes: 1_000,
			rows: 2,
		};
		const sink = createSourceTapeArchiveSink({
			captureBundleId: "a".repeat(64),
			tradingPair: "ARB-USDT",
			window: request.window,
			forwarder: {
				async submit(batch) {
					forwardedRows.push(...batch.rows);
					return { ok: true, inserted: batch.rows.length };
				},
			},
		});
		await sink.writeBatch([
			{
				tapeState: "initialization",
				targetTimeMs: request.window.startTimeMs - 1,
				sourceTimeMs: request.window.startTimeMs - 1,
				receivedTimeMs: request.window.startTimeMs - 1,
				sequence: "1",
				bids: [[1, 2]],
				asks: [[2, 3]],
				datasetObjectIdentity: object.identity,
				datasetObjectChecksum: object.checksum,
			},
		]);
		await sink.complete({
			expectedObjectIdentities: [object.identity],
			observedObjects: [object],
			stateCount: 1,
		});
		const sinkResult = sink.result();
		const levelRows = forwardedRows
			.filter(({ table }) => table.endsWith("order_book_levels"))
			.map(({ row }) => row);
		const summaryRows = forwardedRows
			.filter(({ table }) => table.endsWith("depth_summary"))
			.map(({ row }) => row);
		const verification = await verifySourceTapeArchive({
			request,
			sinkResult,
			client: {
				async query(sql) {
					if (sql.includes("cex_order_book_levels_conflicts")) {
						return [{ conflicts: "0" }];
					}
					if (sql.includes("replay_qualified")) {
						return [{ qualified_rows: "0" }];
					}
					if (
						sql.includes(
							"FROM market_data.cex_order_book_depth_summary_canonical",
						) &&
						!sql.includes("AS summary_rows")
					) {
						return summaryRows;
					}
					if (
						sql.includes("FROM market_data.cex_order_book_levels_canonical") &&
						!sql.includes("AS level_rows")
					) {
						return levelRows;
					}
					return [
						{
							level_rows: String(levelRows.length),
							summary_rows: "1",
							state_count: "1",
						},
					];
				},
			},
		});
		expect(verification).toMatchObject({
			passed: true,
			coverageVerified: true,
		});
		const countOnly = await verifySourceTapeArchive({
			request,
			sinkResult,
			client: {
				async query(sql) {
					if (sql.includes("cex_order_book_levels_conflicts")) {
						return [{ conflicts: "0" }];
					}
					if (sql.includes("replay_qualified")) {
						return [{ qualified_rows: "0" }];
					}
					if (!sql.includes(" AS level_rows")) return [];
					return [
						{
							level_rows: String(levelRows.length),
							summary_rows: "1",
							state_count: "1",
						},
					];
				},
			},
		});
		expect(countOnly).toMatchObject({
			passed: false,
			coverageVerified: false,
		});

		let receiptId = "";
		let promotionIdentity = "";
		let qualificationEventId = "";
		let exportedConstructionMode = "";
		const manifest = await promoteAndExportSourceTapeSandbox({
			request,
			sinkResult,
			verification,
			datasetObjects: [object],
			vendorSemanticDigest: "d".repeat(64),
			verifiedAt: "2026-08-26T12:00:00.000Z",
			forwarder: {
				async submit(batch) {
					for (const entry of batch.rows) {
						if (entry.table.endsWith("capture_promotions")) {
							receiptId = String(entry.row.receipt_id);
							promotionIdentity = String(entry.row.promotion_identity_sha256);
						}
						if (entry.table.endsWith("capture_qualifications")) {
							qualificationEventId = String(entry.row.qualification_event_id);
						}
					}
					return { ok: true, inserted: batch.rows.length };
				},
			},
			archive: {
				async resolveSelection() {
					return finalizeArchiveSelection({
						schema_id:
							"https://schemas.usher.so/market-data-vendor-backfill-archive-selection/v1",
						scope: base.wire?.scope,
						required_clock: {
							clock_id: base.requiredClock?.clock_id,
							clock_sha256: base.requiredClock?.clock_sha256,
							event_count: base.requiredClock?.targets.length,
						},
						coverage_policy: base.wire?.coverage_policy,
						source_policy: base.sourcePolicy,
						coverage_class: "complete",
						requested_intervals: [base.wire?.window],
						selected_intervals: [
							{
								...base.wire?.window,
								capture_bundle_id: sinkResult.capture_bundle_id,
								capture_origin: "vendor_historical_backfill",
							},
						],
						precedence: ["archive", "vendor"],
						bundles: [
							{
								capture_bundle_id: sinkResult.capture_bundle_id,
								capture_origin: "vendor_historical_backfill",
								interval: base.wire?.window,
								qualification: {
									qualification_event_id: qualificationEventId,
									state: "qualified",
									receipt_id: receiptId,
									promotion_identity_sha256: promotionIdentity,
								},
							},
						],
						support_anchors: [],
						receipt_ids: [receiptId],
						qualification_event_ids: [qualificationEventId],
						resolved_at: "2026-08-26T12:00:01.000Z",
					});
				},
			},
			exporter: {
				async export(request) {
					exportedConstructionMode = request.construction_mode;
					return {
						promotionReceiptIds: [receiptId],
						levels: {
							file_name: "order_book_levels.parquet",
							rows: levelRows.length,
							bytes: 2_000,
							sha256: "f".repeat(64),
							projection_schema_id:
								ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID,
							projection_schema_sha256:
								ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
						},
						summary: {
							file_name: "order_book_depth_summary.parquet",
							rows: 1,
							bytes: 1_000,
							sha256: "1".repeat(64),
							projection_schema_id:
								ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID,
							projection_schema_sha256:
								ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
						},
					};
				},
			},
		});
		expect(exportedConstructionMode).toBe(SOURCE_TAPE_CONSTRUCTION_MODE);
		expect(manifest).toMatchObject({
			archive_target: { environment: "sandbox", cluster: "cex-archive-local" },
			construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
			normal_archive_path: true,
			promotion: { receipt_id: receiptId },
			export: {
				levels: { sha256: "f".repeat(64) },
				summary: { sha256: "1".repeat(64) },
			},
		});
	});
});
