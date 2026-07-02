import { afterEach, describe, expect, test } from "bun:test";
import type { LogRecord } from "@opentelemetry/api-logs";
import {
	buildOrderEventArchiveRow,
	buildSubscribeStreamArchiveRow,
	buildCommonArchiveTags,
} from "../src/helpers/broker-execution-archive/rows";
import {
	redactSecretLiterals,
	redactStreamPayload,
} from "../src/helpers/broker-execution-archive/redact";
import {
	BrokerExecutionArchiver,
	createBrokerExecutionArchiverFromEnv,
	isArchiveOtelLogsEnabled,
	resolveArchiveForwarderUrlFromEnv,
} from "../src/helpers/broker-execution-archive/writer";
import type { OtelLogs } from "../src/helpers/otel";
import { buildOrderExecutionTelemetry } from "../src/helpers/order-telemetry";

class MockOtelLogs implements OtelLogs {
	readonly emits: LogRecord[] = [];

	isOtelEnabled(): boolean {
		return true;
	}

	emit(record: LogRecord): void {
		this.emits.push(record);
	}

	async close(): Promise<void> {}
}

describe("broker execution archive redaction", () => {
	test("redacts secret literals and credential-shaped keys from stream payloads", () => {
		const redacted = redactStreamPayload(
			{
				apiKey: "super-secret-key",
				orderId: "123",
				nested: { signature: "abc", status: "FILLED" },
			},
			["super-secret-key"],
		);

		expect(redacted.apiKey).toBe("[redacted]");
		expect(redacted.orderId).toBe("123");
		expect(redacted.nested).toEqual({
			signature: "[redacted]",
			status: "FILLED",
		});
		expect(JSON.stringify(redacted)).not.toContain("super-secret-key");
	});

	test("redacts secret literals in diagnostic strings", () => {
		const message = redactSecretLiterals(
			'apiKey=live-key-123 and "secret":"hidden"',
			["live-key-123"],
		);
		expect(message).not.toContain("live-key-123");
		expect(message).toContain("[redacted]");
	});
});

describe("broker execution archive rows", () => {
	test("builds order event rows tagged for broker_execution.order_events", () => {
		const telemetry = buildOrderExecutionTelemetry(
			{
				action: "CancelOrder",
				cex: "binance",
				accountLabel: "primary",
				symbol: "ARB/USDT",
				clientOrderId: "client-1",
				makerActionId: "maker-1",
			},
			{ id: "99", status: "canceled", symbol: "ARB/USDT", side: "sell" },
		);
		const row = buildOrderEventArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				accountSelector: "primary",
				exchange: "binance",
				symbol: "ARB/USDT",
			}),
			action: "CancelOrder",
			telemetry,
		});

		expect(row.table).toBe("broker_execution.order_events");
		expect(row.row).toMatchObject({
			source: "broker_write",
			deployment_id: "deploy-a",
			account_selector: "primary",
			exchange: "binance",
			action: "CancelOrder",
			event_kind: "execute_action",
			order_id: "99",
			client_order_id: "client-1",
			maker_action_id: "maker-1",
		});
		expect(String(row.row.payload_json)).not.toContain("apiSecret");
	});

	test("builds subscribe stream rows without leaking secrets", () => {
		const row = buildSubscribeStreamArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				exchange: "binance",
				symbol: "ARB/USDT",
			}),
			subscriptionType: "ORDERS",
			streamPayload: {
				e: "executionReport",
				i: 42,
				c: "client-1",
				apiSecret: "must-not-appear",
			},
		});

		expect(row.row.event_kind).toBe("subscribe_stream");
		expect(row.row.subscription_type).toBe("ORDERS");
		expect(JSON.stringify(row.row)).not.toContain("must-not-appear");
	});
});

