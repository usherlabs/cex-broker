import type { ArchiveBatchRequest, ArchiveRow } from "./types";

export const STRATEGY_RUNTIME_SOURCES: ReadonlySet<string> = new Set([
	"hb_runtime",
	"maker_orchestrator",
]);
export const STRATEGY_REPLAY_SOURCE = "maker_replay";
export const STRATEGY_ARCHIVE_SOURCES: ReadonlySet<string> = new Set([
	...STRATEGY_RUNTIME_SOURCES,
	STRATEGY_REPLAY_SOURCE,
]);

export const STRATEGY_ARCHIVE_TABLES = [
	"strategy_data.policy_evaluation_events",
	"strategy_data.strategy_policy_snapshots",
	"strategy_data.market_identity",
	"strategy_data.symbol_mapping",
	"strategy_data.inventory_settlement_events",
] as const;

export type StrategyArchiveTable = (typeof STRATEGY_ARCHIVE_TABLES)[number];

export type StrategyBatchClassification =
	| "strategy_runtime"
	| "strategy_replay"
	| "direct"
	| "invalid_strategy_source"
	| "invalid_strategy_mix";

export type StrategyContractValidation =
	| { ok: true }
	| { ok: false; error: string };

export function isStrategyArchiveTable(
	table: unknown,
): table is StrategyArchiveTable {
	return (
		typeof table === "string" &&
		(STRATEGY_ARCHIVE_TABLES as readonly string[]).includes(table)
	);
}

function rawRows(value: unknown): unknown[] {
	if (!value || typeof value !== "object") return [];
	const rows = (value as { rows?: unknown }).rows;
	return Array.isArray(rows) ? rows : [];
}

function rawSource(value: unknown): unknown {
	return value && typeof value === "object"
		? (value as { source?: unknown }).source
		: undefined;
}

function entryTable(entry: unknown): unknown {
	return entry && typeof entry === "object"
		? (entry as { table?: unknown }).table
		: undefined;
}

export function classifyStrategyArchiveBatch(
	value: unknown,
): StrategyBatchClassification {
	const rows = rawRows(value);
	const source = rawSource(value);
	const hasStrategyRows = rows.some((entry) =>
		isStrategyArchiveTable(entryTable(entry)),
	);

	if (typeof source === "string" && STRATEGY_ARCHIVE_SOURCES.has(source)) {
		const onlyStrategyRows =
			rows.length > 0 &&
			rows.every((entry) => isStrategyArchiveTable(entryTable(entry)));
		if (!onlyStrategyRows) return "invalid_strategy_mix";
		return source === STRATEGY_REPLAY_SOURCE
			? "strategy_replay"
			: "strategy_runtime";
	}
	return hasStrategyRows ? "invalid_strategy_source" : "direct";
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function positiveSequence(value: unknown): boolean {
	if (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0
	) {
		return true;
	}
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false;
	return BigInt(value) <= 18_446_744_073_709_551_615n;
}

function validateV2Row(row: Record<string, unknown>): string | undefined {
	for (const field of [
		"producer_id",
		"producer_run_id",
		"stream_name",
		"archive_event_id",
	] as const) {
		if (!nonEmptyString(row[field])) return `Missing v2 field: ${field}`;
	}
	for (const field of ["stream_seq", "seq"] as const) {
		if (!positiveSequence(row[field])) return `Invalid v2 field: ${field}`;
	}
	return undefined;
}

function validateStrategyRow(
	entry: unknown,
	source: string,
	deploymentId: string,
): string | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return "Malformed strategy row entry";
	}
	const archiveRow = entry as Partial<ArchiveRow>;
	if (!isStrategyArchiveTable(archiveRow.table)) {
		return "Unsupported strategy table";
	}
	if (
		!archiveRow.row ||
		typeof archiveRow.row !== "object" ||
		Array.isArray(archiveRow.row)
	) {
		return "Malformed strategy row body";
	}
	const row = archiveRow.row;
	if (row.source !== undefined && row.source !== source) {
		return "Row source does not match envelope";
	}
	if (
		row.deployment_id !== undefined &&
		row.deployment_id !== deploymentId
	) {
		return "Row deployment does not match envelope";
	}

	const version = row.schema_version;
	if (version === undefined || version === "" || version === "1") {
		return undefined;
	}
	if (version !== "2") return "Unsupported strategy schema version";
	return validateV2Row(row);
}

export function validateStrategyArchiveBatch(
	value: unknown,
): StrategyContractValidation {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, error: "Malformed strategy envelope" };
	}
	const envelope = value as Partial<ArchiveBatchRequest>;
	if (!nonEmptyString(envelope.source)) {
		return { ok: false, error: "Missing strategy envelope source" };
	}
	if (!nonEmptyString(envelope.deployment_id)) {
		return { ok: false, error: "Missing strategy deployment id" };
	}
	if (!Array.isArray(envelope.rows) || envelope.rows.length === 0) {
		return { ok: false, error: "Strategy envelope rows must be non-empty" };
	}
	if (envelope.rows.length > 1_000) {
		return { ok: false, error: "Too many strategy rows" };
	}
	const classification = classifyStrategyArchiveBatch(envelope);
	if (
		classification !== "strategy_runtime" &&
		classification !== "strategy_replay"
	) {
		return { ok: false, error: "Invalid strategy source or table mix" };
	}
	for (const entry of envelope.rows) {
		const error = validateStrategyRow(
			entry,
			envelope.source,
			envelope.deployment_id,
		);
		if (error) return { ok: false, error };
	}
	return { ok: true };
}
