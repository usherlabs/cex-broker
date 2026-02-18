import { logs, type LogRecord } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BatchLogRecordProcessor,
	LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
	MeterProvider,
	type MeterProvider as MeterProviderType,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { log } from "./logger";

/** OTLP/OpenTelemetry metrics config. Metrics are sent to an OTel Collector. */
export interface OtelConfig {
	/** OTLP HTTP endpoint (e.g. http://localhost:4318). Takes precedence over host/port. */
	otlpEndpoint?: string;
	/** Collector host (legacy). Used with port to build otlpEndpoint when otlpEndpoint is not set. */
	host?: string;
	/** Collector port (legacy). Default 4318 for OTLP HTTP. */
	port?: number;
	protocol?: "http" | "https";
	/** Service name for metrics. */
	serviceName?: string;
	/** @deprecated Unused when using OTLP; kept for config compatibility. */
	username?: string;
	/** @deprecated Unused when using OTLP; kept for config compatibility. */
	password?: string;
	/** @deprecated Unused when using OTLP; kept for config compatibility. */
	database?: string;
}

export interface MetricData {
	timestamp: Date;
	metric_name: string;
	metric_type: "counter" | "gauge" | "histogram";
	value: number;
	labels: string;
	service: string;
}

const DEFAULT_SERVICE = "cex-broker";
const DEFAULT_OTLP_PORT = 4318;
const EXPORT_INTERVAL_MS = 5_000;

abstract class BaseOtelSignal<TProvider> {
	private provider: TProvider | null = null;
	private isEnabled = false;
	private readonly serviceName: string;

	protected constructor(
		config: OtelConfig | undefined,
		private readonly signal: "metrics" | "logs",
	) {
		this.serviceName = config?.serviceName ?? DEFAULT_SERVICE;
		const endpoint = resolveOtlpBaseEndpoint(this.signal, config);
		if (!endpoint) {
			log.info(`OTel ${signal} disabled: no OTLP endpoint or host provided`);
			return;
		}

		try {
			this.provider = this.createProvider(endpoint, this.serviceName);
			this.onProviderCreated(this.provider);
			this.isEnabled = true;
			log.info(`OTel ${signal} enabled: ${endpoint}`);
		} catch (error) {
			log.error(`Failed to initialize OTel ${signal}:`, error);
			this.isEnabled = false;
			this.provider = null;
		}
	}

	protected abstract createProvider(
		endpoint: string,
		serviceName: string,
	): TProvider;

	protected onProviderCreated(_provider: TProvider): void {}

	protected abstract shutdownProvider(provider: TProvider): Promise<void>;

	protected onProviderClosed(): void {}

	protected getProvider(): TProvider | null {
		return this.provider;
	}

	protected getServiceName(): string {
		return this.serviceName;
	}

	public isOtelEnabled(): boolean {
		return this.isEnabled && this.provider !== null;
	}

	public async close(): Promise<void> {
		if (!this.provider) {
			return;
		}
		try {
			await this.shutdownProvider(this.provider);
			log.info(`OTel ${this.signal} provider shut down`);
		} catch (error) {
			log.error(`Error shutting down OTel ${this.signal} provider:`, error);
		}
		this.provider = null;
		this.isEnabled = false;
		this.onProviderClosed();
	}
}

function toAttributes(
	labels: Record<string, string | number>,
	service: string,
): Record<string, string | number> {
	const attrs: Record<string, string | number> = { ...labels, service };
	for (const key of Object.keys(attrs)) {
		const v = attrs[key];
		if (typeof v !== "string" && typeof v !== "number") {
			attrs[key] = String(v);
		}
	}
	return attrs;
}

export class OtelMetrics extends BaseOtelSignal<MeterProviderType> {
	private readonly counters = new Map<
		string,
		ReturnType<ReturnType<MeterProviderType["getMeter"]>["createCounter"]>
	>();
	private readonly histograms = new Map<
		string,
		ReturnType<ReturnType<MeterProviderType["getMeter"]>["createHistogram"]>
	>();

	constructor(config?: OtelConfig) {
		super(config, "metrics");
	}

	protected createProvider(
		endpoint: string,
		serviceName: string,
	): MeterProviderType {
		const exporter = new OTLPMetricExporter({
			url: appendOtlpPath(endpoint, "metrics"),
		});
		const reader = new PeriodicExportingMetricReader({
			exporter,
			exportIntervalMillis: EXPORT_INTERVAL_MS,
		});
		const resource = resourceFromAttributes({
			"service.name": serviceName,
		});
		return new MeterProvider({
			resource,
			readers: [reader],
		});
	}

