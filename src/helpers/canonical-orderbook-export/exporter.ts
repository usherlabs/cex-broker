import { createHash } from "node:crypto";
import path from "node:path";
import type {
	CanonicalOrderBookExportArtifact,
	CanonicalOrderBookExportRequestWire,
} from "../market-data-preparation/contracts";
import {
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID,
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
} from "../market-data-preparation/contracts";
import { writeExclusiveDurableFile } from "../market-data-preparation/file-job";
import {
	type CompiledExactOrderBookExport,
	compileExactOrderBookExport,
	ExactOrderBookExportError,
	type ExactOrderBookQueryValue,
} from "./exact-selection";
import {
	assertDepthSummaryParquetProjection,
	assertLevelsParquetProjection,
} from "./parquet-projection";

export type ExactOrderBookExportFormat = "JSONEachRow" | "Parquet";

export type ExactOrderBookExportQueryClient = {
	execute(
		sql: string,
		parameters: Readonly<Record<string, ExactOrderBookQueryValue>>,
		format: ExactOrderBookExportFormat,
	): Promise<Uint8Array>;
};

export type ExactCanonicalOrderBookExport = {
	compiled: CompiledExactOrderBookExport;
	promotionReceiptIds: string[];
	levelsPath: string;
	summaryPath: string;
	levels: CanonicalOrderBookExportArtifact;
	summary: CanonicalOrderBookExportArtifact;
};

export type ClickHouseExactExportClientOptions = {
	url: string;
	username?: string;
	password?: string;
	fetch?: typeof globalThis.fetch;
};

function encodeClickHouseParameter(value: ExactOrderBookQueryValue): string {
	if (!Array.isArray(value)) return String(value);
	return `[${value
		.map((entry) => {
			const serialized = JSON.stringify(entry);
			return `'${serialized.slice(1, -1).replaceAll("'", "\\'")}'`;
		})
		.join(",")}]`;
}

export function createClickHouseExactOrderBookExportClient(
	options: ClickHouseExactExportClientOptions,
): ExactOrderBookExportQueryClient {
	const request = options.fetch ?? globalThis.fetch;
	return {
		async execute(sql, parameters, format) {
			let endpoint: URL;
			try {
				endpoint = new URL(options.url);
			} catch {
				throw new ExactOrderBookExportError("archive_url_invalid");
			}
			const embeddedUsername = decodeURIComponent(endpoint.username);
			const embeddedPassword = decodeURIComponent(endpoint.password);
			endpoint.username = "";
			endpoint.password = "";
			endpoint.searchParams.set("database", "market_data");
			for (const [name, value] of Object.entries(parameters)) {
				endpoint.searchParams.set(
					`param_${name}`,
					encodeClickHouseParameter(value),
				);
			}
			let response: Response;
			try {
				response = await request(endpoint, {
					method: "POST",
					headers: {
						"X-ClickHouse-User":
							options.username || embeddedUsername || "default",
						"X-ClickHouse-Key": options.password ?? embeddedPassword,
					},
					body: `${sql.trim()}\nFORMAT ${format}`,
				});
			} catch {
				throw new ExactOrderBookExportError("archive_query_unreachable");
			}
			if (!response.ok) {
				throw new ExactOrderBookExportError(
					`archive_query_http_${response.status}`,
				);
			}
			return new Uint8Array(await response.arrayBuffer());
		},
	};
}

function parseJsonEachRow(bytes: Uint8Array): Record<string, unknown>[] {
	const text = new TextDecoder().decode(bytes).trim();
	try {
		return text
			? text
					.split("\n")
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
	} catch {
		throw new ExactOrderBookExportError("archive_response_invalid");
	}
}

async function jsonQuery(
	client: ExactOrderBookExportQueryClient,
	compiled: CompiledExactOrderBookExport,
	sql: string,
): Promise<Record<string, unknown>[]> {
	try {
		return parseJsonEachRow(
			await client.execute(sql, compiled.parameters, "JSONEachRow"),
		);
	} catch (error) {
		if (error instanceof ExactOrderBookExportError) throw error;
		throw new ExactOrderBookExportError("archive_query_failed");
	}
}

function unsignedCount(value: unknown, reason: string): number {
	const count = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new ExactOrderBookExportError(reason);
	}
	return count;
}

function artifact(
	fileName: string,
	rows: number,
	bytes: Uint8Array,
	projection: {
		projection_schema_id: CanonicalOrderBookExportArtifact["projection_schema_id"];
		projection_schema_sha256: string;
	},
): CanonicalOrderBookExportArtifact {
	return {
		file_name: fileName,
		rows,
		bytes: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		...projection,
	};
}

