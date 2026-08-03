import type { ClickHouseClient } from "@clickhouse/client";
import type { ArchiveForwarderTelemetry } from "./telemetry";
import type { ArchiveRow, ArchiveBatchResult, SupportedTable } from "./types";
import { isSupportedTable } from "./types";

export type RowInserter = (
	table: SupportedTable,
	rows: Record<string, unknown>[],
	options?: { deduplicationToken?: string },
) => Promise<void>;

export function groupRowsByTable(
	rows: ArchiveRow[],
): Map<SupportedTable, Record<string, unknown>[]> {
	const grouped = new Map<SupportedTable, Record<string, unknown>[]>();
	for (const entry of rows) {
		if (!isSupportedTable(entry.table)) {
			continue;
		}
		const bucket = grouped.get(entry.table) ?? [];
		bucket.push(entry.row);
		grouped.set(entry.table, bucket);
	}
	return grouped;
}

export function countSkippedRows(rows: ArchiveRow[]): number {
	return rows.filter((entry) => !isSupportedTable(entry.table)).length;
}

export async function insertArchiveRows(
	inserter: RowInserter,
	rows: ArchiveRow[],
	telemetry?: ArchiveForwarderTelemetry,
): Promise<ArchiveBatchResult> {
	const grouped = groupRowsByTable(rows);
	const byTable: Record<string, number> = {};
	const failedTables: string[] = [];
	let inserted = 0;
	let failed = 0;

	for (const [table, tableRows] of grouped.entries()) {
		if (tableRows.length === 0) {
			continue;
		}
		try {
			await inserter(table, tableRows);
			byTable[table] = tableRows.length;
			inserted += tableRows.length;
			telemetry?.recordRowsInserted(table, tableRows.length);
		} catch (error) {
			failedTables.push(table);
			failed += tableRows.length;
			telemetry?.recordInsertFailure(table, error);
			console.error(`Archive insert failed for ${table}:`, error);
		}
	}

	return {
		inserted,
		skipped: countSkippedRows(rows),
		failed,
		byTable,
		failedTables,
	};
}

export function createClickHouseInserter(
	client: ClickHouseClient,
): RowInserter {
	return async (table, rows, options) => {
		await client.insert({
			table,
			values: rows,
			format: "JSONEachRow",
			...(options?.deduplicationToken
				? {
						clickhouse_settings: {
							insert_deduplication_token: options.deduplicationToken,
						},
					}
				: {}),
		});
	};
}
