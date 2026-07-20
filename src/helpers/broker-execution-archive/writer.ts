import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { log } from "../logger";
import type { OtelLogs, OtelMetrics } from "../otel";
import { REDACTED_ERROR_MESSAGE } from "../shared/errors";
import type { BrokerArchiveRow, BrokerArchiveTable } from "./types";

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

const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_FORWARDER_TIMEOUT_MS = 3_000;
const SHED_WARN_INTERVAL_MS = 60_000;

type ArchiveLossReason = "queue_shed" | "shutdown_forwarder_failure";

type ArchiveLossRecord = {
	timestamp: string;
	deployment_id: string;
	reason: ArchiveLossReason;
	payload: BrokerArchiveRow;
};

export function isArchiveOtelLogsEnabled(): boolean {
	return process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED === "true";
}

export function resolveArchiveForwarderUrlFromEnv(): string | undefined {
	return process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL?.trim() || undefined;
}

export class BrokerExecutionArchiver {
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
	private readonly queue: BrokerArchiveRow[] = [];
	private readonly stats: ArchiverStats = {
		enqueued: 0,
		shed: 0,
		flushed: 0,
		forwarderFailures: 0,
	};
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private flushInFlight: Promise<void> | null = null;
	private lastShedWarnAtMs = 0;
	private closed = false;
	private readonly enabled: boolean;
	private readonly forwarderAuthToken?: string;

