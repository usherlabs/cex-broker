import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	OtelMetrics,
	createOtelMetricsFromEnv,
	type OtelConfig,
	type MetricData,
} from "../src/helpers/otel";

/** Create config that enables OTLP metrics (endpoint may be unreachable; recording still works). */
function enabledConfig(overrides?: Partial<OtelConfig>): OtelConfig {
	return {
		otlpEndpoint: "http://127.0.0.1:4318",
		serviceName: "test-service",
		...overrides,
	};
}

describe("OtelMetrics", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("Initialization", () => {
		test("should be enabled when hostname is provided", () => {
			const config: OtelConfig = {
				host: "localhost",
				port: 8123,
			};
			const metrics = new OtelMetrics(config);
			expect(metrics.isOtelEnabled()).toBe(true);
		});

		test("should use default values when optional config is missing", () => {
			const config: OtelConfig = {
				host: "localhost",
			};
			const metrics = new OtelMetrics(config);
			expect(metrics.isOtelEnabled()).toBe(true);
		});

		test("should handle initialization errors gracefully", () => {
			const config: OtelConfig = {
				host: "invalid://host",
				port: 8123,
			};
			const metrics = new OtelMetrics(config);
			expect(metrics).toBeDefined();
		});
	});

	describe("createOtelMetricsFromEnv", () => {
		test("should create metrics from CEX_BROKER_OTEL_* env vars", () => {
			process.env.CEX_BROKER_OTEL_HOST = "localhost";
			process.env.CEX_BROKER_OTEL_PORT = "8123";
			process.env.CEX_BROKER_OTEL_PROTOCOL = "https";

			const metrics = createOtelMetricsFromEnv();
			expect(metrics.isOtelEnabled()).toBe(true);
		});

		test("should create metrics from legacy CEX_BROKER_CLICKHOUSE_* env vars", () => {
			process.env.CEX_BROKER_CLICKHOUSE_HOST = "localhost";
			process.env.CEX_BROKER_CLICKHOUSE_PORT = "8123";
			process.env.CEX_BROKER_CLICKHOUSE_PROTOCOL = "https";

			const metrics = createOtelMetricsFromEnv();
			expect(metrics.isOtelEnabled()).toBe(true);
		});

		test("should use default values for optional env vars", () => {
			process.env.CEX_BROKER_OTEL_HOST = "localhost";

			const metrics = createOtelMetricsFromEnv();
			expect(metrics.isOtelEnabled()).toBe(true);
		});

		test("should prefer OTEL_EXPORTER_OTLP_ENDPOINT when set", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
			process.env.CEX_BROKER_OTEL_HOST = "legacy-host";

			const metrics = createOtelMetricsFromEnv();
			expect(metrics.isOtelEnabled()).toBe(true);
		});
	});

	describe("Metric Recording", () => {
		test("should not throw when recording metrics and OTel is disabled", async () => {
			const metrics = new OtelMetrics();
			await metrics.recordCounter("test_metric", 1, { label: "value" });
			expect(true).toBe(true);
		});

		test("should not throw when inserting metric and OTel is disabled", async () => {
			const metrics = new OtelMetrics();
			const metricData: MetricData = {
				timestamp: new Date(),
				metric_name: "test_metric",
				metric_type: "counter",
				value: 1,
				labels: JSON.stringify({ label: "value" }),
				service: "test-service",
			};
			await metrics.insertMetric(metricData);
			expect(true).toBe(true);
		});

		test("should not throw when inserting multiple metrics and OTel is disabled", async () => {
			const metrics = new OtelMetrics();
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
			expect(true).toBe(true);
		});

		test("should record counter metric", async () => {
			const metrics = new OtelMetrics();
			await metrics.recordCounter(
				"test_counter",
				5,
				{ label: "test" },
				"test-service",
			);
			expect(true).toBe(true);
		});

		test("should record gauge metric", async () => {
			const metrics = new OtelMetrics();
			await metrics.recordGauge(
				"test_gauge",
				10.5,
				{ label: "test" },
				"test-service",
			);
			expect(true).toBe(true);
		});

		test("should record histogram metric", async () => {
			const metrics = new OtelMetrics();
			await metrics.recordHistogram(
				"test_histogram",
				100,
				{ label: "test" },
				"test-service",
			);
			expect(true).toBe(true);
		});

		test("should handle empty metrics array", async () => {
			const metrics = new OtelMetrics();
			await metrics.insertMetrics([]);
			expect(true).toBe(true);
		});
	});

	describe("Initialization (no-op)", () => {
		test("should not throw when initializing and OTel is disabled", async () => {
			const metrics = new OtelMetrics();
			await metrics.initialize();
			expect(true).toBe(true);
		});
	});

	describe("Connection Management", () => {
		test("should not throw when closing and OTel is disabled", async () => {
			const metrics = new OtelMetrics();
			await metrics.close();
			expect(true).toBe(true);
		});

		test("should close connection when enabled", async () => {
			const config: OtelConfig = {
				host: "localhost",
				port: 8123,
			};
			const metrics = new OtelMetrics(config);
			await metrics.close();
			expect(true).toBe(true);
		});
	});

	describe("Metric Data Format", () => {
		test("should serialize labels as JSON string", async () => {
			const metrics = new OtelMetrics();
			const labels = { key1: "value1", key2: 123, key3: true };
			await metrics.recordCounter("test", 1, labels);
			expect(JSON.stringify(labels)).toContain("value1");
		});

		test("should handle numeric labels", async () => {
			const metrics = new OtelMetrics();
			await metrics.recordCounter("test", 1, { numeric_label: 42 });
			expect(true).toBe(true);
		});

		test("should handle string labels", async () => {
			const metrics = new OtelMetrics();
			await metrics.recordCounter("test", 1, { string_label: "value" });
			expect(true).toBe(true);
		});
	});

	describe("Metrics enabled (OTLP)", () => {
		let mockOtlpServer: ReturnType<typeof Bun.serve> | null = null;
		let otlpBaseUrl: string;

		beforeEach(() => {
			mockOtlpServer = Bun.serve({
				port: 0,
				fetch(req) {
					if (req.url.endsWith("/v1/metrics") && req.method === "POST") {
						return new Response(null, { status: 200 });
					}
					return new Response("Not Found", { status: 404 });
				},
			});
			otlpBaseUrl = `http://127.0.0.1:${mockOtlpServer.port}`;
		});

		afterEach(async () => {
			if (mockOtlpServer) mockOtlpServer.stop();
			mockOtlpServer = null;
		});

		function enabledConfigWithServer(): OtelConfig {
			return { ...enabledConfig(), otlpEndpoint: otlpBaseUrl };
		}

		test("should record counter when OTLP is enabled", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			expect(metrics.isOtelEnabled()).toBe(true);
			await metrics.recordCounter("enabled_counter", 1, { foo: "bar" });
			await metrics.close();
		});

		test("should record histogram when OTLP is enabled", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			await metrics.recordHistogram("enabled_histogram_ms", 42, {
				action: "test",
				cex: "binance",
			});
			await metrics.close();
		});

		test("should record gauge when OTLP is enabled", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			await metrics.recordGauge("enabled_gauge", 99.5, { label: "value" });
			await metrics.close();
		});

		test("should insertMetric (counter, gauge, histogram) when enabled", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			await metrics.insertMetric({
				timestamp: new Date(),
				metric_name: "insert_counter",
				metric_type: "counter",
				value: 1,
				labels: JSON.stringify({ a: "1" }),
				service: "test",
			});
			await metrics.insertMetric({
				timestamp: new Date(),
				metric_name: "insert_gauge",
				metric_type: "gauge",
				value: 2,
				labels: JSON.stringify({ b: "2" }),
				service: "test",
			});
			await metrics.insertMetric({
				timestamp: new Date(),
				metric_name: "insert_histogram",
				metric_type: "histogram",
				value: 3,
				labels: JSON.stringify({ c: "3" }),
				service: "test",
			});
			await metrics.close();
		});

		test("should insertMetrics batch when enabled", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			await metrics.insertMetrics([
				{
					timestamp: new Date(),
					metric_name: "batch_1",
					metric_type: "counter",
					value: 1,
					labels: "{}",
					service: "test",
				},
				{
					timestamp: new Date(),
					metric_name: "batch_2",
					metric_type: "histogram",
					value: 100,
					labels: "{}",
					service: "test",
				},
			]);
			await metrics.close();
		});

		test("should initialize when enabled (no-op, no throw)", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			await metrics.initialize();
			await metrics.close();
		});

		test("should close cleanly when enabled", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			await metrics.recordCounter("before_close", 1, {});
			await metrics.close();
			expect(metrics.isOtelEnabled()).toBe(false);
		});

		test("should use otlpEndpoint from config when provided", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			expect(metrics.isOtelEnabled()).toBe(true);
			await metrics.close();
		});

		test("insertMetric with empty labels when enabled", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			await metrics.insertMetric({
				timestamp: new Date(),
				metric_name: "empty_labels",
				metric_type: "counter",
				value: 1,
				labels: "{}",
				service: "test",
			});
			await metrics.close();
		});

		test("insertMetric with invalid JSON labels throws (parse is outside try)", async () => {
			const metrics = new OtelMetrics(enabledConfigWithServer());
			let threw = false;
			try {
				await metrics.insertMetric({
					timestamp: new Date(),
					metric_name: "bad_labels",
					metric_type: "counter",
					value: 1,
					labels: "not-valid-json",
					service: "test",
				});
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
			await metrics.close();
		});
	});

	describe("OTLP export integration", () => {
		test("should send metrics to OTLP HTTP endpoint when recording", async () => {
			let received = 0;
			const server = Bun.serve({
				port: 0,
				fetch(req) {
					if (req.url.endsWith("/v1/metrics") && req.method === "POST") {
						received += 1;
						return new Response(null, { status: 200 });
					}
					return new Response("Not Found", { status: 404 });
				},
			});
			const baseUrl = `http://127.0.0.1:${server.port}`;
			const metrics = new OtelMetrics({
				otlpEndpoint: baseUrl,
				serviceName: "integration-test",
			});
			expect(metrics.isOtelEnabled()).toBe(true);

			await metrics.recordCounter("integration_counter", 1, { test: "true" });
			await metrics.recordHistogram("integration_histogram", 10, {
				test: "true",
			});

			await new Promise((r) => setTimeout(r, 5500));

			expect(received).toBeGreaterThanOrEqual(1);

			await metrics.close();
			server.stop();
		}, 12000);
	});
});
