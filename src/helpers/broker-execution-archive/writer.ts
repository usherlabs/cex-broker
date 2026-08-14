import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import {
	type ClientRequest,
	request as httpRequest,
	type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { log } from "../logger";
import type { OtelLogs, OtelMetrics } from "../otel";
import { REDACTED_ERROR_MESSAGE } from "../shared/errors";
import {
	type ArchiveLossReason,
	type ArchiveLossRecord,
	LOSS_JOURNAL_RECORD_VERSION,
} from "./loss-journal";
import {
	BROKER_WRITE_SOURCE,
	type BrokerArchiveRow,
	type BrokerArchiveSource,
	type BrokerArchiveTable,
} from "./types";

const BROKER_EXECUTION_ARCHIVE_TABLES = new Set<BrokerArchiveTable>([
	"broker_execution.order_events",
	"broker_execution.market_metadata_snapshots",
	"broker_execution.transfer_events",
	"broker_execution.fill_events",
]);

export function isBrokerExecutionArchiveTable(
	table: BrokerArchiveTable,
): boolean {
	return BROKER_EXECUTION_ARCHIVE_TABLES.has(table);
}

export type BrokerExecutionArchiverOptions = {
	source?: BrokerArchiveSource;
	deploymentId?: string;
	otelLogs?: OtelLogs;
	otelMetrics?: OtelMetrics;
	forwarderUrl: string;
	deadLetterPath: string;
	maxQueueSize?: number;
	batchSize?: number;
	flushIntervalMs?: number;
	forwarderTimeoutMs?: number;
};

export class BrokerExecutionArchiveDurabilityError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "BrokerExecutionArchiveDurabilityError";
	}
}

export function rethrowArchiveDurabilityError(error: unknown): void {
	if (error instanceof BrokerExecutionArchiveDurabilityError) {
		throw error;
	}
}

type ArchiverStats = {
	enqueued: number;
	shed: number;
	flushed: number;
	forwarderFailures: number;
};

export type BrokerExecutionArchiveHealthSnapshot = {
	healthy: boolean;
	queue_depth: number;
	oldest_pending_age_ms: number;
	shed_total: number;
	last_failure_at: number | null;
	last_shed_at: number | null;
	last_success_at: number | null;
	sink_latency_ms: number | null;
	sink_errors_total: number;
	in_flight: boolean;
	in_flight_age_ms: number;
};

const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_FORWARDER_TIMEOUT_MS = 3_000;
const SHED_WARN_INTERVAL_MS = 60_000;
// A pinned batch is retried verbatim, so a batch the forwarder rejects for its
// own content (an unknown table after a version skew, say) would otherwise pin
// the archive plane behind it forever. Give up after this many attempts and
// journal it, the same terms every other undeliverable row gets.
const MAX_PINNED_BATCH_ATTEMPTS = 10;

type QueuedArchiveRow = BrokerArchiveRow;

/**
 * A batch the forwarder did not accept, held aside instead of being pushed back
 * into the queue. The retry must re-post byte-identical rows under the same
 * `batchId`: that pair is what lets the forwarder recognise the re-post and skip
 * the tables that already landed before a sibling table failed. Rows mixed back
 * into the queue could not offer that — new arrivals and the oldest-first shed
 * both reshape the next batch.
 */
type PinnedRetryBatch = {
	batchId: string;
	rows: QueuedArchiveRow[];
	attempts: number;
};

const MARKET_FEEDS = new Set(["ORDERBOOK", "TICKER", "TRADES", "OHLCV"]);

function archiveFeed(row: BrokerArchiveRow): string {
	const declared = row.row.feed ?? row.row.stream_type;
	if (typeof declared === "string" && MARKET_FEEDS.has(declared)) {
		return declared;
	}
	if (
		row.table === "market_data.orderbook_snapshots" ||
		row.table.startsWith("market_data.cex_order_book_")
	) {
		return "ORDERBOOK";
	}
	if (
		row.table === "market_data.candles" ||
		row.table === "market_data.cex_ohlcv"
	) {
		return "OHLCV";
	}
	if (row.table === "market_data.cex_ticker_events") return "TICKER";
	if (row.table === "market_data.cex_trades") return "TRADES";
	return "NON_MARKET";
}

export function isArchiveOtelLogsEnabled(): boolean {
	return process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED === "true";
}

export function resolveArchiveForwarderUrlFromEnv(): string | undefined {
	return process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL?.trim() || undefined;
}

