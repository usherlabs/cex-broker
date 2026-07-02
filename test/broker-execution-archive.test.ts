import { describe, expect, test } from "bun:test";
import type { LogRecord } from "@opentelemetry/api-logs";
import { startForwarderServer } from "./archive-forwarder-server";
import {
	redactSecretLiterals,
	redactStreamPayload,
} from "../src/helpers/broker-execution-archive/redact";
import {
	buildCommonArchiveTags,
	buildMarketMetadataSnapshotRow,
	buildOrderEventArchiveRow,
	buildSubscribeStreamArchiveRow,
} from "../src/helpers/broker-execution-archive/rows";
import {
	BrokerExecutionArchiver,
	createBrokerExecutionArchiverFromEnv,
	isArchiveOtelLogsEnabled,
	resolveArchiveForwarderUrlFromEnv,
} from "../src/helpers/broker-execution-archive/writer";
import { buildOrderExecutionTelemetry } from "../src/helpers/order-telemetry";
import type { OtelLogs } from "../src/helpers/otel";

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = original;
	}
}

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

	test("omits absent optional join keys so they insert as NULL, not empty string", () => {
		const telemetry = buildOrderExecutionTelemetry(
			{
				action: "CreateOrder",
				cex: "binance",
				accountLabel: "primary",
				symbol: "ARB/USDT",
			},
			{ status: "new", symbol: "ARB/USDT", side: "buy" },
		);
		const orderRow = buildOrderEventArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				exchange: "binance",
				symbol: "ARB/USDT",
			}),
			action: "CreateOrder",
			telemetry,
		});
		// Absent identifiers must be OMITTED from the payload (not "") so the
		// Nullable(String) columns receive NULL and never spuriously join on ''.
		for (const key of [
			"order_id",
			"client_order_id",
			"idempotency_id",
			"maker_action_id",
			"market_metadata_hash",
		]) {
			expect(orderRow.row).not.toHaveProperty(key);
		}

		const snapshotRow = buildMarketMetadataSnapshotRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				exchange: "binance",
				symbol: "ARB/USDT",
			}),
			marketSnapshot: { bids: [], asks: [] },
		});
		for (const key of [
			"client_order_id",
			"order_id",
			"maker_action_id",
			"idempotency_id",
		]) {
			expect(snapshotRow.row).not.toHaveProperty(key);
		}
		// A snapshot always computes its content hash, so it is always present.
		expect(snapshotRow.row).toHaveProperty("market_metadata_hash");
	});
});

describe("broker execution archiver queue", () => {
	test("posts JSON with the bearer token over the real node:http transport", async () => {
		const server = await startForwarderServer();
		const originalToken = process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN;
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN = "secret-token";

		try {
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deploymentId: "test-deploy",
				batchSize: 10,
				flushIntervalMs: 60_000,
			});

			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});

			await archiver.flush();

			expect(server.requests).toHaveLength(1);
			const request = server.requests[0];
			expect(request?.method).toBe("POST");
			expect(request?.headers["content-type"]).toBe("application/json");
			expect(request?.headers.authorization).toBe("Bearer secret-token");
			expect(request?.body).toMatchObject({
				source: "broker_write",
				deployment_id: "test-deploy",
			});

			await archiver.close();
		} finally {
			await server.close();
			if (originalToken === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN;
			} else {
				process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN = originalToken;
			}
		}
	});

	test("enqueue is non-blocking and sheds oldest rows when queue is full", async () => {
		const server = await startForwarderServer();
		try {
			const otelLogs = new MockOtelLogs();
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
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
			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.body.rows).toHaveLength(2);
			expect(otelLogs.emits).toHaveLength(2);

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("mirrors broker_execution rows to OTel logs and posts every table to the forwarder", async () => {
		const server = await startForwarderServer();
		try {
			const otelLogs = new MockOtelLogs();
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
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

			// Only execution rows mirror to OTel (market_data has no OTel schema)...
			expect(otelLogs.emits).toHaveLength(1);
			expect(otelLogs.emits[0]?.body).toBe("broker_execution.order_events");
			// ...but the forwarder is the durable sink for both tables.
			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.body).toMatchObject({
				rows: expect.arrayContaining([
					expect.objectContaining({ table: "broker_execution.order_events" }),
					expect.objectContaining({ table: "market_data.orderbook_snapshots" }),
				]),
			});

			await archiver.close();
		} finally {
			await server.close();
		}
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
		const server = await startForwarderServer(() => ({ status: 503 }));
		try {
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
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
		} finally {
			await server.close();
		}
	});

	test("requeues the whole batch after a forwarder network failure", async () => {
		// Abort the socket so the client's node:http request errors — the network
		// failure path (distinct from the non-2xx path exercised elsewhere).
		const server = await startForwarderServer(() => ({ destroy: true }));
		try {
			const otelLogs = new MockOtelLogs();
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
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
			// The execution row still reached OTel (mirror happens before the post),
			// and both rows are requeued for a later forwarder retry — neither is lost.
			expect(otelLogs.emits).toHaveLength(1);
			expect(archiver.getQueueDepth()).toBe(2);
			expect(server.requests).toHaveLength(1);

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("posts broker_execution rows to the forwarder even without OTel logs", async () => {
		const server = await startForwarderServer();
		try {
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deploymentId: "test-deploy",
				batchSize: 10,
				flushIntervalMs: 60_000,
			});

			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});

			await archiver.flush();
			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.body).toMatchObject({
				rows: expect.arrayContaining([
					expect.objectContaining({ table: "broker_execution.order_events" }),
				]),
			});

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("keeps the queue within maxQueueSize when a failed batch is requeued after refill", async () => {
		// Gate the forwarder so a batch stays in flight while new rows refill the
		// queue, then fail it — the classic over-cap window for the requeue path.
		let releasePost: () => void = () => {};
		const postGate = new Promise<void>((resolve) => {
			releasePost = resolve;
		});
		const server = await startForwarderServer(async () => {
			await postGate;
			return { status: 503 };
		});
		try {
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deploymentId: "test-deploy",
				maxQueueSize: 3,
				batchSize: 4, // above the 3 rows we enqueue, so only manual flush drains
				flushIntervalMs: 60_000,
			});
			const row = (id: string) =>
				({
					table: "broker_execution.order_events",
					row: { source: "broker_write", order_id: id },
				}) as const;

			archiver.enqueue(row("1"));
			archiver.enqueue(row("2"));
			archiver.enqueue(row("3"));

			// Splices [1,2,3] out and blocks on the gated forwarder response.
			const flushPromise = archiver.flush();
			expect(archiver.getQueueDepth()).toBe(0);

			// Queue refills to the cap while the batch is in flight.
			archiver.enqueue(row("4"));
			archiver.enqueue(row("5"));
			archiver.enqueue(row("6"));
			expect(archiver.getQueueDepth()).toBe(3);

			releasePost();
			await flushPromise;

			// Without bound enforcement this would be 6 (3 refill + 3 requeued).
			expect(archiver.getQueueDepth()).toBe(3);
			expect(archiver.getStats().shed).toBeGreaterThanOrEqual(3);

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("canPersistMarketMetadataSnapshot is true with a forwarder-only config", () => {
		const forwarderOnly = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			deploymentId: "test-deploy",
			flushIntervalMs: 60_000,
		});
		expect(forwarderOnly.canPersistMarketMetadataSnapshot()).toBe(true);

		const disabled = BrokerExecutionArchiver.disabled();
		expect(disabled.canPersistMarketMetadataSnapshot()).toBe(false);
	});
});

