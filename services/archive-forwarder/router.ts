import type { ArchiveBatchRequest, ArchiveBatchResult } from "./types";
import { isSupportedTable, MALFORMED_TABLE_LABEL } from "./types";
import { insertArchiveRows, type RowInserter } from "./insert";
import type { ArchiveForwarderTelemetry } from "./telemetry";

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
			rejectedRowsByTable: Record<string, number>;
			checksumConflictsByTable: Record<string, number>;
	  }
	| { ok: false };

function isValidArchiveRow(
	entry: unknown,
	envelopeSource?: string,
): entry is ArchiveBatchRequest["rows"][number] {
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
	if (!isSupportedTable(row.table)) {
		return false;
	}
	const rowSource = (row.row as Record<string, unknown>).source;
	return !(
		envelopeSource !== undefined &&
		typeof rowSource === "string" &&
		rowSource !== envelopeSource
	);
}

const ORDER_BOOK_LOGICAL_KEYS = {
	"market_data.cex_order_book_levels": [
		"capture_bundle_id",
		"exchange",
		"trading_pair",
		"raw_capture_id",
		"snapshot_id",
		"schema_version",
		"side",
		"level_index",
	],
	"market_data.cex_order_book_depth_summary": [
		"capture_bundle_id",
		"exchange",
		"trading_pair",
		"raw_capture_id",
		"snapshot_id",
		"schema_version",
	],
} as const;

function conflictingOrderBookRows(
	rows: ArchiveBatchRequest["rows"],
): Set<ArchiveBatchRequest["rows"][number]> {
	const groups = new Map<
		string,
		{ checksums: Set<string>; rows: ArchiveBatchRequest["rows"] }
	>();
	for (const entry of rows) {
		const keys =
			ORDER_BOOK_LOGICAL_KEYS[
				entry.table as keyof typeof ORDER_BOOK_LOGICAL_KEYS
			];
		if (!keys) continue;
		const checksum = entry.row.normalized_row_checksum;
		const values = keys.map((key) => entry.row[key]);
		if (
			typeof checksum !== "string" ||
			values.some(
				(value) => typeof value !== "string" && typeof value !== "number",
			)
		) {
			continue;
		}
		const logicalKey = `${entry.table}\u0000${JSON.stringify(values)}`;
		const group = groups.get(logicalKey) ?? {
			checksums: new Set<string>(),
			rows: [],
		};
		group.checksums.add(checksum);
		group.rows.push(entry);
		groups.set(logicalKey, group);
	}
	const conflicts = new Set<ArchiveBatchRequest["rows"][number]>();
	for (const group of groups.values()) {
		if (group.checksums.size > 1) {
			for (const entry of group.rows) conflicts.add(entry);
		}
	}
	return conflicts;
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
	// Absent is a valid contract (the sender claims no retry identity); present
	// but blank is a broken sender that would silently lose deduplication.
	if (
		record.batch_id !== undefined &&
		(typeof record.batch_id !== "string" || record.batch_id.trim() === "")
	) {
		return { ok: false };
	}
	const inputRowCount = record.rows.length;
	const structurallyValidRows = record.rows.filter((entry) =>
		isValidArchiveRow(entry, record.source as string),
	);
	const conflicts = conflictingOrderBookRows(structurallyValidRows);
	const rows = structurallyValidRows.filter((entry) => !conflicts.has(entry));
	const rejectedRowsByTable = countRejectedRowsByTable(
		record.rows,
		record.source as string,
		conflicts,
	);
	return {
		ok: true,
		batch: {
			source: record.source,
			deployment_id: record.deployment_id,
			...(record.batch_id === undefined
				? {}
				: { batch_id: record.batch_id as string }),
			rows,
		},
		inputRowCount,
		rejectedRowCount: inputRowCount - rows.length,
		rejectedTables: Object.keys(rejectedRowsByTable),
		rejectedRowsByTable,
		checksumConflictsByTable: countRowsByTable(conflicts),
	};
}

function countRowsByTable(
	rows: ReadonlySet<ArchiveBatchRequest["rows"][number]>,
): Record<string, number> {
	const counts = new Map<string, number>();
	for (const { table } of rows) {
		counts.set(table, (counts.get(table) ?? 0) + 1);
	}
	return Object.fromEntries(counts);
}

function countRejectedRowsByTable(
	rows: unknown[],
	envelopeSource: string,
	conflicts: ReadonlySet<ArchiveBatchRequest["rows"][number]>,
): Record<string, number> {
	const counts = new Map<string, number>();
	for (const entry of rows) {
		if (
			isValidArchiveRow(entry, envelopeSource) &&
			!conflicts.has(entry)
		) {
			continue;
		}
		const table = (entry as { table?: unknown } | null)?.table;
		const label =
			typeof table === "string" ? table : MALFORMED_TABLE_LABEL;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return Object.fromEntries(counts);
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
	telemetry?: ArchiveForwarderTelemetry,
): Promise<ArchiveBatchResult> {
	const result = await insertArchiveRows(
		inserter,
		request.rows,
		telemetry,
		request.batch_id,
	);
	// Requires rows to have actually landed. `failed === 0` is also true for an
	// empty batch, and an empty POST advancing this gauge would keep a staleness
	// alert green while nothing reaches ClickHouse — the precise failure this
	// heartbeat exists to catch, since its whole job is separating "quiet" from
	// "dead".
	if (result.failed === 0 && result.inserted > 0) {
		telemetry?.recordSuccessfulFlush();
	}
	return result;
}
