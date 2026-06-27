import { SeverityNumber } from "@opentelemetry/api-logs";
import { log } from "../logger";
import type { OtelLogs, OtelMetrics } from "../otel";
import { isMarketArchiveTable } from "../market-data-archive/types";
import type { BrokerArchiveRow } from "./types";

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
		this.flushInFlight = this.flushBatch().finally(() => {
			this.flushInFlight = null;
		});
		return this.flushInFlight;
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
			await this.flushBatch();
		}
		this.closed = true;
	}

	getStats(): Readonly<ArchiverStats> {
		return { ...this.stats };
	}

	getQueueDepth(): number {
		return this.queue.length;
	}

	private async flushBatch(): Promise<void> {
		const batch = this.queue.splice(0, this.batchSize);
		if (batch.length === 0) {
			return;
		}

		for (const entry of batch) {
			if (!isMarketArchiveTable(entry.table)) {
				this.emitOtelLog(entry);
			}
		}

		if (this.forwarderUrl) {
			const marketRows = batch.filter((entry) =>
				isMarketArchiveTable(entry.table),
			);
			if (marketRows.length > 0) {
				try {
					await this.postToForwarder(marketRows);
				} catch (error) {
					this.stats.forwarderFailures += 1;
					this.queue.push(...batch);
					void this.recordArchiveMetric("cex_archive_forwarder_failures_total", {
						count: batch.length,
					});
					log.warn("Broker execution archive forwarder failed", { error });
					return;
				}
			}
		}

		this.stats.flushed += batch.length;
	}

	private async recordArchiveMetric(
		metricName: string,
		labels: Record<string, string | number>,
	): Promise<void> {
		try {
			await this.otelMetrics?.recordCounter(metricName, 1, labels);
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

	private async postToForwarder(batch: BrokerArchiveRow[]): Promise<void> {
		if (!this.forwarderUrl || batch.length === 0) {
			return;
		}
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.forwarderTimeoutMs,
		);
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (this.forwarderAuthToken) {
			headers.authorization = `Bearer ${this.forwarderAuthToken}`;
		}
		try {
			const response = await fetch(this.forwarderUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({
					source: "broker_write",
					deployment_id: this.deploymentId,
					rows: batch,
				}),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(
					`Archive forwarder returned ${response.status} ${response.statusText}`,
				);
			}
		} finally {
			clearTimeout(timeout);
		}
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
