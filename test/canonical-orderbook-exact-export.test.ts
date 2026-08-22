import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	compileExactOrderBookExport,
	ExactOrderBookExportError,
} from "../src/helpers/canonical-orderbook-export/exact-selection";
import {
	createClickHouseExactOrderBookExportClient,
	exportExactCanonicalOrderBook,
} from "../src/helpers/canonical-orderbook-export/exporter";
import {
	CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
	type CanonicalOrderBookExportRequestWire,
	canonicalOrderBookExportRequestCodec,
} from "../src/helpers/market-data-preparation/contracts";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import { finalizeArchiveSelection } from "../src/helpers/market-data-vendor-backfill/contracts";

const START = "2026-08-18T09:27:10.000Z";
const OVERLAP_START = "2026-08-18T09:27:12.000Z";
const ARCHIVE_END = "2026-08-18T09:27:18.000Z";
const END = "2026-08-18T09:27:20.000Z";
const PRODUCTION_BUNDLE = "a".repeat(64);
const VENDOR_BUNDLE = "b".repeat(64);

function exportRequest(
	sourcePolicy: "authoritative_window" | "fill_gaps",
): CanonicalOrderBookExportRequestWire {
	const fixture = CONFORMANCE_FIXTURES.documents.archive_selection;
	const selection = finalizeArchiveSelection({
		schema_id: fixture.schema_id,
		scope: fixture.scope,
		required_clock: fixture.required_clock,
		coverage_policy: fixture.coverage_policy,
		source_policy: sourcePolicy,
		coverage_class: "complete",
		requested_intervals: [{ start_at: START, end_at: END }],
		selected_intervals:
			sourcePolicy === "fill_gaps"
				? [
						{
							start_at: START,
							end_at: ARCHIVE_END,
							capture_bundle_id: PRODUCTION_BUNDLE,
							capture_origin: "production_capture",
						},
						{
							start_at: OVERLAP_START,
							end_at: END,
							capture_bundle_id: VENDOR_BUNDLE,
							capture_origin: "vendor_historical_backfill",
						},
					]
				: [
						{
							start_at: START,
							end_at: END,
							capture_bundle_id: VENDOR_BUNDLE,
							capture_origin: "vendor_historical_backfill",
						},
					],
		precedence:
			sourcePolicy === "fill_gaps" ? ["archive", "vendor"] : ["vendor"],
		bundles: [
			...(sourcePolicy === "fill_gaps"
				? [
						{
							capture_bundle_id: PRODUCTION_BUNDLE,
							capture_origin: "production_capture" as const,
							interval: { start_at: START, end_at: ARCHIVE_END },
							qualification: null,
						},
					]
				: []),
			{
				capture_bundle_id: VENDOR_BUNDLE,
				capture_origin: "vendor_historical_backfill",
				interval: {
					start_at: sourcePolicy === "fill_gaps" ? OVERLAP_START : START,
					end_at: END,
				},
				qualification: fixture.bundles[0]?.qualification ?? null,
			},
		],
		support_anchors: [],
		receipt_ids: fixture.receipt_ids,
		qualification_event_ids: fixture.qualification_event_ids,
		resolved_at: fixture.resolved_at,
	});
	return canonicalOrderBookExportRequestCodec.decode({
		schema_id: CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
		request_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f121",
		target: { environment: "production", cluster: "cex-archive-primary" },
		selection,
		depth: 20,
		construction_mode: "sampled_top_n_snapshot",
		canonical_schema_version: "1.0.0",
		checksum_algorithm: "sha256-canonical-json-v1",
	});
}