export function resolveArchiveSourceFromEnv(
	value = process.env.CEX_BROKER_ARCHIVE_SOURCE,
): BrokerArchiveSource {
	const source = value?.trim() || BROKER_WRITE_SOURCE;
	if (source !== "broker_read" && source !== "broker_write") {
		throw new Error(
			"CEX_BROKER_ARCHIVE_SOURCE must be broker_read or broker_write",
		);
	}
	return source;
}

export class BrokerExecutionArchiver {
	private readonly source: BrokerArchiveSource;
	private readonly deploymentId: string;
	private readonly otelLogs?: OtelLogs;
	private readonly otelMetrics?: OtelMetrics;
	private readonly forwarderUrl?: string;
	private readonly deadLetterPath?: string;
	private deadLetterFd?: number;
	private readonly maxQueueSize: number;
	private readonly batchSize: number;
	private readonly flushIntervalMs: number;
	private readonly forwarderTimeoutMs: number;
	private readonly queue: QueuedArchiveRow[] = [];
	private readonly enqueueTimes = new WeakMap<QueuedArchiveRow, number>();
	private readonly stats: ArchiverStats = {
		enqueued: 0,
		shed: 0,
		flushed: 0,
		forwarderFailures: 0,
	};
	private pendingRetry: PinnedRetryBatch | null = null;
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private flushInFlight: Promise<void> | null = null;
	private inFlightBatch: QueuedArchiveRow[] | null = null;
	private inFlightStartedAtMs: number | null = null;
	private lastFailureAtMs: number | null = null;
	private lastShedAtMs: number | null = null;
	private lastSuccessAtMs: number | null = null;
	private lastFailureEventSequence: number | null = null;
	private lastShedEventSequence: number | null = null;
	private lastSuccessEventSequence: number | null = null;
	private lastSinkLatencyMs: number | null = null;
	private healthEventSequence = 0;
	private lastShedWarnAtMs = 0;
	private closing = false;
	private closed = false;
	private readonly enabled: boolean;
	private readonly forwarderAuthToken?: string;

	private constructor(options: {
		enabled: boolean;
		source?: BrokerArchiveSource;
		deploymentId?: string;
		otelLogs?: OtelLogs;
		otelMetrics?: OtelMetrics;
		forwarderUrl?: string;
		deadLetterPath?: string;
		maxQueueSize?: number;
		batchSize?: number;
		flushIntervalMs?: number;
		forwarderTimeoutMs?: number;
	}) {
		this.source = options.source ?? BROKER_WRITE_SOURCE;
		this.deploymentId =
			options.deploymentId?.trim() ||
			process.env.CEX_BROKER_DEPLOYMENT_ID?.trim() ||
			"unknown";
		this.otelLogs = options.otelLogs;
		this.otelMetrics = options.otelMetrics;
		this.forwarderUrl = options.forwarderUrl?.trim();
		this.deadLetterPath = options.deadLetterPath?.trim();
		this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.forwarderTimeoutMs =
			options.forwarderTimeoutMs ?? DEFAULT_FORWARDER_TIMEOUT_MS;
		this.enabled = options.enabled;
		this.forwarderAuthToken =
			process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN?.trim() || undefined;

		if (!this.enabled) {
			log.info("Broker execution archive disabled", { enabled: false });
			return;
		}

		validateForwarderUrl(this.forwarderUrl);
		if (!this.deadLetterPath) {
			throw new Error(
				"Broker execution archive is enabled but CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH is missing",
			);
		}
		try {
			// The mode applies only when creating the file; existing operator-owned
			// files retain their configured permissions.
			this.deadLetterFd = openSync(this.deadLetterPath, "a", 0o600);
		} catch {
			throw new Error(
				"Broker execution archive cannot open CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH for append",
			);
		}

		try {
			this.flushTimer = setInterval(() => {
				this.emitArchiveHealthMetrics();
				void this.flush();
			}, this.flushIntervalMs);
			this.flushTimer.unref?.();
			log.info("Broker execution archive enabled", {
				enabled: true,
				source: this.source,
				otel_mirror_enabled: Boolean(this.otelLogs?.isOtelEnabled()),
			});
		} catch (error) {
			this.closeLossJournal();
			throw error;
		}
	}

	static disabled(): BrokerExecutionArchiver {
		return new BrokerExecutionArchiver({ enabled: false });
	}

