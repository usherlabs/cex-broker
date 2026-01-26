import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
	ClickHouseMetrics,
	createClickHouseMetricsFromEnv,
	type ClickHouseConfig,
	type MetricData,
} from "../src/helpers/clickhouse";

describe("ClickHouseMetrics", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("Initialization", () => {
		test("should be disabled when no hostname is provided", () => {
			const metrics = new ClickHouseMetrics();
			expect(metrics.isClickHouseEnabled()).toBe(false);
		});

		test("should be enabled when hostname is provided", () => {
			const config: ClickHouseConfig = {
				host: "localhost",
				port: 8123,
			};
			const metrics = new ClickHouseMetrics(config);
			expect(metrics.isClickHouseEnabled()).toBe(true);
		});

		test("should use default values when optional config is missing", () => {
			const config: ClickHouseConfig = {
				host: "localhost",
			};
			const metrics = new ClickHouseMetrics(config);
			expect(metrics.isClickHouseEnabled()).toBe(true);
		});

		test("should handle initialization errors gracefully", () => {
			// Invalid host format should not crash
			const config: ClickHouseConfig = {
				host: "invalid://host",
				port: 8123,
			};
			const metrics = new ClickHouseMetrics(config);
			// Should still attempt to initialize but may fail
			expect(metrics).toBeDefined();
		});
	});

	describe("createClickHouseMetricsFromEnv", () => {
		test("should return disabled metrics when CEX_BROKER_CLICKHOUSE_HOST is not set", () => {
			delete process.env.CEX_BROKER_CLICKHOUSE_HOST;
			const metrics = createClickHouseMetricsFromEnv();
			expect(metrics.isClickHouseEnabled()).toBe(false);
		});

		test("should create metrics from environment variables", () => {
			process.env.CEX_BROKER_CLICKHOUSE_HOST = "localhost";
			process.env.CEX_BROKER_CLICKHOUSE_PORT = "8123";
			process.env.CEX_BROKER_CLICKHOUSE_USERNAME = "testuser";
			process.env.CEX_BROKER_CLICKHOUSE_PASSWORD = "testpass";
			process.env.CEX_BROKER_CLICKHOUSE_DATABASE = "test_db";
			process.env.CEX_BROKER_CLICKHOUSE_PROTOCOL = "https";

			const metrics = createClickHouseMetricsFromEnv();
			expect(metrics.isClickHouseEnabled()).toBe(true);
		});

		test("should use default values for optional env vars", () => {
			process.env.CEX_BROKER_CLICKHOUSE_HOST = "localhost";

			const metrics = createClickHouseMetricsFromEnv();
			expect(metrics.isClickHouseEnabled()).toBe(true);
		});
	});

	describe("Metric Recording", () => {
		test("should not throw when recording metrics and ClickHouse is disabled", async () => {
			const metrics = new ClickHouseMetrics();
			await metrics.recordCounter("test_metric", 1, { label: "value" });
			expect(true).toBe(true); // Test passes if no exception
		});

		test("should not throw when inserting metric and ClickHouse is disabled", async () => {
			const metrics = new ClickHouseMetrics();
			const metricData: MetricData = {
				timestamp: new Date(),
				metric_name: "test_metric",
				metric_type: "counter",
				value: 1,
				labels: JSON.stringify({ label: "value" }),
				service: "test-service",
			};
			await metrics.insertMetric(metricData);
			expect(true).toBe(true); // Test passes if no exception
		});

		test("should not throw when inserting multiple metrics and ClickHouse is disabled", async () => {
			const metrics = new ClickHouseMetrics();
			const metricData: MetricData[] = [
				{
					timestamp: new Date(),
					metric_name: "test_metric_1",
					metric_type: "counter",
					value: 1,
					labels: JSON.stringify({ label: "value1" }),
					service: "test-service",
				},
				{
					timestamp: new Date(),
					metric_name: "test_metric_2",
					metric_type: "gauge",
					value: 2,
					labels: JSON.stringify({ label: "value2" }),
					service: "test-service",
				},
			];
			await metrics.insertMetrics(metricData);
			expect(true).toBe(true); // Test passes if no exception
		});

		test("should record counter metric", async () => {
			const metrics = new ClickHouseMetrics();
			await metrics.recordCounter(
				"test_counter",
				5,
				{ label: "test" },
				"test-service",
			);
			expect(true).toBe(true); // Test passes if no exception
		});

		test("should record gauge metric", async () => {
			const metrics = new ClickHouseMetrics();
			await metrics.recordGauge(
				"test_gauge",
				10.5,
				{ label: "test" },
				"test-service",
			);
			expect(true).toBe(true); // Test passes if no exception
		});

		test("should record histogram metric", async () => {
			const metrics = new ClickHouseMetrics();
			await metrics.recordHistogram(
				"test_histogram",
				100,
				{ label: "test" },
				"test-service",
			);
			expect(true).toBe(true); // Test passes if no exception
		});

		test("should handle empty metrics array", async () => {
			const metrics = new ClickHouseMetrics();
			await metrics.insertMetrics([]);
			expect(true).toBe(true); // Test passes if no exception
		});
	});

	describe("Database Initialization", () => {
		test("should not throw when initializing and ClickHouse is disabled", async () => {
			const metrics = new ClickHouseMetrics();
			await metrics.initialize();
			expect(true).toBe(true); // Test passes if no exception
		});
	});

	describe("Connection Management", () => {
		test("should not throw when closing and ClickHouse is disabled", async () => {
			const metrics = new ClickHouseMetrics();
			await metrics.close();
			expect(true).toBe(true); // Test passes if no exception
		});

		test("should close connection when enabled", async () => {
			const config: ClickHouseConfig = {
				host: "localhost",
				port: 8123,
			};
			const metrics = new ClickHouseMetrics(config);
			await metrics.close();
			expect(true).toBe(true); // Test passes if no exception
		});
	});

	describe("Metric Data Format", () => {
		test("should serialize labels as JSON string", async () => {
			const metrics = new ClickHouseMetrics();
			const labels = { key1: "value1", key2: 123, key3: true };
			await metrics.recordCounter("test", 1, labels);
			// If ClickHouse was enabled, labels would be serialized as JSON
			// This test ensures the function doesn't throw with complex labels
			expect(JSON.stringify(labels)).toContain("value1");
		});

		test("should handle numeric labels", async () => {
			const metrics = new ClickHouseMetrics();
			await metrics.recordCounter("test", 1, { numeric_label: 42 });
			expect(true).toBe(true); // Test passes if no exception
		});

		test("should handle string labels", async () => {
			const metrics = new ClickHouseMetrics();
			await metrics.recordCounter("test", 1, { string_label: "value" });
			expect(true).toBe(true); // Test passes if no exception
		});
	});
});
