import { sha256Canonical } from "../market-data-archive/capture-contract";
import {
	type BackfillArchiveRow,
	EXTERNAL_BACKFILL_SOURCE,
	type ForwarderBatch,
} from "./contracts";

export const BACKFILL_MAX_BATCH_ROWS = 1_000;
export const BACKFILL_MAX_BATCH_BYTES = 5 * 1024 * 1024;

function serializedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function buildForwarderBatches(input: {
	captureBundleId: string;
	deploymentId: string;
	rows: readonly BackfillArchiveRow[];
	maxRows?: number;
	maxBytes?: number;
}): ForwarderBatch[] {
	const maxRows = input.maxRows ?? BACKFILL_MAX_BATCH_ROWS;
	const maxBytes = input.maxBytes ?? BACKFILL_MAX_BATCH_BYTES;
	const tables = new Map<string, BackfillArchiveRow[]>();
	for (const row of input.rows) {
		const group = tables.get(row.table) ?? [];
		group.push(row);
		tables.set(row.table, group);
	}
	const batches: ForwarderBatch[] = [];
	for (const table of [...tables.keys()].sort()) {
		const rows = tables.get(table) as BackfillArchiveRow[];
		let chunk: BackfillArchiveRow[] = [];
		let chunkBytes = 0;
		let ordinal = 0;
		const flush = () => {
			if (chunk.length === 0) return;
			const batchId = sha256Canonical({
				capture_bundle_id: input.captureBundleId,
				table,
				chunk_ordinal: ordinal,
				rows: chunk,
			});
			batches.push({
				source: EXTERNAL_BACKFILL_SOURCE,
				deployment_id: input.deploymentId,
				batch_id: batchId,
				rows: chunk,
			});
			ordinal += 1;
			chunk = [];
			chunkBytes = 0;
		};
		for (const row of rows) {
			const bytes = serializedBytes(row);
			if (bytes > maxBytes) {
				throw new Error(`archive_row_exceeds_byte_budget:${table}`);
			}
			if (chunk.length >= maxRows || chunkBytes + bytes > maxBytes) flush();
			chunk.push(row);
			chunkBytes += bytes;
		}
		flush();
	}
	return batches;
}