	static create(
		options: BrokerExecutionArchiverOptions,
	): BrokerExecutionArchiver {
		return new BrokerExecutionArchiver({ ...options, enabled: true });
	}

	getDeploymentId(): string {
		return this.deploymentId;
	}

	getSource(): BrokerArchiveSource {
		return this.source;
	}

	isEnabled(): boolean {
		return this.enabled && !this.closing && !this.closed;
	}

	canPersistMarketMetadataSnapshot(): boolean {
		return this.isEnabled();
	}

	canPersistAccountBalanceSnapshots(): boolean {
		return this.isEnabled() && Boolean(this.forwarderUrl);
	}

	enqueue(row: BrokerArchiveRow): void {
		if (!this.enabled || this.closed) {
			return;
		}
		// Archive role is deployment identity. Stamp it at the durability boundary
		// so no request metadata or legacy row-builder default can contradict the
		// immutable envelope source.
		const archiveRow: BrokerArchiveRow = {
			table: row.table,
			row: { ...row.row, source: this.source },
		};
		if (this.queue.length >= this.maxQueueSize) {
			const shedEntry = this.queue[0];
			if (shedEntry) {
				this.appendLossRecords([shedEntry], "queue_shed");
				this.queue.shift();
			}
			this.stats.shed += 1;
			this.recordHealthEvent("shed");
			void this.recordArchiveMetric("cex_archive_rows_shed_total", {
				table: shedEntry?.table ?? "unknown",
				source: this.source,
				feed: shedEntry ? archiveFeed(shedEntry) : "NON_MARKET",
			});
			void this.recordArchiveMetric("cex_archive_queue_saturated_rows_total", {
				table: shedEntry?.table ?? "unknown",
				source: this.source,
				feed: shedEntry ? archiveFeed(shedEntry) : "NON_MARKET",
			});
			// The durable journal is authoritative; this rate-limited warning makes
			// sustained queue pressure visible without becoming another loss sink.
			const now = Date.now();
			if (now - this.lastShedWarnAtMs >= SHED_WARN_INTERVAL_MS) {
				log.warn("Archive queue full: shedding oldest rows", {
					shed_total: this.stats.shed,
					queue_max: this.maxQueueSize,
					table: shedEntry?.table ?? "unknown",
				});
				this.lastShedWarnAtMs = now;
			}
		}
		this.enqueueTimes.set(archiveRow, Date.now());
		this.queue.push(archiveRow);
		this.stats.enqueued += 1;
		void this.recordArchiveMetric("cex_archive_rows_enqueued_total", {
			table: archiveRow.table,
			source: this.source,
			feed: archiveFeed(archiveRow),
		});
		this.emitArchiveHealthMetrics();
		if (this.queue.length >= this.batchSize) {
			void this.flush();
		}
	}

	enqueueInBackground(row: BrokerArchiveRow): void {
		queueMicrotask(() => this.enqueue(row));
	}

	async flush(): Promise<void> {
		if (
			!this.enabled ||
			this.closed ||
			(this.queue.length === 0 && this.pendingRetry === null)
		) {
			return;
		}
		if (this.flushInFlight) {
			return this.flushInFlight;
		}
		// flushBatch resolves a boolean the callers read directly; the in-flight
		// handle only needs completion, so discard it to keep this a Promise<void>.
		const inFlightState: { promise?: Promise<void> } = {};
		const inFlight = this.flushBatch()
			.then(() => undefined)
			.finally(() => {
				if (this.flushInFlight !== inFlightState.promise) {
					return;
				}
				this.flushInFlight = null;
				if (
					!this.closed &&
					!this.closing &&
					this.enabled &&
					this.queue.length >= this.batchSize
				) {
					queueMicrotask(() => void this.flush());
				}
			});
		inFlightState.promise = inFlight;
		this.flushInFlight = inFlight;
		return inFlight;
	}

	async close(): Promise<void> {
		this.closing = true;
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		let closeError: unknown;
		try {
			while (
				this.pendingRetry !== null ||
				this.queue.length > 0 ||
				this.flushInFlight
			) {
				if (this.flushInFlight) {
					await this.flushInFlight;
					continue;
				}
				// No retry loop at shutdown: one failed attempt and everything still
				// held — pinned batch first, then the queue — goes to the journal.
				if (!(await this.flushBatch())) {
					const pinned = this.pendingRetry;
					this.appendLossRecords(
						pinned?.rows ?? [],
						"shutdown_forwarder_failure",
						pinned?.batchId ?? null,
					);
					this.appendLossRecords(this.queue, "shutdown_forwarder_failure");
					this.pendingRetry = null;
					this.queue.length = 0;
					break;
				}
			}
		} catch (error) {
			closeError = error;
		}
		this.closed = true;
		if (this.deadLetterFd !== undefined) {
			try {
				this.closeLossJournal();
			} catch (error) {
				closeError ??= error;
			}
		}
		if (closeError) {
			throw closeError;
		}
	}

