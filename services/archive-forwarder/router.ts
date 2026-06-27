import type { ArchiveBatchRequest, ArchiveBatchResult } from "./types";
import { insertArchiveRows, type RowInserter } from "./insert";

export type ParsedArchiveBatch =
	| {
			ok: true;
			batch: ArchiveBatchRequest;
			inputRowCount: number;
			rejectedRowCount: number;
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
	return true;
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
	return {
		ok: true,
		batch: {
			source: record.source,
			deployment_id: record.deployment_id,
			rows,
		},
		inputRowCount,
		rejectedRowCount: inputRowCount - rows.length,
	};
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