describe("broker execution archiver queue", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("enqueue is non-blocking and sheds oldest rows when queue is full", async () => {
		const posts: unknown[] = [];
		globalThis.fetch = (async (_url, init) => {
			posts.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const otelLogs = new MockOtelLogs();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			otelLogs,
			deploymentId: "test-deploy",
			maxQueueSize: 2,
			batchSize: 10,
			flushIntervalMs: 60_000,
		});

		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { source: "broker_write", order_id: "1" },
		});
		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { source: "broker_write", order_id: "2" },
		});
		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { source: "broker_write", order_id: "3" },
		});

		expect(archiver.getStats().shed).toBe(1);
		expect(archiver.getQueueDepth()).toBe(2);

		await archiver.flush();
		expect(posts).toHaveLength(0);
		expect(otelLogs.emits).toHaveLength(2);

		await archiver.close();
	});

	test("mirrors broker_execution rows to OTel logs but not market_data rows", async () => {
		const posts: unknown[] = [];
		globalThis.fetch = (async (_url, init) => {
			posts.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const otelLogs = new MockOtelLogs();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			otelLogs,
			deploymentId: "test-deploy",
			batchSize: 10,
			flushIntervalMs: 60_000,
		});

		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { source: "broker_write", order_id: "1" },
		});
		archiver.enqueue({
			table: "market_data.orderbook_snapshots",
			row: { source: "broker_write", best_bid: 100 },
		});

		await archiver.flush();

		expect(otelLogs.emits).toHaveLength(1);
		expect(otelLogs.emits[0]?.body).toBe("broker_execution.order_events");
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({
			rows: expect.arrayContaining([
				expect.objectContaining({ table: "market_data.orderbook_snapshots" }),
			]),
		});
		expect(posts[0]).not.toMatchObject({
			rows: expect.arrayContaining([
				expect.objectContaining({ table: "broker_execution.order_events" }),
			]),
		});

		await archiver.close();
	});

	test("drops market_data rows when forwarder URL is missing", async () => {
		const otelLogs = new MockOtelLogs();
		const archiver = BrokerExecutionArchiver.create({
			otelLogs,
			deploymentId: "test-deploy",
			batchSize: 10,
			flushIntervalMs: 60_000,
		});

		archiver.enqueue({
			table: "market_data.candles",
			row: { source: "broker_write", open_time_ms: 1_000 },
		});
		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { source: "broker_write", order_id: "1" },
		});

		expect(archiver.getQueueDepth()).toBe(1);

		await archiver.flush();
		expect(otelLogs.emits).toHaveLength(1);
		expect(otelLogs.emits[0]?.body).toBe("broker_execution.order_events");

		await archiver.close();
	});

	test("close exits after forwarder failure instead of retrying forever", async () => {
		globalThis.fetch = (async () =>
			new Response(null, { status: 503 })) as typeof fetch;

		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			deploymentId: "test-deploy",
			batchSize: 10,
			flushIntervalMs: 60_000,
		});

		archiver.enqueue({
			table: "market_data.candles",
			row: { source: "broker_write", open_time_ms: 1_000 },
		});

		await expect(archiver.close()).resolves.toBeUndefined();
		expect(archiver.getQueueDepth()).toBe(0);
		expect(archiver.getStats().forwarderFailures).toBeGreaterThan(0);
	});

	test("requeues only market rows after a mixed-batch forwarder failure", async () => {
		let postAttempts = 0;
		globalThis.fetch = (async () => {
			postAttempts += 1;
			return new Response(null, { status: 503 });
		}) as typeof fetch;

		const otelLogs = new MockOtelLogs();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			otelLogs,
			deploymentId: "test-deploy",
			batchSize: 10,
			flushIntervalMs: 60_000,
		});

		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { source: "broker_write", order_id: "1" },
		});
		archiver.enqueue({
			table: "market_data.candles",
			row: { source: "broker_write", open_time_ms: 1_000 },
		});

		await archiver.flush();
		expect(otelLogs.emits).toHaveLength(1);
		expect(archiver.getQueueDepth()).toBe(1);
		expect(postAttempts).toBe(1);

		await archiver.close();
	});
});

describe("broker execution archiver env", () => {
	test("createBrokerExecutionArchiverFromEnv uses ClickHouse forwarder by default without OTel logs", async () => {
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalClickhouseHost = process.env.CEX_BROKER_CLICKHOUSE_HOST;
		const originalClickhousePort = process.env.CEX_BROKER_CLICKHOUSE_PORT;
		const originalOtelLogsEnabled =
			process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		process.env.CEX_BROKER_CLICKHOUSE_HOST = "clickhouse.local";
		delete process.env.CEX_BROKER_CLICKHOUSE_PORT;
		delete process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		try {
			expect(resolveArchiveForwarderUrlFromEnv()).toBe(
				"http://clickhouse.local:8090/archive",
			);
			expect(isArchiveOtelLogsEnabled()).toBe(false);

			const otelLogs = new MockOtelLogs();
			const archiver = createBrokerExecutionArchiverFromEnv(otelLogs);
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});
			await archiver.flush();
			expect(otelLogs.emits).toHaveLength(0);
			await archiver.close();
		} finally {
			if (originalForwarderUrl === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
			} else {
				process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL = originalForwarderUrl;
			}
			if (originalClickhouseHost === undefined) {
				delete process.env.CEX_BROKER_CLICKHOUSE_HOST;
			} else {
				process.env.CEX_BROKER_CLICKHOUSE_HOST = originalClickhouseHost;
			}
			if (originalClickhousePort === undefined) {
				delete process.env.CEX_BROKER_CLICKHOUSE_PORT;
			} else {
				process.env.CEX_BROKER_CLICKHOUSE_PORT = originalClickhousePort;
			}
			if (originalOtelLogsEnabled === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;
			} else {
				process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED =
					originalOtelLogsEnabled;
			}
		}
	});

	test("createBrokerExecutionArchiverFromEnv mirrors to OTel logs only when enabled", async () => {
		const originalOtelLogsEnabled =
			process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;
		process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED = "true";

		try {
			const otelLogs = new MockOtelLogs();
			const archiver = createBrokerExecutionArchiverFromEnv(otelLogs);
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});
			await archiver.flush();
			expect(otelLogs.emits).toHaveLength(1);
			await archiver.close();
		} finally {
			if (originalOtelLogsEnabled === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;
			} else {
				process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED =
					originalOtelLogsEnabled;
			}
		}
	});
});