	getStats(): Readonly<ArchiverStats> {
		return { ...this.stats };
	}

	// Pinned rows are undelivered too, so they count as depth even though they sit
	// outside the queue and outside its bound.
	getQueueDepth(): number {
		return this.queue.length + (this.pendingRetry?.rows.length ?? 0);
	}

	getHealthSnapshot(): Readonly<BrokerExecutionArchiveHealthSnapshot> {
		const now = Date.now();
		const oldestPendingAtMs = this.oldestPendingEnqueueAtMs();
		const oldestPendingAgeMs =
			oldestPendingAtMs === null ? 0 : Math.max(0, now - oldestPendingAtMs);
		const inFlightAgeMs =
			this.inFlightStartedAtMs === null
				? 0
				: Math.max(0, now - this.inFlightStartedAtMs);
		const lastUnhealthyEventSequence = Math.max(
			this.lastFailureEventSequence ?? Number.NEGATIVE_INFINITY,
			this.lastShedEventSequence ?? Number.NEGATIVE_INFINITY,
		);
		const recoveredFromEvents =
			lastUnhealthyEventSequence === Number.NEGATIVE_INFINITY ||
			(this.lastSuccessEventSequence !== null &&
				this.lastSuccessEventSequence > lastUnhealthyEventSequence);
		const healthy =
			this.enabled &&
			!this.closing &&
			!this.closed &&
			this.queue.length < this.maxQueueSize &&
			oldestPendingAgeMs <= this.forwarderTimeoutMs &&
			inFlightAgeMs <= this.forwarderTimeoutMs &&
			recoveredFromEvents;

		return {
			healthy,
			// Reported depth includes pinned rows; the saturation check above stays
			// on the queue proper, which is the only part the bound governs.
			queue_depth: this.getQueueDepth(),
			oldest_pending_age_ms: oldestPendingAgeMs,
			shed_total: this.stats.shed,
			last_failure_at: this.lastFailureAtMs,
			last_shed_at: this.lastShedAtMs,
			last_success_at: this.lastSuccessAtMs,
			sink_latency_ms: this.lastSinkLatencyMs,
			sink_errors_total: this.stats.forwarderFailures,
			in_flight: this.inFlightBatch !== null,
			in_flight_age_ms: inFlightAgeMs,
		};
	}

	private oldestPendingEnqueueAtMs(): number | null {
		let oldest: number | null = null;
		for (const entry of this.pendingRetry?.rows ?? []) {
			const enqueuedAtMs = this.enqueueTimes.get(entry);
			if (enqueuedAtMs === undefined) {
				continue;
			}
			oldest = oldest === null ? enqueuedAtMs : Math.min(oldest, enqueuedAtMs);
		}
		for (const entry of this.queue) {
			const enqueuedAtMs = this.enqueueTimes.get(entry);
			if (enqueuedAtMs === undefined) {
				continue;
			}
			oldest = oldest === null ? enqueuedAtMs : Math.min(oldest, enqueuedAtMs);
		}
		for (const entry of this.inFlightBatch ?? []) {
			const enqueuedAtMs = this.enqueueTimes.get(entry);
			if (enqueuedAtMs === undefined) {
				continue;
			}
			oldest = oldest === null ? enqueuedAtMs : Math.min(oldest, enqueuedAtMs);
		}
		return oldest;
	}

	private recordHealthEvent(event: "failure" | "shed" | "success"): void {
		const eventSequence = ++this.healthEventSequence;
		const eventTimestampMs = Date.now();
		switch (event) {
			case "failure":
				this.lastFailureAtMs = eventTimestampMs;
				this.lastFailureEventSequence = eventSequence;
				return;
			case "shed":
				this.lastShedAtMs = eventTimestampMs;
				this.lastShedEventSequence = eventSequence;
				return;
			case "success":
				this.lastSuccessAtMs = eventTimestampMs;
				this.lastSuccessEventSequence = eventSequence;
				return;
		}
	}