describe("exact canonical order-book export selection", () => {
	test("authoritative-window accepts a pure production archive hit", () => {
		const request = exportRequest("authoritative_window");
		const production = finalizeArchiveSelection({
			...request.selection,
			selected_intervals: [
				{
					start_at: START,
					end_at: END,
					capture_bundle_id: PRODUCTION_BUNDLE,
					capture_origin: "production_capture",
				},
			],
			bundles: [
				{
					capture_bundle_id: PRODUCTION_BUNDLE,
					capture_origin: "production_capture",
					interval: { start_at: START, end_at: END },
					qualification: null,
				},
			],
			receipt_ids: [],
			qualification_event_ids: [],
		});

		expect(
			compileExactOrderBookExport({ ...request, selection: production })
				.segments,
		).toMatchObject([
			{
				capture_bundle_id: PRODUCTION_BUNDLE,
				capture_origin: "production_capture",
			},
		]);
	});

	test("compiles authoritative-window into vendor-only exact segments", () => {
		const compiled = compileExactOrderBookExport(
			exportRequest("authoritative_window"),
		);
		expect(compiled.segments).toEqual([
			{
				start_at: START,
				end_at: END,
				capture_bundle_id: VENDOR_BUNDLE,
				capture_origin: "vendor_historical_backfill",
			},
		]);
		expect(compiled.summarySql).toContain(
			"market_data.cex_order_book_depth_summary_replay_qualified",
		);
		expect(compiled.summarySql).not.toContain(VENDOR_BUNDLE);
		expect(compiled.parameters.segment_0_bundle).toBe(VENDOR_BUNDLE);
		expect(compiled.parameters.segment_0_origin).toBe(
			"vendor_historical_backfill",
		);
		expect(compiled.parameters.segment_0_sources).toEqual([
			"external_backfill",
		]);
		expect(compiled.promotionReceiptsSql).toContain(
			"promotion.receipt_id AS receipt_id",
		);
	});

	test("fill-gaps gives production archive rows precedence over overlapping vendor rows", () => {
		const compiled = compileExactOrderBookExport(exportRequest("fill_gaps"));
		expect(compiled.segments).toEqual([
			{
				start_at: START,
				end_at: ARCHIVE_END,
				capture_bundle_id: PRODUCTION_BUNDLE,
				capture_origin: "production_capture",
			},
			{
				start_at: ARCHIVE_END,
				end_at: END,
				capture_bundle_id: VENDOR_BUNDLE,
				capture_origin: "vendor_historical_backfill",
			},
		]);
		expect(compiled.parameters.segment_0_sources).toEqual([
			"broker_read",
			"broker_write",
		]);
		expect(compiled.parameters.segment_1_sources).toEqual([
			"external_backfill",
		]);
	});

	test("query identity binds selection, contract fields, target, precedence, and segments", () => {
		const request = exportRequest("fill_gaps");
		const first = compileExactOrderBookExport(request);
		const second = compileExactOrderBookExport(structuredClone(request));
		expect(second.querySha256).toBe(first.querySha256);
		expect(
			compileExactOrderBookExport({ ...request, depth: request.depth + 1 })
				.querySha256,
		).not.toBe(first.querySha256);
	});

	test("rejects selected intervals that are not linked to their bundle evidence", () => {
		const request = exportRequest("authoritative_window");
		const selected = request.selection.selected_intervals[0];
		if (!selected) throw new Error("synthetic selection interval missing");
		const selection = finalizeArchiveSelection({
			...request.selection,
			selected_intervals: [
				{
					...selected,
					start_at: "2026-08-18T09:27:09.000Z",
				},
			],
		});
		expect(() =>
			compileExactOrderBookExport({ ...request, selection }),
		).toThrow(ExactOrderBookExportError);
	});

	test("exports conflict-free qualified rows and binds every query to exact segments", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-exact-export-"));
		const request = exportRequest("fill_gaps");
		const parquet = new TextEncoder().encode("PAR1payloadPAR1");
		const queries: Array<{
			sql: string;
			parameters: Readonly<Record<string, string | number | readonly string[]>>;
			format: string;
		}> = [];
		try {
			const exported = await exportExactCanonicalOrderBook({
				request,
				outputDirectory: root,
				client: {
					async execute(sql, parameters, format) {
						queries.push({ sql, parameters, format });
						if (format === "Parquet") return parquet;
						if (sql.includes("cex_archive_cluster_identity")) {
							return new TextEncoder().encode(
								'{"environment":"production","cluster":"cex-archive-primary"}\n',
							);
						}
						if (sql.includes("AS conflicts")) {
							return new TextEncoder().encode('{"conflicts":"0"}\n');
						}
						if (sql.includes("AS level_rows")) {
							return new TextEncoder().encode(
								'{"level_rows":"40","summary_rows":"2","segment_0_level_rows":"20","segment_0_summary_rows":"1","segment_1_level_rows":"20","segment_1_summary_rows":"1"}\n',
							);
						}
						if (sql.includes("promotion.receipt_id")) {
							return new TextEncoder().encode(
								`${JSON.stringify({ receipt_id: request.selection.receipt_ids[0] })}\n`,
							);
						}
						throw new Error("unexpected query");
					},
				},
			});
			expect(exported.levels).toEqual({
				file_name: "order_book_levels.parquet",
				rows: 40,
				bytes: parquet.byteLength,
				sha256: createHash("sha256").update(parquet).digest("hex"),
			});
			expect(await readFile(exported.levelsPath)).toEqual(Buffer.from(parquet));
			expect(exported.promotionReceiptIds).toEqual(
				request.selection.receipt_ids,
			);
			for (const query of queries) {
				expect(query.sql).not.toContain(PRODUCTION_BUNDLE);
				expect(query.sql).not.toContain(VENDOR_BUNDLE);
			}
			const parquetQueries = queries.filter(
				({ format }) => format === "Parquet",
			);
			expect(parquetQueries).toHaveLength(2);
			expect(parquetQueries[0]?.parameters.segment_0_bundle).toBe(
				PRODUCTION_BUNDLE,
			);
			expect(parquetQueries[0]?.parameters.segment_1_bundle).toBe(
				VENDOR_BUNDLE,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects an aggregate-covered selection with an empty effective segment", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-exact-export-"));
		const request = exportRequest("fill_gaps");
		try {
			await expect(
				exportExactCanonicalOrderBook({
					request,
					outputDirectory: root,
					client: {
						async execute(sql) {
							if (sql.includes("cex_archive_cluster_identity")) {
								return new TextEncoder().encode(
									'{"environment":"production","cluster":"cex-archive-primary"}\n',
								);
							}
							if (sql.includes("AS conflicts")) {
								return new TextEncoder().encode('{"conflicts":"0"}\n');
							}
							if (sql.includes("AS level_rows")) {
								return new TextEncoder().encode(
									'{"level_rows":"40","summary_rows":"2","segment_0_level_rows":"40","segment_0_summary_rows":"2","segment_1_level_rows":"0","segment_1_summary_rows":"0"}\n',
								);
							}
							throw new Error("must reject before receipts or artifacts");
						},
					},
				}),
			).rejects.toMatchObject({ reason: "qualified_segment_empty" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("ClickHouse errors expose stable status only and never response bodies", async () => {
		const client = createClickHouseExactOrderBookExportClient({
			url: "http://clickhouse.test",
			fetch: async () =>
				new Response("server leaked planted-secret", { status: 503 }),
		});
		let error: unknown;
		try {
			await client.execute("SELECT 1", {}, "JSONEachRow");
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ExactOrderBookExportError);
		expect(String(error)).toContain("archive_query_http_503");
		expect(String(error)).not.toContain("planted-secret");
	});
});
