#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import {
	findTableRowLimitViolation,
	MAX_ARCHIVE_BODY_BYTES,
	MAX_ARCHIVE_ROWS,
	MAX_ARCHIVE_ROWS_BY_TABLE,
} from "../services/archive-forwarder/limits";
import { isSupportedTable } from "../services/archive-forwarder/types";
import {
	LOSS_JOURNAL_RECORD_VERSION,
	lossJournalLineDigest,
	type ParsedArchiveLossRecord,
	parseLossJournalLine,
} from "../src/helpers/broker-execution-archive/loss-journal";

const FRESH_BATCH_PREFIX = "cex-archive-replay-v1\0";
const FRESH_BODY_BUDGET = Math.floor(MAX_ARCHIVE_BODY_BYTES * 0.95);
const ACCEPTED_MEANING =
	"accepted means the forwarder committed the insert. It does not prove new rows were written: a token-deduplicated insert returns the same success as a first delivery, and this tool does not query ClickHouse.";

export type ReplayStatus =
	| "accepted"
	| "blocked_unsupported_table"
	| "blocked_conflict"
	| "failed_transient";

type ReportStatus = ReplayStatus | "unparseable" | "pending";

type JournalEntry = {
	lineNo: number;
	rawLine: string;
	digest: string;
	record: ParsedArchiveLossRecord;
};

type ReplayBatch = {
	batchId: string;
	identity: "original" | "fresh";
	source: string;
	deploymentId: string;
	entries: JournalEntry[];
	oversized: boolean;
};

type LedgerIntent = {
	kind: "intent";
	batch_id: string;
	journal: string;
	lines: number[];
	table: string;
	row_count: number;
	at: string;
};

type LedgerOutcome = {
	kind: "outcome";
	batch_id: string;
	status: ReplayStatus;
	http_status?: number;
	detail?: string;
	at: string;
};

type OutcomeCounts = Record<ReportStatus, number>;

export type ArchiveLossReplaySummary = {
	journal: string;
	ledger: string;
	dry_run: boolean;
	lines: {
		total: number;
		parsed: number;
		unparseable: Array<{ line: number; reason: string }>;
	};
	entries: OutcomeCounts & { total: number; skipped_by_ledger: number };
	batches: OutcomeCounts & {
		total: number;
		posted: number;
		skipped_by_ledger: number;
	};
	by_reason: Record<string, OutcomeCounts>;
	by_table: Record<string, OutcomeCounts>;
	warnings: string[];
	errors: string[];
	archive: { requested: boolean; archived_path?: string };
	accepted_meaning: string;
};

export type ArchiveLossReplayOptions = {
	journal: string;
	forwarderUrl?: string;
	token?: string;
	ledger?: string;
	dryRun?: boolean;
	limit?: number;
	json?: boolean;
	archive?: boolean;
	brokerStopped?: boolean;
};

export type ArchiveLossReplayResult = {
	exitCode: number;
	summary: ArchiveLossReplaySummary;
};

class ReplayUsageError extends Error {}

function emptyCounts(): OutcomeCounts {
	return {
		accepted: 0,
		blocked_unsupported_table: 0,
		blocked_conflict: 0,
		failed_transient: 0,
		unparseable: 0,
		pending: 0,
	};
}

function increment(
	report: ArchiveLossReplaySummary,
	entry: JournalEntry,
	status: ReportStatus,
): void {
	report.entries[status] += 1;
	const byReason = report.by_reason[entry.record.reason] ?? emptyCounts();
	report.by_reason[entry.record.reason] = byReason;
	byReason[status] += 1;
	const byTable = report.by_table[entry.record.payload.table] ?? emptyCounts();
	report.by_table[entry.record.payload.table] = byTable;
	byTable[status] += 1;
}

function entryHasBatchIdentity(entry: JournalEntry): entry is JournalEntry & {
	record: Extract<
		ParsedArchiveLossRecord,
		{ record_version: typeof LOSS_JOURNAL_RECORD_VERSION }
	> & { batch_id: string };
} {
	return (
		"record_version" in entry.record &&
		entry.record.record_version === LOSS_JOURNAL_RECORD_VERSION &&
		entry.record.batch_id !== null
	);
}

