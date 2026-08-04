import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { groupRowsByTable } from "./insert";
import type { StrategyArchiveTable } from "./strategy-contract";
import type { ArchiveBatchRequest } from "./types";

export const STRATEGY_SPOOL_MAX_BYTES = 1_073_741_824;
export const STRATEGY_SPOOL_RETENTION_MS = 72 * 60 * 60 * 1_000;
export const DEFAULT_STRATEGY_SPOOL_PATH = "./archive-forwarder-spool.sqlite";

const WORK_METADATA_BYTES = 256;

function canonicalSerialize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Spool values must be finite");
		return Object.is(value, -0) ? "0" : JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalSerialize).join(",")}]`;
	}
	if (typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, entry]) =>
					`${JSON.stringify(key)}:${canonicalSerialize(entry)}`,
			)
			.join(",")}}`;
	}
	throw new Error(`Unsupported spool value: ${typeof value}`);
}

type SpoolLimits = {
	maxBytes: number;
	retentionMs: number;
};

export type StrategySpoolOptions = {
	path?: string;
	now?: () => number;
	/** Deterministic test seam. Runtime construction always uses fixed constants. */
	limits?: Partial<SpoolLimits>;
};

export type StrategySpoolAdmission = {
	batchId: string;
	accountedBytes: number;
};

export type StrategySpoolWork = {
	batchId: string;
	table: StrategyArchiveTable;
	rows: Record<string, unknown>[];
	dedupeToken: string;
	attemptCount: number;
	admittedAtMs: number;
	expiresAtMs: number;
};

export type StrategySpoolStats = {
	queuedBatches: number;
	queuedWork: number;
	terminalWork: number;
	expiredWork: number;
	accountedBytes: number;
	oldestAgeMs: number;
	lastErrorClass: string;
};

export class StrategySpoolQuotaError extends Error {
	constructor() {
		super("Strategy archive spool quota exceeded");
		this.name = "StrategySpoolQuotaError";
	}
}

export class StrategySpoolUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StrategySpoolUnavailableError";
	}
}

type WorkRow = {
	batch_id: string;
	table_name: StrategyArchiveTable;
	rows_json: string;
	dedupe_token: string;
	attempt_count: number;
	admitted_at_ms: number;
	expires_at_ms: number;
};

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function dedupeToken(batchId: string, table: string): string {
	return createHash("sha256")
		.update(`maker-archive-forwarder-v1\0${batchId}\0${table}`)
		.digest("hex");
}

function groupedRows(batch: ArchiveBatchRequest) {
	return [...groupRowsByTable(batch.rows)].map(([table, rows]) => ({
		table: table as StrategyArchiveTable,
		rows,
		rowsJson: canonicalSerialize(rows),
	}));
}

export class StrategyArchiveSpool {
	private readonly database: Database;
	private readonly now: () => number;
	private readonly limits: SpoolLimits;
	public readonly path: string;

	constructor(options: StrategySpoolOptions = {}) {
		this.path = options.path?.trim() || DEFAULT_STRATEGY_SPOOL_PATH;
		this.now = options.now ?? Date.now;
		this.limits = {
			maxBytes: options.limits?.maxBytes ?? STRATEGY_SPOOL_MAX_BYTES,
			retentionMs:
				options.limits?.retentionMs ?? STRATEGY_SPOOL_RETENTION_MS,
		};
		try {
			this.database = new Database(this.path, { create: true, strict: true });
			this.configure();
			this.migrate();
		} catch (error) {
			throw new StrategySpoolUnavailableError(
				`Unable to initialize strategy archive spool at ${this.path}`,
				{ cause: error },
			);
		}
	}

	private configure(): void {
		this.database.exec("PRAGMA journal_mode = WAL");
		this.database.exec("PRAGMA foreign_keys = ON");
		this.database.exec("PRAGMA busy_timeout = 5000");
		this.database.exec("PRAGMA synchronous = FULL");
	}