	private emitArchiveHealthMetrics(): void {
		const snapshot = this.getHealthSnapshot();
		const labels = { source: this.source };
		void this.recordArchiveObservableGauge(
			"cex_archive_health",
			snapshot.healthy ? 1 : 0,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_queue_depth",
			snapshot.queue_depth,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_oldest_pending_age_ms",
			snapshot.oldest_pending_age_ms,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_shed_total",
			snapshot.shed_total,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_last_failure_at",
			snapshot.last_failure_at ?? 0,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_last_shed_at",
			snapshot.last_shed_at ?? 0,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_last_success_at",
			snapshot.last_success_at ?? 0,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_sink_latency_ms",
			snapshot.sink_latency_ms ?? 0,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_sink_errors_total",
			snapshot.sink_errors_total,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_in_flight",
			snapshot.in_flight ? 1 : 0,
			labels,
		);
		void this.recordArchiveGauge(
			"cex_archive_in_flight_age_ms",
			snapshot.in_flight_age_ms,
			labels,
		);
	}

	private closeLossJournal(): void {
		if (this.deadLetterFd === undefined) {
			return;
		}
		const fd = this.deadLetterFd;
		try {
			closeSync(fd);
		} catch (error) {
			throw new BrokerExecutionArchiveDurabilityError(
				"Broker execution archive failed to close the configured CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH loss journal",
				{ cause: error },
			);
		} finally {
			this.deadLetterFd = undefined;
		}
	}

	private appendLossRecords(
		rows: readonly BrokerArchiveRow[],
		reason: ArchiveLossReason,
		batchId: string | null = null,
	): void {
		if (rows.length === 0) {
			return;
		}
		if (this.deadLetterFd === undefined) {
			throw new BrokerExecutionArchiveDurabilityError(
				`Broker execution archive cannot record ${reason}: dead-letter file is not open`,
			);
		}
		const timestamp = new Date().toISOString();
		const records: ArchiveLossRecord[] = rows.map((payload, index) => ({
			timestamp,
			source: this.source,
			deployment_id: this.deploymentId,
			reason,
			payload,
			record_version: LOSS_JOURNAL_RECORD_VERSION,
			batch_id: batchId,
			batch_row_index: index,
			batch_row_count: rows.length,
		}));
		try {
			const bytes = Buffer.from(
				records.map((record) => JSON.stringify(record)).join("\n") + "\n",
			);
			const written = writeSync(this.deadLetterFd, bytes);
			if (written !== bytes.length) {
				throw new Error(`wrote ${written} of ${bytes.length} bytes`);
			}
			fsyncSync(this.deadLetterFd);
			const byFeedAndTable = new Map<
				string,
				{ row: BrokerArchiveRow; count: number }
			>();
			for (const row of rows) {
				const key = `${row.table}\u0000${archiveFeed(row)}`;
				const grouped = byFeedAndTable.get(key) ?? { row, count: 0 };
				grouped.count += 1;
				byFeedAndTable.set(key, grouped);
			}
			for (const { row, count } of byFeedAndTable.values()) {
				void this.recordArchiveMetric(
					"cex_archive_rows_journaled_total",
					{
						table: row.table,
						source: this.source,
						feed: archiveFeed(row),
						reason,
					},
					count,
				);
			}
		} catch (error) {
			throw new BrokerExecutionArchiveDurabilityError(
				`Broker execution archive failed to durably record ${reason}; affected row(s) were retained`,
				{ cause: error },
			);
		}
	}

