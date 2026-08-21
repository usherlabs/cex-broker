import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	AggregationTemporality,
	DataPointType,
	InMemoryMetricExporter,
	MeterProvider,
	type MeterProvider as MeterProviderType,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	createOtelMetricsFromEnv,
	type MetricData,
	type OtelConfig,
	OtelMetrics,
} from "../src/helpers/otel";

/** Create config that enables OTLP metrics (endpoint may be unreachable; recording still works). */
function enabledConfig(overrides?: Partial<OtelConfig>): OtelConfig {
	return {
		otlpEndpoint: "http://127.0.0.1:4318",
		serviceName: "test-service",
		...overrides,
	};
}

function createInMemoryMetrics(
	exporter: InMemoryMetricExporter,
	serviceName: string,
): OtelMetrics {
	class InMemoryOtelMetrics extends OtelMetrics {
		protected override createProvider(
			_endpoint: string,
			providerServiceName: string,
			_appendSignalPath: boolean,
		): MeterProviderType {
			return new MeterProvider({
				resource: resourceFromAttributes({
					"service.name": providerServiceName,
				}),
				readers: [
					new PeriodicExportingMetricReader({
						exporter,
						exportIntervalMillis: 60_000,
					}),
				],
			});
		}
	}

	return new InMemoryOtelMetrics({
		otlpEndpoint: "http://in-memory.invalid",
		serviceName,
	});
}