export async function exportExactCanonicalOrderBook(input: {
	request: CanonicalOrderBookExportRequestWire;
	client: ExactOrderBookExportQueryClient;
	outputDirectory: string;
}): Promise<ExactCanonicalOrderBookExport> {
	const compiled = compileExactOrderBookExport(input.request);
	const identityRows = await jsonQuery(
		input.client,
		compiled,
		`SELECT environment, cluster
		 FROM market_data.cex_archive_cluster_identity FINAL
		 WHERE singleton_key = 'archive'
		 LIMIT 2`,
	);
	if (
		identityRows.length !== 1 ||
		identityRows[0]?.environment !== compiled.request.target.environment ||
		identityRows[0]?.cluster !== compiled.request.target.cluster
	) {
		throw new ExactOrderBookExportError("archive_target_mismatch");
	}

	const conflictRows = await jsonQuery(
		input.client,
		compiled,
		compiled.conflictsSql,
	);
	if (
		conflictRows.length !== 1 ||
		unsignedCount(conflictRows[0]?.conflicts, "conflict_count_invalid") !== 0
	) {
		throw new ExactOrderBookExportError("selected_checksum_conflict");
	}

	const countRows = await jsonQuery(
		input.client,
		compiled,
		compiled.rowCountsSql,
	);
	if (countRows.length !== 1) {
		throw new ExactOrderBookExportError("qualified_row_counts_invalid");
	}
	const levelRows = unsignedCount(
		countRows[0]?.level_rows,
		"qualified_row_counts_invalid",
	);
	const summaryRows = unsignedCount(
		countRows[0]?.summary_rows,
		"qualified_row_counts_invalid",
	);
	if (levelRows === 0 || summaryRows === 0) {
		throw new ExactOrderBookExportError("qualified_selection_empty");
	}
	for (const [index] of compiled.segments.entries()) {
		const segmentLevelRows = unsignedCount(
			countRows[0]?.[`segment_${index}_level_rows`],
			"qualified_row_counts_invalid",
		);
		const segmentSummaryRows = unsignedCount(
			countRows[0]?.[`segment_${index}_summary_rows`],
			"qualified_row_counts_invalid",
		);
		if (segmentLevelRows === 0 || segmentSummaryRows === 0) {
			throw new ExactOrderBookExportError("qualified_segment_empty");
		}
	}

	const receiptRows = await jsonQuery(
		input.client,
		compiled,
		compiled.promotionReceiptsSql,
	);
	const promotionReceiptIds = [
		...new Set(
			receiptRows.map((row) => {
				if (typeof row.receipt_id !== "string") {
					throw new ExactOrderBookExportError("promotion_receipts_invalid");
				}
				return row.receipt_id;
			}),
		),
	].sort();
	const expectedReceiptIds = [...compiled.request.selection.receipt_ids].sort();
	if (
		JSON.stringify(promotionReceiptIds) !== JSON.stringify(expectedReceiptIds)
	) {
		throw new ExactOrderBookExportError("promotion_receipt_mismatch");
	}

	let levelsBytes: Uint8Array;
	let summaryBytes: Uint8Array;
	try {
		[levelsBytes, summaryBytes] = await Promise.all([
			input.client.execute(compiled.levelsSql, compiled.parameters, "Parquet"),
			input.client.execute(compiled.summarySql, compiled.parameters, "Parquet"),
		]);
	} catch (error) {
		if (error instanceof ExactOrderBookExportError) throw error;
		throw new ExactOrderBookExportError("archive_query_failed");
	}
	assertLevelsParquetProjection(levelsBytes);
	assertDepthSummaryParquetProjection(summaryBytes);

	const levelsFileName = "order_book_levels.parquet";
	const summaryFileName = "order_book_depth_summary.parquet";
	const levelsPath = path.join(input.outputDirectory, levelsFileName);
	const summaryPath = path.join(input.outputDirectory, summaryFileName);
	try {
		await writeExclusiveDurableFile(levelsPath, levelsBytes);
		await writeExclusiveDurableFile(summaryPath, summaryBytes);
	} catch {
		throw new ExactOrderBookExportError("artifact_write_failed");
	}

	return {
		compiled,
		promotionReceiptIds,
		levelsPath,
		summaryPath,
		levels: artifact(levelsFileName, levelRows, levelsBytes, {
			projection_schema_id: ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID,
			projection_schema_sha256:
				ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
		}),
		summary: artifact(summaryFileName, summaryRows, summaryBytes, {
			projection_schema_id:
				ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID,
			projection_schema_sha256:
				ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
		}),
	};
}