	protected override onProviderCreated(provider: MeterProviderType): void {
		metrics.setGlobalMeterProvider(provider);
	}

	protected shutdownProvider(provider: MeterProviderType): Promise<void> {
		return provider.shutdown();
	}

	public async initialize(): Promise<void> {
		if (this.isOtelEnabled()) {
			log.info(
				"OTel metrics initialized (storage is handled by the collector)",
			);
		}
	}

	public async insertMetric(metric: MetricData): Promise<void> {
		if (!this.isOtelEnabled()) return;
		const labels = metric.labels
			? (JSON.parse(metric.labels) as Record<string, string | number>)
			: {};
		try {
			if (metric.metric_type === "counter") {
				await this.recordCounter(
					metric.metric_name,
					metric.value,
					labels,
					metric.service,
				);
			} else if (metric.metric_type === "gauge") {
				await this.recordGauge(
					metric.metric_name,
					metric.value,
					labels,
					metric.service,
				);
			} else {
				await this.recordHistogram(
					metric.metric_name,
					metric.value,
					labels,
					metric.service,
				);
			}
		} catch {
			// Don't throw - metrics should not break the main flow
		}
	}

	public async insertMetrics(metricsList: MetricData[]): Promise<void> {
		if (!this.isOtelEnabled() || metricsList.length === 0) return;
		for (const m of metricsList) {
			await this.insertMetric(m);
		}
	}

	public async recordCounter(
		metricName: string,
		value: number,
		labels: Record<string, string | number>,
		service: string = this.getServiceName(),
	): Promise<void> {
		const provider = this.getProvider();
		if (!this.isOtelEnabled() || !provider) return;
		try {
			let counter = this.counters.get(metricName);
			if (!counter) {
				const meter = provider.getMeter("cex-broker-metrics", "1.0.0");
				counter = meter.createCounter(metricName, { description: metricName });
				this.counters.set(metricName, counter);
			}
			counter.add(value, toAttributes(labels, service));
		} catch (error) {
			log.error("Failed to record counter:", error);
		}
	}

	public async recordGauge(
		metricName: string,
		value: number,
		labels: Record<string, string | number>,
		service: string = this.getServiceName(),
	): Promise<void> {
		const provider = this.getProvider();
		if (!this.isOtelEnabled() || !provider) return;
		try {
			let hist = this.histograms.get(`gauge_${metricName}`);
			if (!hist) {
				const meter = provider.getMeter("cex-broker-metrics", "1.0.0");
				hist = meter.createHistogram(`${metricName}_gauge`, {
					description: metricName,
				});
				this.histograms.set(`gauge_${metricName}`, hist);
			}
			hist.record(value, toAttributes(labels, service));
		} catch (error) {
			log.error("Failed to record gauge:", error);
		}
	}

	public async recordHistogram(
		metricName: string,
		value: number,
		labels: Record<string, string | number>,
		service: string = this.getServiceName(),
	): Promise<void> {
		const provider = this.getProvider();
		if (!this.isOtelEnabled() || !provider) return;
		try {
			let hist = this.histograms.get(metricName);
			if (!hist) {
				const meter = provider.getMeter("cex-broker-metrics", "1.0.0");
				hist = meter.createHistogram(metricName, { description: metricName });
				this.histograms.set(metricName, hist);
			}
			hist.record(value, toAttributes(labels, service));
		} catch (error) {
			log.error("Failed to record histogram:", error);
		}
	}
}

export class OtelLogs extends BaseOtelSignal<LoggerProvider> {
	private logger: ReturnType<LoggerProvider["getLogger"]> | null = null;

	constructor(config?: OtelConfig) {
		super(config, "logs");
	}

	protected createProvider(
		endpoint: string,
		serviceName: string,
	): LoggerProvider {
		const exporter = new OTLPLogExporter({
			url: appendOtlpPath(endpoint, "logs"),
		});
		const processor = new BatchLogRecordProcessor(exporter);
		const resource = resourceFromAttributes({
			"service.name": serviceName,
		});
		return new LoggerProvider({
			resource,
			processors: [processor],
		});
	}