describe("broker execution archiver env", () => {
	test("resolveArchiveForwarderUrlFromEnv derives the ClickHouse forwarder URL with defaults", () => {
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalForwarderHost = process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		const originalForwarderPort = process.env.CEX_BROKER_ARCHIVE_FORWARDER_PORT;
		const originalClickhouseHost = process.env.CEX_BROKER_CLICKHOUSE_HOST;
		const originalOtelLogsEnabled =
			process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_PORT;
		process.env.CEX_BROKER_CLICKHOUSE_HOST = "clickhouse.local";
		delete process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		try {
			expect(resolveArchiveForwarderUrlFromEnv()).toBe(
				"http://clickhouse.local:8090/archive",
			);
			expect(isArchiveOtelLogsEnabled()).toBe(false);
		} finally {
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_URL", originalForwarderUrl);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_HOST", originalForwarderHost);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_PORT", originalForwarderPort);
			restoreEnv("CEX_BROKER_CLICKHOUSE_HOST", originalClickhouseHost);
			restoreEnv(
				"CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED",
				originalOtelLogsEnabled,
			);
		}
	});

	test("createBrokerExecutionArchiverFromEnv posts to the derived forwarder without OTel logs", async () => {
		const server = await startForwarderServer();
		const port = new URL(server.url).port;
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalForwarderHost = process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		const originalForwarderPort = process.env.CEX_BROKER_ARCHIVE_FORWARDER_PORT;
		const originalClickhouseHost = process.env.CEX_BROKER_CLICKHOUSE_HOST;
		const originalOtelLogsEnabled =
			process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		// Point the ClickHouse-host resolution path at the local forwarder so the
		// row actually travels the production node:http transport.
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		process.env.CEX_BROKER_CLICKHOUSE_HOST = "127.0.0.1";
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_PORT = port;
		delete process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		try {
			expect(resolveArchiveForwarderUrlFromEnv()).toBe(server.url);
			expect(isArchiveOtelLogsEnabled()).toBe(false);

			const otelLogs = new MockOtelLogs();
			const archiver = createBrokerExecutionArchiverFromEnv(otelLogs);
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});
			await archiver.flush();
			// No OTel mirror (flag off), but the row still lands at the forwarder.
			expect(otelLogs.emits).toHaveLength(0);
			expect(server.requests).toHaveLength(1);
			await archiver.close();
		} finally {
			await server.close();
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_URL", originalForwarderUrl);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_HOST", originalForwarderHost);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_PORT", originalForwarderPort);
			restoreEnv("CEX_BROKER_CLICKHOUSE_HOST", originalClickhouseHost);
			restoreEnv(
				"CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED",
				originalOtelLogsEnabled,
			);
		}
	});

	test("createBrokerExecutionArchiverFromEnv mirrors to OTel logs only when enabled", async () => {
		const originalOtelLogsEnabled =
			process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalForwarderHost = process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		const originalClickhouseHost = process.env.CEX_BROKER_CLICKHOUSE_HOST;
		process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED = "true";
		// Isolate the OTel mirror: no forwarder configured so flush has a single sink.
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		delete process.env.CEX_BROKER_CLICKHOUSE_HOST;

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
			if (originalForwarderUrl === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
			} else {
				process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL = originalForwarderUrl;
			}
			if (originalForwarderHost === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
			} else {
				process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST = originalForwarderHost;
			}
			if (originalClickhouseHost === undefined) {
				delete process.env.CEX_BROKER_CLICKHOUSE_HOST;
			} else {
				process.env.CEX_BROKER_CLICKHOUSE_HOST = originalClickhouseHost;
			}
		}
	});
});
