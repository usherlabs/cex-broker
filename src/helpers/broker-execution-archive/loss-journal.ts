import { createHash } from "node:crypto";
import type { BrokerArchiveRow, BrokerArchiveSource } from "./types";

export const LOSS_JOURNAL_RECORD_VERSION = 1 as const;

export type ArchiveLossReason =
	| "queue_shed"
	| "shutdown_forwarder_failure"
	| "retry_exhausted";

export type ArchiveLossRecord = {
	timestamp: string;
	source: BrokerArchiveSource;
	deployment_id: string;
	reason: ArchiveLossReason;
	payload: BrokerArchiveRow;
	record_version: typeof LOSS_JOURNAL_RECORD_VERSION;
	batch_id: string | null;
	batch_row_index: number;
	batch_row_count: number;
};

export type ParsedArchiveLossRecord =
	| ArchiveLossRecord
	| Omit<
			ArchiveLossRecord,
			"record_version" | "batch_id" | "batch_row_index" | "batch_row_count"
	  >;

export type ParsedLossJournalLine =
	| { ok: true; record: ParsedArchiveLossRecord }
	| { ok: false; reason: string };

const LOSS_REASONS = new Set<ArchiveLossReason>([
	"queue_shed",
	"shutdown_forwarder_failure",
	"retry_exhausted",
]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLossJournalLine(line: string): ParsedLossJournalLine {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { ok: false, reason: "invalid JSON" };
	}
	if (!isObject(parsed)) {
		return { ok: false, reason: "record is not an object" };
	}
	if (
		typeof parsed.timestamp !== "string" ||
		typeof parsed.source !== "string" ||
		(parsed.source !== "broker_read" && parsed.source !== "broker_write") ||
		typeof parsed.deployment_id !== "string" ||
		typeof parsed.reason !== "string" ||
		!LOSS_REASONS.has(parsed.reason as ArchiveLossReason) ||
		!isObject(parsed.payload) ||
		typeof parsed.payload.table !== "string" ||
		!isObject(parsed.payload.row)
	) {
		return {
			ok: false,
			reason: "record is missing or has invalid required fields",
		};
	}

	const base = {
		timestamp: parsed.timestamp,
		source: parsed.source,
		deployment_id: parsed.deployment_id,
		reason: parsed.reason as ArchiveLossReason,
		payload: {
			table: parsed.payload.table,
			row: parsed.payload.row,
		},
	};
	if (parsed.record_version === undefined) {
		return { ok: true, record: base };
	}
	if (
		parsed.record_version !== LOSS_JOURNAL_RECORD_VERSION ||
		(parsed.batch_id !== null && typeof parsed.batch_id !== "string") ||
		!Number.isSafeInteger(parsed.batch_row_index) ||
		!Number.isSafeInteger(parsed.batch_row_count) ||
		(parsed.batch_row_index as number) < 0 ||
		(parsed.batch_row_count as number) < 1 ||
		(parsed.batch_row_index as number) >= (parsed.batch_row_count as number)
	) {
		return { ok: false, reason: "record has invalid versioned batch metadata" };
	}
	return {
		ok: true,
		record: {
			...base,
			record_version: LOSS_JOURNAL_RECORD_VERSION,
			batch_id: parsed.batch_id,
			batch_row_index: parsed.batch_row_index as number,
			batch_row_count: parsed.batch_row_count as number,
		},
	};
}

export function lossJournalLineDigest(rawLine: string): string {
	return createHash("sha256").update(rawLine).digest("hex");
}
