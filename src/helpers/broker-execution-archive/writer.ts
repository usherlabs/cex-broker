import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { log } from "../logger";
import { isMarketArchiveTable } from "../market-data-archive/types";
import type { OtelLogs, OtelMetrics } from "../otel";
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
	forwarderUrl?: string;
	maxQueueSize?: number;
	batchSize?: number;
	flushIntervalMs?: number;
	forwarderTimeoutMs?: number;
};

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
const DEFAULT_ARCHIVE_FORWARDER_PATH = "/archive";
const DEFAULT_ARCHIVE_FORWARDER_PORT = 8090;

export function isArchiveOtelLogsEnabled(): boolean {
	return process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED === "true";
}

export function resolveArchiveForwarderUrlFromEnv(): string | undefined {
	const explicit = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL?.trim();
	if (explicit) {
		return explicit;
	}

	const host =
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST?.trim() ||
		process.env.CEX_BROKER_CLICKHOUSE_HOST?.trim();
	if (!host) {
		return undefined;
	}

	const protocol =
		(process.env.CEX_BROKER_CLICKHOUSE_PROTOCOL as
			| "http"
			| "https"
			| undefined) || "http";
	const port = parsePositiveInt(
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_PORT,
		DEFAULT_ARCHIVE_FORWARDER_PORT,
	);
	const path =
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_PATH?.trim() ||
		DEFAULT_ARCHIVE_FORWARDER_PATH;
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return `${protocol}://${host}:${port}${normalizedPath}`;
}

export class BrokerExecutionArchiver {
	private readonly deploymentId: string;
	private readonly otelLogs?: OtelLogs;
	private readonly otelMetrics?: OtelMetrics;
	private readonly forwarderUrl?: string;
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
	private closed = false;
	private loggedMissingMarketForwarder = false;
	private readonly enabled: boolean;
	private readonly forwarderAuthToken?: string;

	private constructor(
		options: BrokerExecutionArchiverOptions & { enabled: boolean },
	) {
		this.deploymentId =
			options.deploymentId?.trim() ||
			process.env.CEX_BROKER_DEPLOYMENT_ID?.trim() ||
			"unknown";
		this.otelLogs = options.otelLogs;
		this.otelMetrics = options.otelMetrics;
		this.forwarderUrl = options.forwarderUrl?.trim();
		this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.forwarderTimeoutMs =
			options.forwarderTimeoutMs ?? DEFAULT_FORWARDER_TIMEOUT_MS;
		this.enabled = options.enabled;
		this.forwarderAuthToken =
			process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN?.trim() || undefined;

		if (this.enabled) {
			this.flushTimer = setInterval(() => {
				void this.flush().catch((error) => {
					log.warn("Broker execution archive flush failed", { error });
				});
			}, this.flushIntervalMs);
			this.flushTimer.unref?.();
		}
	}

	static disabled(): BrokerExecutionArchiver {
		return new BrokerExecutionArchiver({ enabled: false });
	}

	static create(
		options: BrokerExecutionArchiverOptions,
	): BrokerExecutionArchiver {
		const hasSink =
			Boolean(options.otelLogs?.isOtelEnabled()) ||
			Boolean(options.forwarderUrl);
		const enabled =
			process.env.CEX_BROKER_ARCHIVE_ENABLED !== "false" && hasSink;
		return new BrokerExecutionArchiver({ ...options, enabled });
	}

	getDeploymentId(): string {
		return this.deploymentId;
	}

	isEnabled(): boolean {
		return (
			this.enabled &&
			!this.closed &&
			(Boolean(this.otelLogs) || Boolean(this.forwarderUrl))
		);
	}

	canPersistMarketMetadataSnapshot(): boolean {
		return (
			this.isEnabled() &&
			(Boolean(this.otelLogs?.isOtelEnabled()) || Boolean(this.forwarderUrl))
		);
	}

	canPersistAccountBalanceSnapshots(): boolean {
		return this.isEnabled() && Boolean(this.forwarderUrl);
	}

	enqueue(row: BrokerArchiveRow): void {
		if (
			!this.enabled ||
			this.closed ||
			(!this.otelLogs && !this.forwarderUrl)
		) {
			return;
		}
		if (isMarketArchiveTable(row.table) && !this.forwarderUrl) {
			if (!this.loggedMissingMarketForwarder) {
				this.loggedMissingMarketForwarder = true;
				log.warn(
					"Market data archive row dropped: configure CEX_BROKER_ARCHIVE_FORWARDER_URL or CEX_BROKER_CLICKHOUSE_HOST",
					{ table: row.table },
				);
			}
			return;
		}
		if (
			row.table === "broker_account.balance_snapshots" &&
			!this.forwarderUrl
		) {
			return;
		}
		if (this.queue.length >= this.maxQueueSize) {
			this.queue.shift();
			this.stats.shed += 1;
			void this.recordArchiveMetric("cex_archive_rows_shed_total", {
				table: row.table,
			});
		}
		this.queue.push(row);
		this.stats.enqueued += 1;
		void this.recordArchiveMetric("cex_archive_rows_enqueued_total", {
			table: row.table,
		});
		if (this.queue.length >= this.batchSize) {
			void this.flush().catch((error) => {
				log.warn("Broker execution archive flush failed", { error });
			});
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
		while (this.queue.length > 0 || this.flushInFlight) {
			if (this.flushInFlight) {
				await this.flushInFlight;
				continue;
			}
			const depthBefore = this.queue.length;
			const flushed = await this.flushBatch();
			if (!flushed && this.queue.length >= depthBefore && depthBefore > 0) {
				const dropped = this.queue.length;
				this.queue.length = 0;
				log.warn(
					`Archive shutdown dropped ${dropped} undelivered row(s) after forwarder failure`,
				);
				break;
			}
		}
		this.closed = true;
	}

	getStats(): Readonly<ArchiverStats> {
		return { ...this.stats };
	}

	getQueueDepth(): number {
		return this.queue.length;
	}

	// Drop oldest rows until the queue is within maxQueueSize, counting each into
	// the shed stat/metric. Mirrors the enqueue-time shed policy for the requeue
	// path, which can otherwise push the queue past the bound during an outage.
	private enforceQueueBound(): void {
		while (this.queue.length > this.maxQueueSize) {
			const dropped = this.queue.shift();
			this.stats.shed += 1;
			void this.recordArchiveMetric("cex_archive_rows_shed_total", {
				table: dropped?.table ?? "unknown",
			});
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

	// Self-health emitted only on a successful forwarder post (or OTel-only flush):
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
				attributes: flattenArchiveAttributes(entry),
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
	const forwarderUrl = resolveArchiveForwarderUrlFromEnv();
	const archiveOtelLogs = isArchiveOtelLogsEnabled() ? otelLogs : undefined;
	return BrokerExecutionArchiver.create({
		otelLogs: archiveOtelLogs,
		otelMetrics,
		forwarderUrl,
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