	protected override onProviderCreated(provider: LoggerProvider): void {
		logs.setGlobalLoggerProvider(provider);
		this.logger = provider.getLogger("cex-broker-logs", "1.0.0");
	}

	protected shutdownProvider(provider: LoggerProvider): Promise<void> {
		return provider.forceFlush().then(() => provider.shutdown());
	}

	protected override onProviderClosed(): void {
		this.logger = null;
	}

	public emit(record: LogRecord): void {
		if (!this.isOtelEnabled() || !this.logger) {
			return;
		}
		this.logger.emit(record);
	}
}

function resolveOtlpBaseEndpoint(
	signal: "metrics" | "logs",
	config?: OtelConfig,
): string | null {
	// Explicit config should always win over environment variables.
	if (config?.otlpEndpoint) {
		return normalizeOtlpEndpoint(config.otlpEndpoint);
	}

	const signalEndpoint =
		signal === "metrics"
			? process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
			: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
	if (signalEndpoint) {
		return normalizeOtlpEndpoint(signalEndpoint);
	}

	if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
		return normalizeOtlpEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
	}

	if (config?.host) {
		const protocol = config.protocol || "http";
		const port = config.port ?? DEFAULT_OTLP_PORT;
		return `${protocol}://${config.host}:${port}`;
	}
	return null;
}

function appendOtlpPath(endpoint: string, signal: "metrics" | "logs"): string {
	const baseEndpoint = normalizeOtlpEndpoint(endpoint);
	return `${baseEndpoint}/v1/${signal}`;
}

function normalizeOtlpEndpoint(endpoint: string): string {
	return endpoint
		.replace(/\/v1\/(metrics|logs)\/?$/, "")
		.replace(/\/+$/, "");
}

/** Host for OTLP collector: CEX_BROKER_OTEL_HOST or legacy CEX_BROKER_CLICKHOUSE_HOST. */
function getOtelHostFromEnv(): string | undefined {
	return (
		process.env.CEX_BROKER_OTEL_HOST ?? process.env.CEX_BROKER_CLICKHOUSE_HOST
	);
}

/** Port: CEX_BROKER_OTEL_PORT or legacy CEX_BROKER_CLICKHOUSE_PORT. */
function getOtelPortFromEnv(): number | undefined {
	const port =
		process.env.CEX_BROKER_OTEL_PORT ?? process.env.CEX_BROKER_CLICKHOUSE_PORT;
	return port ? Number.parseInt(port, 10) : undefined;
}

/** Protocol: CEX_BROKER_OTEL_PROTOCOL or legacy CEX_BROKER_CLICKHOUSE_PROTOCOL. */
function getOtelProtocolFromEnv(): "http" | "https" {
	const protocol =
		process.env.CEX_BROKER_OTEL_PROTOCOL ??
		process.env.CEX_BROKER_CLICKHOUSE_PROTOCOL;
	return (protocol as "http" | "https") || "http";
}

export function createOtelMetricsFromEnv(): OtelMetrics {
	const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	const host = getOtelHostFromEnv();

	if (otlpEndpoint) {
		return new OtelMetrics({
			otlpEndpoint: otlpEndpoint.replace(/\/v1\/metrics\/?$/, ""),
			serviceName: process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE,
		});
	}

	if (!host) {
		return new OtelMetrics();
	}

	const port = getOtelPortFromEnv();
	const config: OtelConfig = {
		host,
		port: port ?? DEFAULT_OTLP_PORT,
		protocol: getOtelProtocolFromEnv(),
		serviceName: process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE,
	};

	return new OtelMetrics(config);
}

export function createOtelLogsFromEnv(): OtelLogs {
	const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
	const genericEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	const host = getOtelHostFromEnv();

	if (logsEndpoint) {
		return new OtelLogs({
			otlpEndpoint: logsEndpoint.replace(/\/v1\/(metrics|logs)\/?$/, ""),
			serviceName: process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE,
		});
	}

	if (genericEndpoint) {
		return new OtelLogs({
			otlpEndpoint: genericEndpoint.replace(/\/v1\/(metrics|logs)\/?$/, ""),
			serviceName: process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE,
		});
	}

	if (!host) {
		return new OtelLogs();
	}

	const port = getOtelPortFromEnv();
	const config: OtelConfig = {
		host,
		port: port ?? DEFAULT_OTLP_PORT,
		protocol: getOtelProtocolFromEnv(),
		serviceName: process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE,
	};

	return new OtelLogs(config);
}
