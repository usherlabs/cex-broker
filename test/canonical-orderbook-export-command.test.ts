import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCanonicalOrderBookExportFileJob } from "../src/commands/cex-canonical-orderbook-export";
import type { ExactOrderBookExportQueryClient } from "../src/helpers/canonical-orderbook-export/exporter";
import {
	CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
	canonicalOrderBookExportResultCodec,
} from "../src/helpers/market-data-preparation/contracts";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";

const RELEASE = { packageVersion: "0.2.47", gitHead: "a".repeat(40) };
const REQUEST = {
	schema_id: CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
	request_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f121",
	target: { environment: "production", cluster: "cex-archive-primary" },
	selection: CONFORMANCE_FIXTURES.documents.archive_selection,
	depth: 20,
	construction_mode: "sampled_top_n_snapshot",
	canonical_schema_version: "1.0.0",
	checksum_algorithm: "sha256-canonical-json-v1",
} as const;

async function attempt(request: string | object = REQUEST) {
	const root = await mkdtemp(path.join(os.tmpdir(), "cex-export-command-"));
	const requestPath = path.join(root, "request.json");
	const resultPath = path.join(root, "result.json");
	const executablePath = path.join(root, "cex-canonical-orderbook-export.js");
	await writeFile(
		requestPath,
		typeof request === "string" ? request : JSON.stringify(request),
	);
	await writeFile(executablePath, "export executable bytes");
	return { root, requestPath, resultPath, executablePath };
}

function successfulClient(): ExactOrderBookExportQueryClient {
	const parquet = new TextEncoder().encode("PAR1payloadPAR1");
	return {
		async execute(sql, _parameters, format) {
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
					'{"level_rows":"40","summary_rows":"1","segment_0_level_rows":"40","segment_0_summary_rows":"1"}\n',
				);
			}
			if (sql.includes("promotion.receipt_id")) {
				return new TextEncoder().encode(
					`${JSON.stringify({ receipt_id: REQUEST.selection.receipt_ids[0] })}\n`,
				);
			}
			throw new Error("unexpected query");
		},
	};
}

describe("cex-canonical-orderbook-export command", () => {
	test("writes artifacts first and commits a closed successful result last", async () => {
		const paths = await attempt();
		try {
			const result = await runCanonicalOrderBookExportFileJob({
				...paths,
				release: RELEASE,
				client: successfulClient(),
				nowMs: () => Date.parse("2026-08-20T12:00:03.000Z"),
				randomUuid: () => "018f0f4d-7b32-7a30-8f4d-1d2a6e40f122",
			});
			expect(result.outcome.status).toBe("exported");
			expect(result.outcome.query_segments).toEqual(
				REQUEST.selection.selected_intervals,
			);
			expect(result.outcome.artifacts?.levels.file_name).toBe(
				"order_book_levels.parquet",
			);
			expect(
				await readFile(path.join(paths.root, "order_book_levels.parquet")),
			).toBeTruthy();
			expect(
				canonicalOrderBookExportResultCodec.decode(
					JSON.parse(await readFile(paths.resultPath, "utf8")),
				),
			).toEqual(result);
		} finally {
			await rm(paths.root, { recursive: true, force: true });
		}
	});

	test("handles malformed request bytes without querying the archive", async () => {
		const paths = await attempt("{bad-json\n");
		let queryCalls = 0;
		try {
			const result = await runCanonicalOrderBookExportFileJob({
				...paths,
				release: RELEASE,
				client: {
					async execute() {
						queryCalls += 1;
						throw new Error("must not query");
					},
				},
			});
			expect(result.outcome.status).toBe("request_invalid");
			expect(result.outcome.artifacts).toBeNull();
			expect(queryCalls).toBe(0);
		} finally {
			await rm(paths.root, { recursive: true, force: true });
		}
	});

	test("returns archive_data_invalid without successful descriptors on conflicts", async () => {
		const paths = await attempt();
		try {
			const base = successfulClient();
			const result = await runCanonicalOrderBookExportFileJob({
				...paths,
				release: RELEASE,
				client: {
					async execute(sql, parameters, format) {
						if (sql.includes("AS conflicts")) {
							return new TextEncoder().encode('{"conflicts":"1"}\n');
						}
						return base.execute(sql, parameters, format);
					},
				},
			});
			expect(result.outcome).toMatchObject({
				status: "archive_data_invalid",
				reason_subcode: "selected_checksum_conflict",
				artifacts: null,
			});
		} finally {
			await rm(paths.root, { recursive: true, force: true });
		}
	});
});
