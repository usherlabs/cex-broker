import type { ArchiveBatchRequest, ArchiveBatchResult } from "./types";
import { isSupportedTable } from "./types";
import { insertArchiveRows, type RowInserter } from "./insert";

export type ParsedArchiveBatch =
	| {
			ok: true;
			batch: ArchiveBatchRequest;
			inputRowCount: number;
			rejectedRowCount: number;
			// Distinct table names among rejected rows (unknown/unsupported tables),
			// so the caller can name them in a WARN instead of dropping silently.
			// A rejected row with no string `table` contributes "(malformed)".
			rejectedTables: string[];
	  }
	| { ok: false };

function isValidArchiveRow(entry: unknown): entry is ArchiveBatchRequest["rows"][number] {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return false;
	}
	const row = entry as ArchiveBatchRequest["rows"][number];
	if (typeof row.table !== "string") {
		return false;
	}
	if (
		typeof row.row !== "object" ||
		row.row === null ||
		Array.isArray(row.row)
	) {
		return false;
	}
	return isSupportedTable(row.table);
}

export function parseArchiveBatchRequest(body: unknown): ParsedArchiveBatch {
	if (!body || typeof body !== "object") {
		return { ok: false };
	}
	const record = body as Record<string, unknown>;
	if (
		typeof record.source !== "string" ||
		typeof record.deployment_id !== "string"
	) {
		return { ok: false };
	}
	if (!Array.isArray(record.rows)) {
		return { ok: false };
	}
	const inputRowCount = record.rows.length;
	const rows = record.rows.filter(isValidArchiveRow);
	const rejectedTables = collectRejectedTables(record.rows);
	return {
		ok: true,
		batch: {
			source: record.source,
			deployment_id: record.deployment_id,
			rows,
		},
		inputRowCount,
		rejectedRowCount: inputRowCount - rows.length,
		rejectedTables,
	};
}

function collectRejectedTables(rows: unknown[]): string[] {
	const tables = new Set<string>();
	for (const entry of rows) {
		if (isValidArchiveRow(entry)) {
			continue;
		}
		const table = (entry as { table?: unknown } | null)?.table;
		tables.add(typeof table === "string" ? table : "(malformed)");
	}
	return [...tables];
}

/** @deprecated Use parseArchiveBatchRequest returning ParsedArchiveBatch */
export function parseArchiveBatchRequestLegacy(
	body: unknown,
): ArchiveBatchRequest | null {
	const parsed = parseArchiveBatchRequest(body);
	if (!parsed.ok) {
		return null;
	}
	return parsed.batch;
}

export async function handleArchiveBatch(
	inserter: RowInserter,
	request: ArchiveBatchRequest,
): Promise<ArchiveBatchResult> {
	return insertArchiveRows(inserter, request.rows);
}