function freshBatchId(
	journalBasename: string,
	entries: JournalEntry[],
): string {
	const first = entries[0];
	if (!first) throw new Error("cannot identify an empty replay batch");
	return `replay-v1-${createHash("sha256")
		.update(
			`${FRESH_BATCH_PREFIX}${journalBasename}\0${first.lineNo}\0${entries
				.map(({ digest }) => digest)
				.join("\0")}`,
		)
		.digest("hex")}`;
}

function envelope(batch: ReplayBatch): Record<string, unknown> {
	return {
		source: batch.source,
		deployment_id: batch.deploymentId,
		batch_id: batch.batchId,
		rows: batch.entries.map(({ record }) => record.payload),
	};
}

function freshBodyBytes(
	journalBasename: string,
	entries: JournalEntry[],
): number {
	const first = entries[0];
	if (!first) return 0;
	return Buffer.byteLength(
		JSON.stringify({
			source: first.record.source,
			deployment_id: first.record.deployment_id,
			batch_id: freshBatchId(journalBasename, entries),
			rows: entries.map(({ record }) => record.payload),
		}),
	);
}

function makeFreshBatch(
	journalBasename: string,
	entries: JournalEntry[],
): ReplayBatch {
	const first = entries[0];
	if (!first) throw new Error("cannot create an empty replay batch");
	return {
		batchId: freshBatchId(journalBasename, entries),
		identity: "fresh",
		source: first.record.source,
		deploymentId: first.record.deployment_id,
		entries,
		oversized: freshBodyBytes(journalBasename, entries) >= FRESH_BODY_BUDGET,
	};
}

function chunkFreshEntries(
	journalBasename: string,
	entries: JournalEntry[],
): ReplayBatch[] {
	const batches: ReplayBatch[] = [];
	const first = entries[0];
	if (!first) return batches;
	const rowLimit = Math.min(
		MAX_ARCHIVE_ROWS,
		MAX_ARCHIVE_ROWS_BY_TABLE[first.record.payload.table] ?? MAX_ARCHIVE_ROWS,
	);
	let chunk: JournalEntry[] = [];
	for (const entry of entries) {
		const candidate = [...chunk, entry];
		if (
			chunk.length > 0 &&
			(candidate.length > rowLimit ||
				freshBodyBytes(journalBasename, candidate) >= FRESH_BODY_BUDGET)
		) {
			batches.push(makeFreshBatch(journalBasename, chunk));
			chunk = [entry];
		} else {
			chunk = candidate;
		}
	}
	if (chunk.length > 0) batches.push(makeFreshBatch(journalBasename, chunk));
	return batches;
}

