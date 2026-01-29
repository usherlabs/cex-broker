import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
	MeterProvider,
	PeriodicExportingMetricReader,
	type MeterProvider as MeterProviderType,
} from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
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

export class OtelMetrics {
	private meterProvider: MeterProviderType | null = null;
	private isEnabled: boolean = false;
	private defaultService: string = DEFAULT_SERVICE;
	private readonly counters = new Map<
		string,
		ReturnType<ReturnType<MeterProviderType["getMeter"]>["createCounter"]>
	>();
	private readonly histograms = new Map<
		string,
		ReturnType<ReturnType<MeterProviderType["getMeter"]>["createHistogram"]>
	>();

	constructor(config?: OtelConfig) {
		const endpoint = resolveOtlpEndpoint(config);
		if (!endpoint) {
			log.info("OTel metrics disabled: no OTLP endpoint or host provided");
			return;
		}

		try {
			this.isEnabled = true;
			this.defaultService = config?.serviceName ?? DEFAULT_SERVICE;

			const exporter = new OTLPMetricExporter({
				url: endpoint.endsWith("/v1/metrics")
					? endpoint
					: `${endpoint}/v1/metrics`,
			});

			const reader = new PeriodicExportingMetricReader({
				exporter,
				exportIntervalMillis: EXPORT_INTERVAL_MS,
			});

			const resource = resourceFromAttributes({
				"service.name": this.defaultService,
			});

			this.meterProvider = new MeterProvider({
				resource,
				readers: [reader],
			});

			metrics.setGlobalMeterProvider(this.meterProvider);
			log.info(`OTel metrics enabled: ${endpoint}`);
		} catch (error) {
			log.error("Failed to initialize OTel metrics:", error);
			this.isEnabled = false;
			this.meterProvider = null;
		}
	}

	public isOtelEnabled(): boolean {
		return this.isEnabled && this.meterProvider !== null;
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
		service: string = this.defaultService,
	): Promise<void> {
		if (!this.isOtelEnabled() || !this.meterProvider) return;
		try {
			let counter = this.counters.get(metricName);
			if (!counter) {
				const meter = this.meterProvider.getMeter(
					"cex-broker-metrics",
					"1.0.0",
				);
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
		service: string = this.defaultService,
	): Promise<void> {
		if (!this.isOtelEnabled() || !this.meterProvider) return;
		try {
			let hist = this.histograms.get(`gauge_${metricName}`);
			if (!hist) {
				const meter = this.meterProvider.getMeter(
					"cex-broker-metrics",
					"1.0.0",
				);
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
		service: string = this.defaultService,
	): Promise<void> {
		if (!this.isOtelEnabled() || !this.meterProvider) return;
		try {
			let hist = this.histograms.get(metricName);
			if (!hist) {
				const meter = this.meterProvider.getMeter(
					"cex-broker-metrics",
					"1.0.0",
				);
				hist = meter.createHistogram(metricName, { description: metricName });
				this.histograms.set(metricName, hist);
			}
			hist.record(value, toAttributes(labels, service));
		} catch (error) {
			log.error("Failed to record histogram:", error);
		}
	}

	public async close(): Promise<void> {
		if (this.meterProvider) {
			try {
				await this.meterProvider.shutdown();
				log.info("OTel MeterProvider shut down");
			} catch (error) {
				log.error("Error shutting down OTel MeterProvider:", error);
			}
			this.meterProvider = null;
		}
	}
}

function resolveOtlpEndpoint(config?: OtelConfig): string | null {
	if (config?.otlpEndpoint) return config.otlpEndpoint;
	if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
		return process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(
			/\/v1\/metrics\/?$/,
			"",
		);
	}
	if (config?.host) {
		const protocol = config.protocol || "http";
		const port = config.port ?? DEFAULT_OTLP_PORT;
		return `${protocol}://${config.host}:${port}`;
	}
	return null;
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
