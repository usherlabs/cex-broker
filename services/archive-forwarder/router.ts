import type { ArchiveBatchRequest, ArchiveBatchResult } from "./types";
import { insertArchiveRows, type RowInserter } from "./insert";

export function parseArchiveBatchRequest(
	body: unknown,
): ArchiveBatchRequest | null {
	if (!body || typeof body !== "object") {
		return null;
	}
	const record = body as Record<string, unknown>;
	if (typeof record.source !== "string" || typeof record.deployment_id !== "string") {
		return null;
	}
	if (!Array.isArray(record.rows)) {
		return null;
	}
	const rows = record.rows.filter(
		(entry): entry is ArchiveBatchRequest["rows"][number] =>
			Boolean(entry) &&
			typeof entry === "object" &&
			typeof (entry as ArchiveBatchRequest["rows"][number]).table ===
				"string" &&
			typeof (entry as ArchiveBatchRequest["rows"][number]).row === "object" &&
			(entry as ArchiveBatchRequest["rows"][number]).row !== null,
	);
	return {
		source: record.source,
		deployment_id: record.deployment_id,
		rows,
	};
}

export async function handleArchiveBatch(
	inserter: RowInserter,
	request: ArchiveBatchRequest,
): Promise<ArchiveBatchResult> {
	return insertArchiveRows(inserter, request.rows);
}