function planBatches(
	journalBasename: string,
	entries: JournalEntry[],
	warnings: string[],
): ReplayBatch[] {
	const originalGroups = new Map<string, JournalEntry[]>();
	const freshEntries: JournalEntry[] = [];
	for (const entry of entries) {
		if (!entryHasBatchIdentity(entry)) {
			freshEntries.push(entry);
			continue;
		}
		const group = originalGroups.get(entry.record.batch_id) ?? [];
		group.push(entry);
		originalGroups.set(entry.record.batch_id, group);
	}

	const originalBatches: ReplayBatch[] = [];
	for (const [batchId, group] of originalGroups) {
		const first = group[0];
		if (!first || !entryHasBatchIdentity(first)) continue;
		const expectedCount = first.record.batch_row_count;
		const indices = new Set(
			group.map((entry) =>
				entryHasBatchIdentity(entry) ? entry.record.batch_row_index : -1,
			),
		);
		const agrees = group.every(
			(entry) =>
				entryHasBatchIdentity(entry) &&
				entry.record.source === first.record.source &&
				entry.record.deployment_id === first.record.deployment_id &&
				entry.record.batch_row_count === expectedCount,
		);
		const missing = Array.from(
			{ length: expectedCount },
			(_, index) => index,
		).filter((index) => !indices.has(index));
		const complete =
			agrees &&
			group.length === expectedCount &&
			indices.size === expectedCount &&
			missing.length === 0;
		if (!complete) {
			const suffix = agrees ? "" : "; metadata also disagrees";
			warnings.push(
				`Original batch ${batchId} is incomplete; missing indices: ${missing.length > 0 ? missing.join(", ") : "none"}${suffix}. Downgrading every available entry to fresh identity.`,
			);
			freshEntries.push(...group);
			continue;
		}
		const ordered = [...group].sort((left, right) => {
			if (!entryHasBatchIdentity(left) || !entryHasBatchIdentity(right))
				return 0;
			return left.record.batch_row_index - right.record.batch_row_index;
		});
		originalBatches.push({
			batchId,
			identity: "original",
			source: first.record.source,
			deploymentId: first.record.deployment_id,
			entries: ordered,
			oversized:
				ordered.length > MAX_ARCHIVE_ROWS ||
				findTableRowLimitViolation(
					ordered.map(({ record }) => record.payload),
				) !== undefined ||
				Buffer.byteLength(
					JSON.stringify({
						source: first.record.source,
						deployment_id: first.record.deployment_id,
						batch_id: batchId,
						rows: ordered.map(({ record }) => record.payload),
					}),
				) > MAX_ARCHIVE_BODY_BYTES,
		});
	}

	const freshGroups = new Map<string, JournalEntry[]>();
	for (const entry of freshEntries.sort((a, b) => a.lineNo - b.lineNo)) {
		const key = JSON.stringify([
			entry.record.source,
			entry.record.deployment_id,
			entry.record.payload.table,
		]);
		const group = freshGroups.get(key) ?? [];
		group.push(entry);
		freshGroups.set(key, group);
	}
	const batches = [
		...originalBatches,
		...Array.from(freshGroups.values()).flatMap((group) =>
			chunkFreshEntries(journalBasename, group),
		),
	];
	return batches.sort(
		(left, right) =>
			(left.entries[0]?.lineNo ?? 0) - (right.entries[0]?.lineNo ?? 0),
	);
}

function readJournal(path: string): {
	entries: JournalEntry[];
	unparseable: Array<{ line: number; reason: string }>;
	totalLines: number;
} {
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const entries: JournalEntry[] = [];
	const unparseable: Array<{ line: number; reason: string }> = [];
	for (const [index, rawLine] of lines.entries()) {
		const parsed = parseLossJournalLine(rawLine);
		if (!parsed.ok) {
			unparseable.push({ line: index + 1, reason: parsed.reason });
			continue;
		}
		entries.push({
			lineNo: index + 1,
			rawLine,
			digest: lossJournalLineDigest(rawLine),
			record: parsed.record,
		});
	}
	return { entries, unparseable, totalLines: lines.length };
}

function loadTerminalLedger(path: string): Map<string, ReplayStatus> {
	const terminal = new Map<string, ReplayStatus>();
	if (!existsSync(path)) return terminal;
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (const [index, line] of lines.entries()) {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			throw new Error(`Replay ledger line ${index + 1} is invalid JSON`);
		}
		if (!record || typeof record !== "object" || Array.isArray(record)) {
			throw new Error(`Replay ledger line ${index + 1} is not an object`);
		}
		const candidate = record as Record<string, unknown>;
		if (candidate.kind === "intent" && typeof candidate.batch_id === "string") {
			continue;
		}
		if (
			candidate.kind !== "outcome" ||
			typeof candidate.batch_id !== "string" ||
			!(
				[
					"accepted",
					"blocked_unsupported_table",
					"blocked_conflict",
					"failed_transient",
				] as unknown[]
			).includes(candidate.status)
		) {
			throw new Error(`Replay ledger line ${index + 1} has an invalid shape`);
		}
		if (candidate.status !== "failed_transient") {
			terminal.set(candidate.batch_id, candidate.status as ReplayStatus);
		}
	}
	return terminal;
}

function appendLedger(
	path: string,
	record: LedgerIntent | LedgerOutcome,
): void {
	const fd = openSync(path, "a", 0o600);
	try {
		const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
		const written = writeSync(fd, bytes);
		if (written !== bytes.length) {
			throw new Error(`wrote ${written} of ${bytes.length} ledger bytes`);
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function batchTable(batch: ReplayBatch): string {
	const tables = [
		...new Set(batch.entries.map(({ record }) => record.payload.table)),
	];
	return tables.length === 1 ? (tables[0] as string) : tables.join(",");
}

function detailFromBody(body: unknown): string | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body))
		return undefined;
	const error = (body as Record<string, unknown>).error;
	return typeof error === "string" ? error : undefined;
}