	private async flushBatch(): Promise<boolean> {
		// A pinned batch goes back out before anything newer, unchanged and under
		// its original id, so the forwarder sees a retry rather than a new batch.
		const pinned = this.pendingRetry;
		const batch = pinned ? pinned.rows : this.queue.splice(0, this.batchSize);
		if (batch.length === 0) {
			return true;
		}
		const batchId = pinned?.batchId ?? randomUUID();
		this.inFlightBatch = batch;
		this.inFlightStartedAtMs = Date.now();

		// Secondary observability mirror: execution rows (not market_data.*, which
		// has no OTel schema) are echoed to OTel logs when
		// CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED gated an otelLogs sink in. This is in
		// addition to the forwarder, never instead of it, so a durable record exists
		// even while a forwarder is unreachable. A requeued batch re-emits here on
		// the retry flush; OTel logs are observability, not the audit source.
		for (const entry of batch) {
			if (isBrokerExecutionArchiveTable(entry.table)) {
				this.emitOtelLog(entry);
			}
		}

		// The forwarder is the durable sink for every archive table it supports
		// (market_data.*, broker_execution.*, broker_account.*, strategy_data.*).
		// Pin the whole batch on failure so nothing is silently dropped while a
		// forwarder is set.
		if (this.forwarderUrl) {
			try {
				await this.postToForwarder(batch, batchId);
			} catch (error) {
				this.stats.forwarderFailures += 1;
				this.recordHealthEvent("failure");
				this.lastSinkLatencyMs = Math.max(
					0,
					Date.now() - (this.inFlightStartedAtMs ?? Date.now()),
				);
				const attempts = (pinned?.attempts ?? 0) + 1;
				try {
					if (attempts >= MAX_PINNED_BATCH_ATTEMPTS) {
						this.pendingRetry = null;
						this.appendLossRecords(batch, "retry_exhausted", batchId);
						log.warn("Broker execution archive gave up on a batch", {
							attempts,
							rows: batch.length,
						});
					} else {
						this.pendingRetry = { batchId, rows: batch, attempts };
					}
				} finally {
					this.clearInFlightBatch(batch);
					this.emitArchiveHealthMetrics();
				}
				void this.recordArchiveMetric("cex_archive_forwarder_failures_total", {
					count: batch.length,
				});
				log.warn("Broker execution archive forwarder failed", { error });
				return false;
			}
		}

		this.pendingRetry = null;
		this.stats.flushed += batch.length;
		this.recordHealthEvent("success");
		this.lastSinkLatencyMs = Math.max(
			0,
			Date.now() - (this.inFlightStartedAtMs ?? Date.now()),
		);
		this.clearInFlightBatch(batch);
		this.recordFlushHealth(batch);
		this.emitArchiveHealthMetrics();
		return true;
	}

	private clearInFlightBatch(batch: QueuedArchiveRow[]): void {
		if (this.inFlightBatch !== batch) {
			return;
		}
		this.inFlightBatch = null;
		this.inFlightStartedAtMs = null;
	}

	// Self-health emitted only on a successful forwarder post:
	// a per-table rows-flushed counter to compare against enqueued, and a
	// last-flush-success gauge (unix seconds) whose staleness is the "archive plane
	// stuck" signal. Fire-and-forget so metrics never gate flushing.
	private recordFlushHealth(batch: readonly QueuedArchiveRow[]): void {
		const countByTable = new Map<
			string,
			{ row: BrokerArchiveRow; count: number }
		>();
		for (const entry of batch) {
			const row = entry;
			const key = `${row.table}\u0000${archiveFeed(row)}`;
			const grouped = countByTable.get(key) ?? { row, count: 0 };
			grouped.count += 1;
			countByTable.set(key, grouped);
		}
		for (const { row, count } of countByTable.values()) {
			void this.recordArchiveMetric(
				"cex_archive_rows_flushed_total",
				{
					table: row.table,
					source: this.source,
					feed: archiveFeed(row),
				},
				count,
			);
		}
		void this.recordArchiveGauge(
			"cex_archive_last_flush_success",
			Math.floor(Date.now() / 1000),
		);
	}

	private async recordArchiveMetric(
		metricName: string,
		labels: Record<string, string | number>,
		value = 1,
	): Promise<void> {
		try {
			await this.otelMetrics?.recordCounter(metricName, value, labels);
		} catch {
			// Archive metrics must not affect flushing.
		}
	}

	private async recordArchiveGauge(
		metricName: string,
		value: number,
		labels: Record<string, string | number> = {},
	): Promise<void> {
		try {
			await this.otelMetrics?.recordGauge(metricName, value, labels);
		} catch {
			// Archive metrics must not affect flushing.
		}
	}

	private async recordArchiveObservableGauge(
		metricName: string,
		value: number,
		labels: Record<string, string | number>,
	): Promise<void> {
		try {
			await this.otelMetrics?.setObservableGauge(metricName, value, labels);
		} catch {
			// Archive metrics must not affect flushing.
		}
	}

	private emitOtelLog(entry: BrokerArchiveRow): void {
		if (!this.otelLogs?.isOtelEnabled()) {
			return;
		}
		try {
			this.otelLogs.emit({
				body: entry.table,
				severityNumber: SeverityNumber.INFO,
				severityText: "INFO",
				attributes: flattenArchiveAttributes(redactArchiveErrorForOtel(entry)),
			});
		} catch (error) {
			log.warn("Broker execution archive OTLP emit failed", { error });
		}
	}