	private migrate(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS strategy_spool_batches (
				batch_id TEXT PRIMARY KEY,
				source TEXT NOT NULL,
				deployment_id TEXT NOT NULL,
				admitted_at_ms INTEGER NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes > 0),
				envelope_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS strategy_spool_work (
				batch_id TEXT NOT NULL REFERENCES strategy_spool_batches(batch_id) ON DELETE CASCADE,
				table_name TEXT NOT NULL,
				rows_json TEXT NOT NULL,
				dedupe_token TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'terminal')),
				attempt_count INTEGER NOT NULL DEFAULT 0,
				next_attempt_at_ms INTEGER NOT NULL,
				last_error_class TEXT NOT NULL DEFAULT '',
				last_error_at_ms INTEGER,
				PRIMARY KEY (batch_id, table_name)
			);
			CREATE INDEX IF NOT EXISTS strategy_spool_work_due
				ON strategy_spool_work(state, next_attempt_at_ms);
			CREATE TABLE IF NOT EXISTS strategy_spool_health (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				last_checked_at_ms INTEGER NOT NULL
			);
			INSERT OR IGNORE INTO strategy_spool_health(id, last_checked_at_ms) VALUES (1, 0);
			CREATE TABLE IF NOT EXISTS strategy_spool_counters (
				name TEXT PRIMARY KEY,
				value INTEGER NOT NULL DEFAULT 0
			);
			INSERT OR IGNORE INTO strategy_spool_counters(name, value) VALUES ('expired_work', 0);
		`);
	}

	public accountedBytes(batch: ArchiveBatchRequest): number {
		const envelopeJson = canonicalSerialize(batch);
		return groupedRows(batch).reduce(
			(total, group) =>
				total +
				utf8Bytes(group.table) +
				utf8Bytes(group.rowsJson) +
				64 +
				WORK_METADATA_BYTES,
			utf8Bytes(envelopeJson),
		);
	}

	public admit(batch: ArchiveBatchRequest): StrategySpoolAdmission {
		const admittedAtMs = this.now();
		const expiresAtMs = admittedAtMs + this.limits.retentionMs;
		const batchId = randomUUID();
		const envelopeJson = canonicalSerialize(batch);
		const groups = groupedRows(batch);
		const accountedBytes = this.accountedBytes(batch);
		try {
			const transaction = this.database.transaction(() => {
				this.deleteExpired(admittedAtMs);
			const current = this.database
				.query<{ used: number }, []>(
					"SELECT COALESCE(SUM(accounted_bytes), 0) AS used FROM strategy_spool_batches",
				)
				.get()?.used ?? 0;
			if (current + accountedBytes > this.limits.maxBytes) {
				throw new StrategySpoolQuotaError();
			}
			this.database
				.query(
					`INSERT INTO strategy_spool_batches
					(batch_id, source, deployment_id, admitted_at_ms, expires_at_ms, accounted_bytes, envelope_json)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
				)
				.run(
					batchId,
					batch.source,
					batch.deployment_id,
					admittedAtMs,
					expiresAtMs,
					accountedBytes,
					envelopeJson,
				);
			for (const group of groups) {
				this.database
					.query(
						`INSERT INTO strategy_spool_work
						(batch_id, table_name, rows_json, dedupe_token, next_attempt_at_ms)
						VALUES (?1, ?2, ?3, ?4, ?5)`,
					)
					.run(
						batchId,
						group.table,
						group.rowsJson,
						dedupeToken(batchId, group.table),
						admittedAtMs,
					);
			}
			});
			transaction.immediate();
			return { batchId, accountedBytes };
		} catch (error) {
			if (error instanceof StrategySpoolQuotaError) throw error;
			throw new StrategySpoolUnavailableError(
				"Unable to commit strategy archive batch",
				{ cause: error },
			);
		}
	}

	public dueWork(limit = 100): StrategySpoolWork[] {
		const rows = this.database
			.query<WorkRow, [number, number]>(
				`SELECT w.batch_id, w.table_name, w.rows_json, w.dedupe_token,
					w.attempt_count, b.admitted_at_ms, b.expires_at_ms
				FROM strategy_spool_work w
				JOIN strategy_spool_batches b ON b.batch_id = w.batch_id
				WHERE w.state = 'pending' AND w.next_attempt_at_ms <= ?1 AND b.expires_at_ms > ?1
				ORDER BY w.next_attempt_at_ms, b.admitted_at_ms, w.table_name
				LIMIT ?2`,
			)
			.all(this.now(), limit);
		return rows.map((row) => ({
			batchId: row.batch_id,
			table: row.table_name,
			rows: JSON.parse(row.rows_json) as Record<string, unknown>[],
			dedupeToken: row.dedupe_token,
			attemptCount: row.attempt_count,
			admittedAtMs: row.admitted_at_ms,
			expiresAtMs: row.expires_at_ms,
		}));
	}

	public complete(work: Pick<StrategySpoolWork, "batchId" | "table">): void {
		const transaction = this.database.transaction(() => {
			this.database
				.query(
					"DELETE FROM strategy_spool_work WHERE batch_id = ?1 AND table_name = ?2",
				)
				.run(work.batchId, work.table);
			this.database
				.query(
					`DELETE FROM strategy_spool_batches
					WHERE batch_id = ?1
					AND NOT EXISTS (SELECT 1 FROM strategy_spool_work WHERE batch_id = ?1)`,
				)
				.run(work.batchId);
		});
		transaction.immediate();
	}

	public reschedule(
		work: Pick<StrategySpoolWork, "batchId" | "table">,
		failure: { nextAttemptAtMs: number; errorClass: string },
	): void {
		this.database
			.query(
				`UPDATE strategy_spool_work
				SET attempt_count = attempt_count + 1,
					next_attempt_at_ms = ?3,
					last_error_class = ?4,
					last_error_at_ms = ?5
				WHERE batch_id = ?1 AND table_name = ?2`,
			)
			.run(
				work.batchId,
				work.table,
				failure.nextAttemptAtMs,
				failure.errorClass,
				this.now(),
			);
	}

	public markTerminal(
		work: Pick<StrategySpoolWork, "batchId" | "table">,
		errorClass: string,
	): void {
		this.database
			.query(
				`UPDATE strategy_spool_work
				SET state = 'terminal', attempt_count = attempt_count + 1,
					last_error_class = ?3, last_error_at_ms = ?4
				WHERE batch_id = ?1 AND table_name = ?2`,
			)
			.run(work.batchId, work.table, errorClass, this.now());
	}

	private deleteExpired(now: number): number {
		const count =
			this.database
				.query<{ count: number }, [number]>(
					`SELECT COUNT(*) AS count FROM strategy_spool_work w
					JOIN strategy_spool_batches b ON b.batch_id = w.batch_id
					WHERE b.expires_at_ms <= ?1`,
				)
				.get(now)?.count ?? 0;
		this.database
			.query("DELETE FROM strategy_spool_batches WHERE expires_at_ms <= ?1")
			.run(now);
		if (count > 0) {
			this.database
				.query(
					"UPDATE strategy_spool_counters SET value = value + ?1 WHERE name = 'expired_work'",
				)
				.run(count);
		}
		return count;
	}

	public expire(): number {
		const transaction = this.database.transaction(() =>
			this.deleteExpired(this.now()),
		);
		return transaction.immediate();
	}

	public stats(): StrategySpoolStats {
		const now = this.now();
		const row = this.database
			.query<
				{
					queued_batches: number;
					queued_work: number;
					terminal_work: number;
					expired_work: number;
					accounted_bytes: number;
					oldest_admitted_at_ms: number | null;
					last_error_class: string | null;
				},
				[]
			>(
				`SELECT
					(SELECT COUNT(*) FROM strategy_spool_batches) AS queued_batches,
					(SELECT COUNT(*) FROM strategy_spool_work) AS queued_work,
					(SELECT COUNT(*) FROM strategy_spool_work WHERE state = 'terminal') AS terminal_work,
					(SELECT value FROM strategy_spool_counters WHERE name = 'expired_work') AS expired_work,
					(SELECT COALESCE(SUM(accounted_bytes), 0) FROM strategy_spool_batches) AS accounted_bytes,
					(SELECT MIN(admitted_at_ms) FROM strategy_spool_batches) AS oldest_admitted_at_ms,
					(SELECT last_error_class FROM strategy_spool_work
					 WHERE last_error_class <> '' ORDER BY last_error_at_ms DESC LIMIT 1) AS last_error_class`,
			)
			.get();
		return {
			queuedBatches: row?.queued_batches ?? 0,
			queuedWork: row?.queued_work ?? 0,
			terminalWork: row?.terminal_work ?? 0,
			expiredWork: row?.expired_work ?? 0,
			accountedBytes: row?.accounted_bytes ?? 0,
			oldestAgeMs:
				row?.oldest_admitted_at_ms == null
					? 0
					: Math.max(0, now - row.oldest_admitted_at_ms),
			lastErrorClass: row?.last_error_class ?? "none",
		};
	}

	public assertWritable(): StrategySpoolStats {
		try {
			if (this.path !== ":memory:" && (statSync(this.path).mode & 0o222) === 0) {
				throw new Error("Strategy archive spool file has no writable mode bit");
			}
			const transaction = this.database.transaction(() => {
				this.database
					.query(
						"UPDATE strategy_spool_health SET last_checked_at_ms = ?1 WHERE id = 1",
					)
					.run(this.now());
			});
			transaction.immediate();
			return this.stats();
		} catch (error) {
			throw new StrategySpoolUnavailableError(
				"Strategy archive spool is not writable",
				{ cause: error },
			);
		}
	}

	public close(): void {
		this.database.close();
	}
}