async function listen(
	server: ReturnType<typeof createServer>,
): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Blackhole collector did not bind to a TCP port");
	}
	return address.port;
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
		test("should be enabled when hostname is provided", async () => {
			const config: OtelConfig = {
				host: "localhost",
				port: 8123,
			};
			const metrics = new OtelMetrics(config);
			expect(metrics.isOtelEnabled()).toBe(true);
			await metrics.close();
		});

		test("should use default values when optional config is missing", async () => {
			const config: OtelConfig = {
				host: "localhost",
			};
			const metrics = new OtelMetrics(config);
			expect(metrics.isOtelEnabled()).toBe(true);
			await metrics.close();
		});

		test("should handle initialization errors gracefully", async () => {
			const config: OtelConfig = {
				host: "invalid://host",
				port: 8123,
			};
			const metrics = new OtelMetrics(config);
			expect(metrics).toBeDefined();
			await metrics.close();
		});
	});

	describe("createOtelMetricsFromEnv", () => {
		test("should create metrics from CEX_BROKER_OTEL_* env vars", async () => {
			process.env.CEX_BROKER_OTEL_HOST = "localhost";
			process.env.CEX_BROKER_OTEL_PORT = "8123";
			process.env.CEX_BROKER_OTEL_PROTOCOL = "https";

			const metrics = createOtelMetricsFromEnv();
			expect(metrics.isOtelEnabled()).toBe(true);
			await metrics.close();
		});

		test("should create metrics from legacy CEX_BROKER_CLICKHOUSE_* env vars", async () => {
			process.env.CEX_BROKER_CLICKHOUSE_HOST = "localhost";
			process.env.CEX_BROKER_CLICKHOUSE_PORT = "8123";
			process.env.CEX_BROKER_CLICKHOUSE_PROTOCOL = "https";

			const metrics = createOtelMetricsFromEnv();
			expect(metrics.isOtelEnabled()).toBe(true);
			await metrics.close();
		});

		test("should use default values for optional env vars", async () => {
			process.env.CEX_BROKER_OTEL_HOST = "localhost";

			const metrics = createOtelMetricsFromEnv();
			expect(metrics.isOtelEnabled()).toBe(true);
			await metrics.close();
		});

		test("should prefer OTEL_EXPORTER_OTLP_ENDPOINT when set", async () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
			process.env.CEX_BROKER_OTEL_HOST = "legacy-host";

			const metrics = createOtelMetricsFromEnv();
			expect(metrics.isOtelEnabled()).toBe(true);
			await metrics.close();
		});
	});

	describe("Metric Recording", () => {
		test("should not throw when recording metrics and OTel is disabled", async () => {
			const metrics = new OtelMetrics();
			await expect(
				metrics.recordCounter("test_metric", 1, { label: "value" }),
			).resolves.toBeUndefined();
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
			await expect(metrics.insertMetric(metricData)).resolves.toBeUndefined();
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
			await expect(metrics.insertMetrics(metricData)).resolves.toBeUndefined();
		});

		test("shutdown exports counter value, metric attributes, and service resource", async () => {
			const exporter = new InMemoryMetricExporter(
				AggregationTemporality.CUMULATIVE,
			);
			const metrics = createInMemoryMetrics(exporter, "resource-service");

			await metrics.recordCounter(
				"semantic_counter_total",
				7,
				{ custom: "kept" },
				"metric-service",
			);
			await metrics.close();

			const exported = exporter.getMetrics();
			expect(exported).toHaveLength(1);
			expect(exported[0]?.resource.attributes["service.name"]).toBe(
				"resource-service",
			);
			const counter = exported
				.flatMap(({ scopeMetrics }) => scopeMetrics)
				.flatMap(({ metrics: scopeMetricData }) => scopeMetricData)
				.find(({ descriptor }) => descriptor.name === "semantic_counter_total");
			expect(counter?.dataPointType).toBe(DataPointType.SUM);
			if (!counter || counter.dataPointType !== DataPointType.SUM) {
				throw new Error("Expected shutdown to export a sum counter");
			}
			expect(counter.dataPoints).toHaveLength(1);
			expect(counter.dataPoints[0]?.value).toBe(7);
			expect(counter.dataPoints[0]?.attributes).toEqual({
				custom: "kept",
				service: "metric-service",
			});
		});

		test("should handle empty metrics array", async () => {
			const metrics = new OtelMetrics();
			await expect(metrics.insertMetrics([])).resolves.toBeUndefined();
		});
	});

	describe("Initialization (no-op)", () => {
		test("should not throw when initializing and OTel is disabled", async () => {
			const metrics = new OtelMetrics();
			await expect(metrics.initialize()).resolves.toBeUndefined();
		});
	});

	describe("Connection Management", () => {
		test("should not throw when closing and OTel is disabled", async () => {
			const metrics = new OtelMetrics();
			await expect(metrics.close()).resolves.toBeUndefined();
		});

		test("should close connection when enabled", async () => {
			const config: OtelConfig = {
				host: "localhost",
				port: 8123,
			};
			const metrics = new OtelMetrics(config);
			expect(metrics.isOtelEnabled()).toBe(true);
			await metrics.close();
			expect(metrics.isOtelEnabled()).toBe(false);
		});

		test("coalesces concurrent and repeated provider shutdown calls", async () => {
			const exporter = new InMemoryMetricExporter(
				AggregationTemporality.CUMULATIVE,
			);
			let shutdownCalls = 0;
			class CountingOtelMetrics extends OtelMetrics {
				protected override createProvider(
					_endpoint: string,
					serviceName: string,
					_appendSignalPath: boolean,
				): MeterProviderType {
					return new MeterProvider({
						resource: resourceFromAttributes({ "service.name": serviceName }),
						readers: [
							new PeriodicExportingMetricReader({
								exporter,
								exportIntervalMillis: 60_000,
							}),
						],
					});
				}

				protected override shutdownProvider(
					provider: MeterProviderType,
				): Promise<void> {
					shutdownCalls += 1;
					return super.shutdownProvider(provider);
				}
			}
			const metrics = new CountingOtelMetrics(enabledConfig());
			await metrics.recordCounter("idempotent_close_total", 1, {});

			const first = metrics.close();
			const second = metrics.close();
			const third = metrics.close();
			expect(second).toBe(first);
			expect(third).toBe(first);
			await Promise.all([first, second, third]);
			expect(metrics.close()).toBe(first);

			expect(shutdownCalls).toBe(1);
			expect(metrics.isOtelEnabled()).toBe(false);
		});

		test("observes a provider rejection that arrives after the shutdown deadline", async () => {
			let rejectShutdown: ((reason: Error) => void) | undefined;
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);

			class LateRejectingOtelMetrics extends OtelMetrics {
				protected override shutdownProvider(
					provider: MeterProviderType,
				): Promise<void> {
					return new Promise<void>((_resolve, reject) => {
						rejectShutdown = (reason) => {
							void super.shutdownProvider(provider).then(
								() => reject(reason),
								() => reject(reason),
							);
						};
					});
				}
			}

			const metrics = new LateRejectingOtelMetrics({
				otlpEndpoint: "http://127.0.0.1:1",
				serviceName: "late-rejection-test",
			});
			const closing = metrics.close();
			try {
				await Bun.sleep(3_100);
				expect(metrics.isOtelEnabled()).toBe(false);
				await closing;
				const rejectAfterDeadline = rejectShutdown;
				rejectShutdown = undefined;
				rejectAfterDeadline?.(new Error("late provider rejection"));
				await Bun.sleep(50);
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
				rejectShutdown?.(new Error("late provider cleanup"));
				await closing;
			}
		}, 5_000);
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
		test("close flushes a non-empty OTLP metrics request before resolving", async () => {
			const receivedBodies: Uint8Array[] = [];
			const server = Bun.serve({
				port: 0,
				async fetch(req) {
					if (req.url.endsWith("/v1/metrics") && req.method === "POST") {
						receivedBodies.push(new Uint8Array(await req.arrayBuffer()));
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

			try {
				await metrics.recordCounter("integration_counter", 1, {
					test: "true",
				});
				await metrics.close();

				expect(receivedBodies).toHaveLength(1);
				expect(receivedBodies[0]?.byteLength).toBeGreaterThan(0);
			} finally {
				server.stop();
			}
		});

		test("blackhole collector cannot hold shutdown past the OTEL deadline", async () => {
			const sockets = new Set<Socket>();
			let resolveConnection: (() => void) | undefined;
			const connectionAttempted = new Promise<void>((resolve) => {
				resolveConnection = resolve;
			});
			const server = createServer((socket) => {
				sockets.add(socket);
				socket.once("close", () => sockets.delete(socket));
				resolveConnection?.();
			});
			const port = await listen(server);
			const metrics = new OtelMetrics({
				otlpEndpoint: `http://127.0.0.1:${port}`,
				serviceName: "blackhole-test",
			});

			try {
				await metrics.recordCounter("blackhole_shutdown_total", 1, {
					attempt: "expected",
				});
				const started = performance.now();
				const closing = metrics.close();
				const disabledImmediately = !metrics.isOtelEnabled();
				await connectionAttempted;
				await closing;
				const elapsedMs = performance.now() - started;

				expect(disabledImmediately).toBe(true);
				expect(elapsedMs).toBeLessThan(3_500);
			} finally {
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		}, 12_000);
	});
});