	// Uses node:http/node:https rather than the global fetch: inside the Gramine
	// SGX enclave undici (which backs fetch) fails on every request when it lazily
	// instantiates its llhttp WASM parser — `WebAssembly.Instance(): Out of memory`
	// under the enclave's constrained memory — which silently kills the whole
	// archive plane. node's request stays on the transport proven to work in the
	// enclave. Same failure class and mitigation as resolveOnChainSender in
	// travel-rule-deposit-reconciler.ts.
	private postToForwarder(
		batch: BrokerArchiveRow[],
		batchId: string,
	): Promise<void> {
		if (!this.forwarderUrl || batch.length === 0) {
			return Promise.resolve();
		}
		const body = JSON.stringify({
			source: this.source,
			deployment_id: this.deploymentId,
			batch_id: batchId,
			rows: batch,
		});
		const url = new URL(this.forwarderUrl);
		const doRequest = url.protocol === "http:" ? httpRequest : httpsRequest;
		const headers: Record<string, string | number> = {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(body),
		};
		if (this.forwarderAuthToken) {
			headers.authorization = `Bearer ${this.forwarderAuthToken}`;
		}
		return new Promise<void>((resolve, reject) => {
			let req: ClientRequest | undefined;
			let response: IncomingMessage | undefined;
			let settled = false;
			let requestClosed = false;
			let requestCloseFailureScheduled = false;
			let responseClosed = false;
			let responseEnded = false;
			let outerTimer: ReturnType<typeof setTimeout> | undefined;

			function cleanupRequestListeners(): void {
				req?.removeListener("error", onRequestError);
				req?.removeListener("timeout", onRequestTimeout);
				req?.removeListener("close", onRequestClose);
			}

			function cleanupResponseListeners(): void {
				response?.removeListener("data", onResponseData);
				response?.removeListener("end", onResponseEnd);
				response?.removeListener("aborted", onResponseAborted);
				response?.removeListener("error", onResponseError);
				response?.removeListener("close", onResponseClose);
			}

			function onRequestClose(): void {
				requestClosed = true;
				// Bun can emit ClientRequest.close after the request body finishes and
				// before response end, but a close with no response at all is a terminal
				// pre-header transport failure. Defer one microtask so a response callback
				// already queued for the same turn wins without masking a real close.
				if (!settled && !response && !requestCloseFailureScheduled) {
					requestCloseFailureScheduled = true;
					queueMicrotask(() => {
						if (!settled && !response) {
							settle(
								new Error(
									"Archive forwarder request closed before response headers",
								),
								false,
								true,
							);
						}
					});
				}
				if (settled) {
					cleanupRequestListeners();
				}
			}

			function onRequestError(error: Error): void {
				if (!settled) {
					settle(error, true);
				} else {
					cleanupRequestListeners();
				}
			}

			function onRequestTimeout(): void {
				settle(new Error("Archive forwarder socket timed out"), true);
			}

			function onResponseData(): void {}

			function onResponseEnd(): void {
				responseEnded = true;
				if (!response?.complete) {
					settle(new Error("Archive forwarder response was incomplete"), true);
					return;
				}
				const status = response.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					settle(
						new Error(
							`Archive forwarder returned ${status} ${response.statusMessage ?? ""}`,
						),
						false,
					);
					return;
				}
				settle(undefined, false);
			}

			function onResponseAborted(): void {
				settle(new Error("Archive forwarder response was aborted"), true);
			}

			function onResponseError(error: Error): void {
				if (!settled) {
					settle(error, true);
				}
			}

			function onResponseClose(): void {
				responseClosed = true;
				if (!settled && !responseEnded) {
					settle(
						new Error("Archive forwarder response closed before completion"),
						true,
					);
					return;
				}
				cleanupResponseListeners();
			}

			function settle(
				error: Error | undefined,
				destroyRequest: boolean,
				retainClosedRequestError = false,
			): void {
				if (settled) {
					return;
				}
				settled = true;
				if (outerTimer) {
					clearTimeout(outerTimer);
					outerTimer = undefined;
				}
				response?.removeListener("data", onResponseData);
				response?.removeListener("end", onResponseEnd);
				response?.removeListener("aborted", onResponseAborted);
				if (responseClosed) {
					cleanupResponseListeners();
				}
				// Keep the request error listener until close when destruction is
				// requested. ClientRequest can emit its destroy error asynchronously.
				if (destroyRequest && req && !requestClosed) {
					req.destroy(error);
				} else if (retainClosedRequestError && req && requestClosed) {
					// The close event already happened; retain only the guarded error
					// listener so a late transport error cannot become unhandled.
					req.removeListener("timeout", onRequestTimeout);
					req.removeListener("close", onRequestClose);
				} else if (!req || requestClosed) {
					cleanupRequestListeners();
				}
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			}

			// ClientRequest.timeout only observes socket inactivity. This outer timer
			// covers lookup, connection, request write, response headers/body, and end.
			outerTimer = setTimeout(() => {
				settle(new Error("Archive forwarder request deadline exceeded"), true);
			}, this.forwarderTimeoutMs);

			try {
				req = doRequest(
					url,
					{
						method: "POST",
						headers,
						timeout: this.forwarderTimeoutMs,
					},
					(nextResponse) => {
						response = nextResponse;
						response.on("data", onResponseData);
						response.on("end", onResponseEnd);
						response.on("aborted", onResponseAborted);
						response.on("error", onResponseError);
						response.on("close", onResponseClose);
						if (settled) {
							response.resume();
						}
					},
				);
				req.on("error", onRequestError);
				req.on("timeout", onRequestTimeout);
				req.on("close", onRequestClose);
				req.write(body);
				req.end();
			} catch (error) {
				settle(error instanceof Error ? error : new Error(String(error)), true);
			}
		});
	}
}