	private constructor(options: {
		enabled: boolean;
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
				void this.flush();
			}, this.flushIntervalMs);
			this.flushTimer.unref?.();
			log.info("Broker execution archive enabled", {
				enabled: true,
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

	isEnabled(): boolean {
		return this.enabled && !this.closed;
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
		if (this.queue.length >= this.maxQueueSize) {
			const shedRow = this.queue[0];
			if (shedRow) {
				this.appendLossRecords([shedRow], "queue_shed");
				this.queue.shift();
			}
			this.stats.shed += 1;
			void this.recordArchiveMetric("cex_archive_rows_shed_total", {
				table: shedRow?.table ?? "unknown",
			});
			// The durable journal is authoritative; this rate-limited warning makes
			// sustained queue pressure visible without becoming another loss sink.
			const now = Date.now();
			if (now - this.lastShedWarnAtMs >= SHED_WARN_INTERVAL_MS) {
				log.warn("Archive queue full: shedding oldest rows", {
					shed_total: this.stats.shed,
					queue_max: this.maxQueueSize,
					table: shedRow?.table ?? "unknown",
				});
				this.lastShedWarnAtMs = now;
			}
		}
		this.queue.push(row);
		this.stats.enqueued += 1;
		void this.recordArchiveMetric("cex_archive_rows_enqueued_total", {
			table: row.table,
		});
		if (this.queue.length >= this.batchSize) {
			void this.flush();
		}
	}

	enqueueInBackground(row: BrokerArchiveRow): void {
		queueMicrotask(() => this.enqueue(row));
	}

	async flush(): Promise<void> {
		if (!this.enabled || this.closed || this.queue.length === 0) {
			return;
		}
		if (this.flushInFlight) {
			return this.flushInFlight;
		}
		// flushBatch resolves a boolean the callers read directly; the in-flight
		// handle only needs completion, so discard it to keep this a Promise<void>.
		const inFlight = this.flushBatch()
			.then(() => undefined)
			.finally(() => {
				this.flushInFlight = null;
			});
		this.flushInFlight = inFlight;
		return inFlight;
	}

	async close(): Promise<void> {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		let closeError: unknown;
		try {
			while (this.queue.length > 0 || this.flushInFlight) {
				if (this.flushInFlight) {
					await this.flushInFlight;
					continue;
				}
				const depthBefore = this.queue.length;
				const flushed = await this.flushBatch();
				if (!flushed && this.queue.length >= depthBefore && depthBefore > 0) {
					const undelivered = [...this.queue];
					this.appendLossRecords(undelivered, "shutdown_forwarder_failure");
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

	getQueueDepth(): number {
		return this.queue.length;
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

	// Drop oldest rows until the queue is within maxQueueSize, counting each into
	// the shed stat/metric. Mirrors the enqueue-time shed policy for the requeue
	// path, which can otherwise push the queue past the bound during an outage.
	private enforceQueueBound(): void {
		while (this.queue.length > this.maxQueueSize) {
			const dropped = this.queue[0];
			if (!dropped) {
				return;
			}
			this.appendLossRecords([dropped], "queue_shed");
			this.queue.shift();
			this.stats.shed += 1;
			void this.recordArchiveMetric("cex_archive_rows_shed_total", {
				table: dropped?.table ?? "unknown",
			});
		}
	}

	private appendLossRecords(
		rows: readonly BrokerArchiveRow[],
		reason: ArchiveLossReason,
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
		const records: ArchiveLossRecord[] = rows.map((payload) => ({
			timestamp,
			deployment_id: this.deploymentId,
			reason,
			payload,
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
		} catch (error) {
			throw new BrokerExecutionArchiveDurabilityError(
				`Broker execution archive failed to durably record ${reason}; affected row(s) were retained`,
				{ cause: error },
			);
		}
	}

	private async flushBatch(): Promise<boolean> {
		const batch = this.queue.splice(0, this.batchSize);
		if (batch.length === 0) {
			return true;
		}

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
		// Requeue the whole batch on failure so nothing is silently dropped while a
		// forwarder is set.
		if (this.forwarderUrl) {
			try {
				await this.postToForwarder(batch);
			} catch (error) {
				this.stats.forwarderFailures += 1;
				// Re-apply the oldest-shed bound: the batch was spliced out before the
				// post, so new rows may have refilled the queue while it was in flight.
				// Pushing it back can exceed maxQueueSize by up to batchSize, so trim.
				this.queue.push(...batch);
				this.enforceQueueBound();
				void this.recordArchiveMetric("cex_archive_forwarder_failures_total", {
					count: batch.length,
				});
				log.warn("Broker execution archive forwarder failed", { error });
				return false;
			}
		}

		this.stats.flushed += batch.length;
		this.recordFlushHealth(batch);
		return true;
	}

	// Self-health emitted only on a successful forwarder post:
	// a per-table rows-flushed counter to compare against enqueued, and a
	// last-flush-success gauge (unix seconds) whose staleness is the "archive plane
	// stuck" signal. Fire-and-forget so metrics never gate flushing.
	private recordFlushHealth(batch: BrokerArchiveRow[]): void {
		const countByTable = new Map<string, number>();
		for (const entry of batch) {
			countByTable.set(entry.table, (countByTable.get(entry.table) ?? 0) + 1);
		}
		for (const [table, count] of countByTable) {
			void this.recordArchiveMetric(
				"cex_archive_rows_flushed_total",
				{ table },
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
	): Promise<void> {
		try {
			await this.otelMetrics?.recordGauge(metricName, value, {});
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
	private postToForwarder(batch: BrokerArchiveRow[]): Promise<void> {
		if (!this.forwarderUrl || batch.length === 0) {
			return Promise.resolve();
		}
		const body = JSON.stringify({
			source: "broker_write",
			deployment_id: this.deploymentId,
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
			const req = doRequest(
				url,
				{
					method: "POST",
					headers,
					// Bound the request: a hung forwarder would otherwise stall the flush
					// loop (flushes are serialized behind flushInFlight) indefinitely.
					timeout: this.forwarderTimeoutMs,
				},
				(res) => {
					// Drain the body so the socket can be released/reused.
					res.on("data", () => {});
					res.on("end", () => {
						const status = res.statusCode ?? 0;
						if (status < 200 || status >= 300) {
							reject(
								new Error(
									`Archive forwarder returned ${status} ${res.statusMessage ?? ""}`,
								),
							);
							return;
						}
						resolve();
					});
				},
			);
			req.on("error", reject);
			req.on("timeout", () => {
				req.destroy(new Error("Archive forwarder request timed out"));
			});
			req.write(body);
			req.end();
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
