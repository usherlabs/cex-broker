import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { log } from "./logger";

export interface ClickHouseConfig {
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	database?: string;
	protocol?: "http" | "https";
}

export interface MetricData {
	timestamp: Date;
	metric_name: string;
	metric_type: "counter" | "gauge" | "histogram";
	value: number;
	labels: string; // JSON string
	service: string;
}

export class ClickHouseMetrics {
	private client: ClickHouseClient | null = null;
	private isEnabled: boolean = false;
	private database: string = "fiet_metrics";
	private table: string = "fiet_metrics";

	constructor(config?: ClickHouseConfig) {
		if (!config?.host) {
			log.info("ClickHouse metrics disabled: no hostname provided");
			return;
		}

		try {
			this.isEnabled = true;
			this.database = config.database || "fiet_metrics";
			this.table = "fiet_metrics";

			this.client = createClient({
				host: `${config.protocol || "http"}://${config.host}:${config.port || 8123}`,
				username: config.username || "default",
				password: config.password || "",
				database: this.database,
			});

			log.info(
				`ClickHouse metrics enabled: ${config.host}:${config.port || 8123}`,
			);
		} catch (error) {
			log.error("Failed to initialize ClickHouse client:", error);
			this.isEnabled = false;
			this.client = null;
		}
	}

	/**
	 * Check if ClickHouse is enabled
	 */
	public isClickHouseEnabled(): boolean {
		return this.isEnabled && this.client !== null;
	}

	/**
	 * Initialize the database and table if they don't exist
	 */
	public async initialize(): Promise<void> {
		if (!this.isClickHouseEnabled() || !this.client) {
			return;
		}

		try {
			// Create database if it doesn't exist
			await this.client.exec(`
				CREATE DATABASE IF NOT EXISTS ${this.database}
			`);

			// Create table if it doesn't exist
			await this.client.exec(`
				CREATE TABLE IF NOT EXISTS ${this.database}.${this.table}
				(
					\`timestamp\` DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
					\`metric_name\` LowCardinality(String) CODEC(ZSTD(1)),
					\`metric_type\` LowCardinality(String) CODEC(ZSTD(1)),
					\`value\` Float64 CODEC(ZSTD(1)),
					\`labels\` String CODEC(ZSTD(1)),
					\`service\` LowCardinality(String) CODEC(ZSTD(1))
				)
				ENGINE = MergeTree
				PARTITION BY toDate(timestamp)
				ORDER BY (service, metric_name, toUnixTimestamp(timestamp))
				TTL toDateTime(timestamp) + toIntervalDay(30)
				SETTINGS ttl_only_drop_parts = 1
			`);

			log.info("ClickHouse database and table initialized successfully");
		} catch (error) {
			log.error("Failed to initialize ClickHouse database/table:", error);
			// Don't disable on init failure, might be a temporary issue
		}
	}

	/**
	 * Insert a single metric
	 */
	public async insertMetric(metric: MetricData): Promise<void> {
		if (!this.isClickHouseEnabled() || !this.client) {
			return;
		}

		try {
			await this.client.insert({
				table: `${this.database}.${this.table}`,
				values: [
					{
						timestamp: metric.timestamp,
						metric_name: metric.metric_name,
						metric_type: metric.metric_type,
						value: metric.value,
						labels: metric.labels,
						service: metric.service,
					},
				],
				format: "JSONEachRow",
			});
		} catch (error) {
			log.error("Failed to insert metric to ClickHouse:", error);
			// Don't throw - metrics should not break the main flow
		}
	}

	/**
	 * Insert multiple metrics in a batch
	 */
	public async insertMetrics(metrics: MetricData[]): Promise<void> {
		if (!this.isClickHouseEnabled() || !this.client || metrics.length === 0) {
			return;
		}

		try {
			await this.client.insert({
				table: `${this.database}.${this.table}`,
				values: metrics.map((metric) => ({
					timestamp: metric.timestamp,
					metric_name: metric.metric_name,
					metric_type: metric.metric_type,
					value: metric.value,
					labels: metric.labels,
					service: metric.service,
				})),
				format: "JSONEachRow",
			});
		} catch (error) {
			log.error("Failed to insert metrics to ClickHouse:", error);
			// Don't throw - metrics should not break the main flow
		}
	}

	/**
	 * Record a counter metric
	 */
	public async recordCounter(
		metricName: string,
		value: number,
		labels: Record<string, string | number>,
		service: string = "cex-broker",
	): Promise<void> {
		await this.insertMetric({
			timestamp: new Date(),
			metric_name: metricName,
			metric_type: "counter",
			value,
			labels: JSON.stringify(labels),
			service,
		});
	}

	/**
	 * Record a gauge metric
	 */
	public async recordGauge(
		metricName: string,
		value: number,
		labels: Record<string, string | number>,
		service: string = "cex-broker",
	): Promise<void> {
		await this.insertMetric({
			timestamp: new Date(),
			metric_name: metricName,
			metric_type: "gauge",
			value,
			labels: JSON.stringify(labels),
			service,
		});
	}

	/**
	 * Record a histogram metric
	 */
	public async recordHistogram(
		metricName: string,
		value: number,
		labels: Record<string, string | number>,
		service: string = "cex-broker",
	): Promise<void> {
		await this.insertMetric({
			timestamp: new Date(),
			metric_name: metricName,
			metric_type: "histogram",
			value,
			labels: JSON.stringify(labels),
			service,
		});
	}

	/**
	 * Close the ClickHouse client connection
	 */
	public async close(): Promise<void> {
		if (this.client) {
			try {
				await this.client.close();
				log.info("ClickHouse client closed");
			} catch (error) {
				log.error("Error closing ClickHouse client:", error);
			}
		}
	}
}

/**
 * Create a ClickHouse metrics instance from environment variables
 */
export function createClickHouseMetricsFromEnv(): ClickHouseMetrics {
	const host = process.env.CEX_BROKER_CLICKHOUSE_HOST;
	if (!host) {
		return new ClickHouseMetrics();
	}

	const config: ClickHouseConfig = {
		host,
		port: process.env.CEX_BROKER_CLICKHOUSE_PORT
			? Number.parseInt(process.env.CEX_BROKER_CLICKHOUSE_PORT, 10)
			: 8123,
		username: process.env.CEX_BROKER_CLICKHOUSE_USERNAME || "default",
		password: process.env.CEX_BROKER_CLICKHOUSE_PASSWORD || "",
		database: process.env.CEX_BROKER_CLICKHOUSE_DATABASE || "fiet_metrics",
		protocol:
			(process.env.CEX_BROKER_CLICKHOUSE_PROTOCOL as "http" | "https") ||
			"http",
	};

	return new ClickHouseMetrics(config);
}