async function postBatch(
	batch: ReplayBatch,
	url: string,
	token?: string,
): Promise<
	| { outcome: LedgerOutcome }
	| { configurationError: string; httpStatus: 401 | 413 }
> {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(envelope(batch)),
		});
		let responseBody: unknown;
		try {
			responseBody = await response.json();
		} catch {
			responseBody = undefined;
		}
		if (response.status === 401 || response.status === 413) {
			return {
				configurationError: `Forwarder returned ${response.status}${detailFromBody(responseBody) ? `: ${detailFromBody(responseBody)}` : ""}`,
				httpStatus: response.status,
			};
		}
		let status: ReplayStatus;
		if (response.ok) {
			status = "accepted";
		} else if (response.status === 400) {
			const rejectedTables =
				responseBody && typeof responseBody === "object"
					? (responseBody as Record<string, unknown>).rejectedTables
					: undefined;
			status =
				Array.isArray(rejectedTables) && rejectedTables.length > 0
					? "blocked_unsupported_table"
					: "blocked_conflict";
		} else {
			status = "failed_transient";
		}
		return {
			outcome: {
				kind: "outcome",
				batch_id: batch.batchId,
				status,
				http_status: response.status,
				...(detailFromBody(responseBody)
					? { detail: detailFromBody(responseBody) }
					: {}),
				at: new Date().toISOString(),
			},
		};
	} catch (error) {
		return {
			outcome: {
				kind: "outcome",
				batch_id: batch.batchId,
				status: "failed_transient",
				detail: error instanceof Error ? error.message : String(error),
				at: new Date().toISOString(),
			},
		};
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function archiveJournal(path: string): string {
	// Never truncate in place: rows appended between the read and truncation would
	// be lost. Renaming is only safe after the operator asserts the broker is
	// stopped, because its O_APPEND descriptor otherwise follows the archived inode.
	const archivedPath = `${path}.replayed-${new Date().toISOString()}`;
	renameSync(path, archivedPath);
	return archivedPath;
}

function createSummary(
	options: ArchiveLossReplayOptions,
	journal: string,
	ledger: string,
): ArchiveLossReplaySummary {
	return {
		journal,
		ledger,
		dry_run: options.dryRun ?? false,
		lines: { total: 0, parsed: 0, unparseable: [] },
		entries: { total: 0, skipped_by_ledger: 0, ...emptyCounts() },
		batches: { total: 0, posted: 0, skipped_by_ledger: 0, ...emptyCounts() },
		by_reason: {},
		by_table: {},
		warnings: [],
		errors: [],
		archive: { requested: options.archive ?? false },
		accepted_meaning: ACCEPTED_MEANING,
	};
}

export async function runArchiveLossReplay(
	options: ArchiveLossReplayOptions,
): Promise<ArchiveLossReplayResult> {
	if (!options.journal.trim())
		throw new ReplayUsageError("--journal is required");
	if (options.archive && !options.brokerStopped) {
		throw new ReplayUsageError(
			"--archive is refused unless --broker-stopped is also passed",
		);
	}
	if (
		options.limit !== undefined &&
		(!Number.isSafeInteger(options.limit) || options.limit < 0)
	) {
		throw new ReplayUsageError("--limit must be a non-negative integer");
	}
	const journal = resolve(options.journal);
	const ledger = resolve(options.ledger ?? `${journal}.replay-ledger.jsonl`);
	if (journal === ledger) {
		throw new ReplayUsageError("--ledger must not be the input journal");
	}
	if (!options.dryRun && !options.forwarderUrl?.trim()) {
		throw new ReplayUsageError(
			"--forwarder-url or CEX_BROKER_ARCHIVE_FORWARDER_URL is required",
		);
	}

	const summary = createSummary(options, journal, ledger);
	const journalRead = readJournal(journal);
	summary.lines = {
		total: journalRead.totalLines,
		parsed: journalRead.entries.length,
		unparseable: journalRead.unparseable,
	};
	summary.entries.total = journalRead.totalLines;
	for (const _failure of journalRead.unparseable) {
		summary.entries.unparseable += 1;
		const counts = summary.by_reason["(unparseable)"] ?? emptyCounts();
		summary.by_reason["(unparseable)"] = counts;
		counts.unparseable += 1;
		const tableCounts = summary.by_table["(unparseable)"] ?? emptyCounts();
		summary.by_table["(unparseable)"] = tableCounts;
		tableCounts.unparseable += 1;
	}

	const batches = planBatches(
		basename(journal),
		journalRead.entries,
		summary.warnings,
	);
	summary.batches.total = batches.length;
	const terminalLedger = loadTerminalLedger(ledger);
	let stop = false;
	for (const batch of batches) {
		if (stop) {
			summary.batches.pending += 1;
			for (const entry of batch.entries) increment(summary, entry, "pending");
			continue;
		}
		const terminalStatus = terminalLedger.get(batch.batchId);
		if (terminalStatus) {
			summary.batches.skipped_by_ledger += 1;
			summary.batches[terminalStatus] += 1;
			summary.entries.skipped_by_ledger += batch.entries.length;
			for (const entry of batch.entries)
				increment(summary, entry, terminalStatus);
			continue;
		}
		const unsupported = [
			...new Set(
				batch.entries
					.map(({ record }) => record.payload.table)
					.filter((table) => !isSupportedTable(table)),
			),
		];
		if (options.dryRun) {
			const status: ReportStatus =
				unsupported.length > 0 ? "blocked_unsupported_table" : "pending";
			summary.batches[status] += 1;
			for (const entry of batch.entries) increment(summary, entry, status);
			continue;
		}
		if (
			unsupported.length === 0 &&
			summary.batches.posted >= (options.limit ?? Number.POSITIVE_INFINITY)
		) {
			summary.batches.pending += 1;
			for (const entry of batch.entries) increment(summary, entry, "pending");
			continue;
		}
		const intent: LedgerIntent = {
			kind: "intent",
			batch_id: batch.batchId,
			journal: basename(journal),
			lines: batch.entries.map(({ lineNo }) => lineNo),
			table: batchTable(batch),
			row_count: batch.entries.length,
			at: new Date().toISOString(),
		};
		appendLedger(ledger, intent);

		let outcome: LedgerOutcome;
		if (unsupported.length > 0) {
			outcome = {
				kind: "outcome",
				batch_id: batch.batchId,
				status: "blocked_unsupported_table",
				detail: `Unsupported table(s): ${unsupported.join(", ")}`,
				at: new Date().toISOString(),
			};
		} else if (batch.oversized) {
			summary.errors.push(
				`Batch ${batch.batchId} cannot fit within the forwarder limits without violating its identity invariant`,
			);
			summary.batches.pending += 1;
			for (const entry of batch.entries) increment(summary, entry, "pending");
			stop = true;
			continue;
		} else {
			summary.batches.posted += 1;
			const posted = await postBatch(
				batch,
				options.forwarderUrl as string,
				options.token,
			);
			if ("configurationError" in posted) {
				summary.errors.push(posted.configurationError);
				summary.batches.pending += 1;
				for (const entry of batch.entries) increment(summary, entry, "pending");
				stop = true;
				continue;
			}
			outcome = posted.outcome;
		}
		appendLedger(ledger, outcome);
		summary.batches[outcome.status] += 1;
		for (const entry of batch.entries)
			increment(summary, entry, outcome.status);
	}

	const everyEntryTerminal =
		!options.dryRun &&
		summary.entries.accepted +
			summary.entries.blocked_unsupported_table +
			summary.entries.blocked_conflict ===
			summary.entries.total;
	if (options.archive) {
		if (!everyEntryTerminal || summary.lines.unparseable.length > 0) {
			summary.errors.push(
				"--archive refused because not every journal entry has a terminal outcome or the journal contains unparseable lines",
			);
		} else {
			summary.archive.archived_path = archiveJournal(journal);
		}
	}

	const blocked =
		summary.entries.blocked_unsupported_table > 0 ||
		summary.entries.blocked_conflict > 0;
	const nonTerminal =
		summary.entries.failed_transient > 0 || summary.entries.pending > 0 || stop;
	const exitCode =
		blocked ||
		nonTerminal ||
		summary.lines.unparseable.length > 0 ||
		summary.errors.length > 0
			? 1
			: 0;
	return { exitCode, summary };
}

export function printArchiveLossReplayReport(
	result: ArchiveLossReplayResult,
	json: boolean,
): void {
	if (json) {
		console.log(JSON.stringify(result.summary));
		return;
	}
	const { summary } = result;
	console.log(`Journal: ${summary.journal}`);
	console.log(
		`Lines: ${summary.lines.total}; batches: ${summary.batches.total}; posted: ${summary.batches.posted}; skipped by ledger: ${summary.entries.skipped_by_ledger} entries in ${summary.batches.skipped_by_ledger} batches`,
	);
	console.log(
		`Entries: accepted=${summary.entries.accepted}, blocked_unsupported_table=${summary.entries.blocked_unsupported_table}, blocked_conflict=${summary.entries.blocked_conflict}, failed_transient=${summary.entries.failed_transient}, unparseable=${summary.entries.unparseable}, pending=${summary.entries.pending}`,
	);
	console.log(
		`Batch outcomes: accepted=${summary.batches.accepted}, blocked_unsupported_table=${summary.batches.blocked_unsupported_table}, blocked_conflict=${summary.batches.blocked_conflict}, failed_transient=${summary.batches.failed_transient}, pending=${summary.batches.pending}`,
	);
	for (const line of summary.lines.unparseable) {
		console.error(`Unparseable journal line ${line.line}: ${line.reason}`);
	}
	console.log("By reason:");
	for (const [reason, counts] of Object.entries(summary.by_reason)) {
		console.log(
			`  ${reason}: accepted=${counts.accepted}, blocked_unsupported_table=${counts.blocked_unsupported_table}, blocked_conflict=${counts.blocked_conflict}, failed_transient=${counts.failed_transient}, unparseable=${counts.unparseable}`,
		);
	}
	console.log("By table:");
	for (const [table, counts] of Object.entries(summary.by_table)) {
		console.log(
			`  ${table}: accepted=${counts.accepted}, blocked_unsupported_table=${counts.blocked_unsupported_table}, blocked_conflict=${counts.blocked_conflict}, failed_transient=${counts.failed_transient}, unparseable=${counts.unparseable}`,
		);
	}
	for (const warning of summary.warnings) console.warn(`Warning: ${warning}`);
	for (const error of summary.errors) console.error(`Error: ${error}`);
	console.log(ACCEPTED_MEANING);
	if (summary.archive.archived_path) {
		console.log(`Archived journal: ${summary.archive.archived_path}`);
	} else if (!summary.archive.requested) {
		const suggestedPath = `${summary.journal}.replayed-${new Date().toISOString()}`;
		console.log(
			`Journal retained. After stopping the broker, archive it with: mv -- ${shellQuote(summary.journal)} ${shellQuote(suggestedPath)}`,
		);
	}
}

export function parseArchiveLossReplayArgs(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): ArchiveLossReplayOptions {
	const options: ArchiveLossReplayOptions = {
		journal: "",
		forwarderUrl: env.CEX_BROKER_ARCHIVE_FORWARDER_URL?.trim() || undefined,
		token: env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN?.trim() || undefined,
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = () => {
			const next = args[index + 1];
			if (!next || next.startsWith("--")) {
				throw new ReplayUsageError(`${arg} requires a value`);
			}
			index += 1;
			return next;
		};
		switch (arg) {
			case "--journal":
				options.journal = value();
				break;
			case "--forwarder-url":
				options.forwarderUrl = value();
				break;
			case "--token":
				options.token = value();
				break;
			case "--ledger":
				options.ledger = value();
				break;
			case "--limit":
				options.limit = Number(value());
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--json":
				options.json = true;
				break;
			case "--archive":
				options.archive = true;
				break;
			case "--broker-stopped":
				options.brokerStopped = true;
				break;
			default:
				throw new ReplayUsageError(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

if (import.meta.main) {
	try {
		const options = parseArchiveLossReplayArgs(Bun.argv.slice(2));
		const result = await runArchiveLossReplay(options);
		printArchiveLossReplayReport(result, options.json ?? false);
		process.exitCode = result.exitCode;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = error instanceof ReplayUsageError ? 2 : 1;
	}
}