function redactArchiveErrorForOtel(entry: BrokerArchiveRow): BrokerArchiveRow {
	if (
		entry.table !== "broker_execution.order_events" ||
		typeof entry.row.error_message !== "string" ||
		entry.row.error_message.length === 0
	) {
		return entry;
	}
	return {
		...entry,
		row: { ...entry.row, error_message: REDACTED_ERROR_MESSAGE },
	};
}

function flattenArchiveAttributes(
	entry: BrokerArchiveRow,
): Record<string, string | number | boolean> {
	const attributes: Record<string, string | number | boolean> = {
		ch_table: entry.table,
	};
	for (const [key, value] of Object.entries(entry.row)) {
		if (value === undefined || value === null) {
			continue;
		}
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			attributes[key] = value;
		} else {
			attributes[key] = JSON.stringify(value);
		}
	}
	return attributes;
}

export function createBrokerExecutionArchiverFromEnv(
	otelLogs?: OtelLogs,
	otelMetrics?: OtelMetrics,
): BrokerExecutionArchiver {
	if (process.env.CEX_BROKER_ARCHIVE_ENABLED !== "true") {
		return BrokerExecutionArchiver.disabled();
	}
	const forwarderUrl = resolveArchiveForwarderUrlFromEnv();
	const archiveOtelLogs = isArchiveOtelLogsEnabled() ? otelLogs : undefined;
	return BrokerExecutionArchiver.create({
		source: resolveArchiveSourceFromEnv(),
		otelLogs: archiveOtelLogs,
		otelMetrics,
		forwarderUrl: forwarderUrl ?? "",
		deadLetterPath:
			process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH?.trim() ?? "",
		deploymentId: process.env.CEX_BROKER_DEPLOYMENT_ID,
		maxQueueSize: parsePositiveInt(
			process.env.CEX_BROKER_ARCHIVE_QUEUE_MAX,
			DEFAULT_MAX_QUEUE_SIZE,
		),
		batchSize: parsePositiveInt(
			process.env.CEX_BROKER_ARCHIVE_BATCH_SIZE,
			DEFAULT_BATCH_SIZE,
		),
		flushIntervalMs: parsePositiveInt(
			process.env.CEX_BROKER_ARCHIVE_FLUSH_INTERVAL_MS,
			DEFAULT_FLUSH_INTERVAL_MS,
		),
	});
}

function validateForwarderUrl(value: string | undefined): URL {
	if (!value) {
		throw new Error(
			"Broker execution archive is enabled but CEX_BROKER_ARCHIVE_FORWARDER_URL is missing",
		);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new Error(
			"Broker execution archive requires a valid CEX_BROKER_ARCHIVE_FORWARDER_URL",
			{ cause: error },
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(
			"Broker execution archive forwarder URL must use http or https",
		);
	}
	return url;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
