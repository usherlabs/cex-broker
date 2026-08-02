import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { BrokerExecutionArchiver } from "../src/helpers/broker-execution-archive";
import { Action } from "../src/helpers/constants";
import { log } from "../src/helpers/logger";
import {
	buildOrderExecutionTelemetry,
	extractOrderTelemetryIds,
} from "../src/helpers/order-telemetry";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";
import { startForwarderServer } from "./archive-forwarder-server";
import {
	bindServer,
	CapturingOtelMetrics,
	createBinancePool,
	createOrderExchangeFixture,
	executeAction,
	grpcObj,
} from "./order-telemetry-fixtures";

const archiveTestDirectory = mkdtempSync(
	join(tmpdir(), "cex-broker-order-archive-test-"),
);

afterAll(() => {
	rmSync(archiveTestDirectory, { recursive: true, force: true });
});

class ExchangeOrderRejected extends Error {
	readonly code = -2010;
}

const testPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: {
		rule: {
			markets: ["BINANCE:ARB/USDT"],
			limits: [{ from: "ARB", to: "USDT", min: 1, max: 100000 }],
		},
	},
};

function createClient(port: number) {
	return new grpcObj.cex_broker.cex_service(
		`127.0.0.1:${port}`,
		grpc.credentials.createInsecure(),
	);
}

function findHistogram(metrics: CapturingOtelMetrics, name: string) {
	return metrics.histograms.find((metric) => metric.name === name);
}

describe("order execution telemetry normalization", () => {
	test("extracts accounting fields from CCXT and Binance fee shapes", () => {
		const telemetry = buildOrderExecutionTelemetry(
			{
				action: "CreateOrder",
				cex: "BINANCE",
				accountLabel: "primary",
				requestedQuantity: 10,
				requestedNotional: 24,
				brokerObservedTimestamp: "2026-05-14T00:00:00.000Z",
				...extractOrderTelemetryIds({
					newClientOrderId: "maker-hedge-1",
					idempotencyKey: "idem-1",
					action_id: "maker-action-1",
				}),
			},
			{
				id: "123",
				symbol: "ARB/USDT",
				side: "sell",
				type: "market",
				status: "closed",
				amount: 10,
				filled: 10,
				remaining: 0,
				cost: 24.2,
				average: 2.42,
				timestamp: 1778716800000,
				info: {
					fills: [
						{ commission: "0.01", commissionAsset: "ARB" },
						{ commission: "0.02", commissionAsset: "ARB" },
					],
				},
			},
		);

		expect(telemetry).toMatchObject({
			event: "cex_market_action_execution",
			action: "CreateOrder",
			cex: "binance",
			accountLabel: "primary",
			symbol: "ARB/USDT",
			side: "sell",
			orderType: "market",
			orderId: "123",
			clientOrderId: "maker-hedge-1",
			idempotencyId: "idem-1",
			makerActionId: "maker-action-1",
			status: "closed",
			requestedQuantity: 10,
			requestedNotional: 24,
			executedBaseQuantity: 10,
			executedQuoteQuantity: 24.2,
			averageExecutionPrice: 2.42,
			filledAmount: 10,
			remainingAmount: 0,
			feeAmount: 0.03,
			feeCurrency: "ARB",
			exchangeTimestamp: "2026-05-14T00:00:00.000Z",
			brokerObservedTimestamp: "2026-05-14T00:00:00.000Z",
		});
	});

	test("redacts upstream error messages from telemetry payloads", () => {
		const telemetry = buildOrderExecutionTelemetry(
			{
				action: "CreateOrder",
				cex: "binance",
				accountLabel: "primary",
				symbol: "ARB/USDT",
				side: "sell",
				orderType: "market",
				brokerObservedTimestamp: "2026-05-14T00:00:00.000Z",
			},
			undefined,
			new Error("exchange rejected order because account abc123 is restricted"),
		);

		expect(telemetry).toMatchObject({
			status: "failed",
			errorType: "Error",
			errorMessage: "redacted_error",
		});
		expect(JSON.stringify(telemetry)).not.toContain("account abc123");
	});
});

describe("order execution telemetry RPC harness", () => {
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	afterEach(async () => {
		client?.close();
		if (server) {
			await server.forceShutdown();
		}
	});

	test("emits create-order price and fee metrics without changing response", async () => {
		const metrics = new CapturingOtelMetrics();
		const { exchange } = createOrderExchangeFixture({
			createOrderResult: {
				id: "order-1",
				clientOrderId: "client-1",
				symbol: "ARB/USDT",
				side: "sell",
				type: "market",
				status: "closed",
				amount: 10,
				filled: 10,
				remaining: 0,
				cost: 21,
				average: 2.1,
				fee: { cost: 0.1, currency: "USDT", rate: 0.001 },
				timestamp: 1778716800000,
			},
		});
		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
		);
		client = createClient(await bindServer(server));

		const response = await executeAction(client, {
			action: Action.CreateOrder,
			cex: "binance",
			payload: {
				orderType: "market",
				amount: "10",
				fromToken: "ARB",
				toToken: "USDT",
				price: "2.1",
				params: JSON.stringify({
					newClientOrderId: "client-1",
					idempotencyKey: "idem-1",
					actionId: "maker-action-1",
				}),
			},
		});

		expect(JSON.parse(response.result)).toMatchObject({
			id: "order-1",
			clientOrderId: "client-1",
			fee: { cost: 0.1, currency: "USDT", rate: 0.001 },
		});
		expect(
			findHistogram(metrics, "cex_market_action_average_execution_price"),
		)?.toMatchObject({
			value: 2.1,
			labels: {
				action: "CreateOrder",
				cex: "binance",
				account: "primary",
				symbol: "ARB/USDT",
				side: "sell",
				order_type: "market",
				status: "closed",
			},
		});
		expect(findHistogram(metrics, "cex_market_action_fee_amount")?.value).toBe(
			0.1,
		);
		expect(
			findHistogram(metrics, "cex_market_action_requested_notional")?.value,
		).toBe(21);
	});

	test("forwards and archives a top-level create-order client id", async () => {
		const metrics = new CapturingOtelMetrics();
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deadLetterPath: join(archiveTestDirectory, "client-order-id-loss.jsonl"),
			deploymentId: "order-test",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		const { exchange, calls } = createOrderExchangeFixture({
			createOrderResult: {
				id: "order-with-client-id",
				symbol: "ARB/USDT",
				side: "sell",
				type: "limit",
				status: "open",
				amount: 10,
				filled: 0,
				remaining: 10,
			},
			fetchOrderBookResult: {
				bids: [[2.09, 100]],
				asks: [[2.1, 100]],
				timestamp: 1_788_000_000_000,
			},
		});
		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
			archiver,
		);
		try {
			client = createClient(await bindServer(server));

			await executeAction(client, {
				action: Action.CreateOrder,
				cex: "binance",
				payload: {
					orderType: "limit",
					amount: "10",
					fromToken: "ARB",
					toToken: "USDT",
					price: "2.1",
					clientOrderId: "caller-order-1",
					params: JSON.stringify({
						clientOrderId: "params-order-id",
						idempotencyKey: "idem-1",
					}),
				},
			});

			expect(calls.createOrder).toHaveLength(1);
			expect(calls.createOrder[0]?.[5]).toEqual({
				clientOrderId: "caller-order-1",
				idempotencyKey: "idem-1",
			});

			await Promise.resolve();
			await archiver.flush();
			const archivedRows = forwarder.requests.flatMap(
				(request) => request.body.rows ?? [],
			) as Array<{ table?: string; row: Record<string, unknown> }>;
			const archivedOrder = archivedRows.find(
				(entry) => entry.table === "broker_execution.order_events",
			);
			const archivedMarketSnapshot = archivedRows.find(
				(entry) => entry.table === "broker_execution.market_metadata_snapshots",
			);

			expect(archivedOrder?.row.client_order_id).toBe("caller-order-1");
			expect(JSON.parse(String(archivedOrder?.row.payload_json))).toMatchObject(
				{ clientOrderId: "caller-order-1" },
			);
			expect(archivedMarketSnapshot?.row.client_order_id).toBe(
				"caller-order-1",
			);
		} finally {
			await archiver.close();
			await forwarder.close();
		}
	});

	test("archives Call createOrder with its client id and market snapshot", async () => {
		const metrics = new CapturingOtelMetrics();
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deadLetterPath: join(
				archiveTestDirectory,
				"call-create-order-loss.jsonl",
			),
			deploymentId: "order-test",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		const order = {
			id: "passthrough-order-1",
			symbol: "ARB/USDT",
			side: "buy",
			type: "limit",
			status: "open",
			amount: 10,
			filled: 0,
			remaining: 10,
		};
		const { exchange, calls } = createOrderExchangeFixture({
			createOrderResult: order,
			fetchOrderBookResult: {
				bids: [[2.09, 100]],
				asks: [[2.1, 100]],
				timestamp: 1_788_000_000_000,
			},
		});
		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
			archiver,
		);
		try {
			client = createClient(await bindServer(server));

			const response = await executeAction(client, {
				action: Action.Call,
				cex: "binance",
				payload: {
					functionName: "createOrder",
					args: JSON.stringify(["ARB/USDT", "limit", "buy", 10, 2.1]),
					params: JSON.stringify({
						postOnly: true,
						clientOrderId: "FIET-call-order-1",
					}),
				},
			});

			expect(JSON.parse(response.result)).toEqual(order);
			expect(calls.createOrder).toEqual([
				[
					"ARB/USDT",
					"limit",
					"buy",
					10,
					2.1,
					{ postOnly: true, clientOrderId: "FIET-call-order-1" },
				],
			]);
			expect(calls.fetchOrderBook).toEqual([["ARB/USDT", 5]]);

			await Promise.resolve();
			await archiver.flush();
			const archivedRows = forwarder.requests.flatMap(
				(request) => request.body.rows ?? [],
			) as Array<{ table?: string; row: Record<string, unknown> }>;
			const archivedOrder = archivedRows.find(
				(entry) => entry.table === "broker_execution.order_events",
			);
			const archivedMarketSnapshot = archivedRows.find(
				(entry) => entry.table === "broker_execution.market_metadata_snapshots",
			);

			expect(archivedOrder?.row).toMatchObject({
				action: "CreateOrder",
				client_order_id: "FIET-call-order-1",
				symbol: "ARB/USDT",
				side: "buy",
				order_type: "limit",
				requested_quantity: 10,
				requested_notional: 21,
				status: "open",
			});
			expect(archivedMarketSnapshot?.row).toMatchObject({
				client_order_id: "FIET-call-order-1",
				symbol: "ARB/USDT",
			});
			expect(archivedOrder?.row.market_metadata_hash).toBe(
				archivedMarketSnapshot?.row.market_metadata_hash,
			);
			expect(metrics.counters).toContainEqual(
				expect.objectContaining({
					name: "cex_market_action_executions_total",
					labels: expect.objectContaining({
						action: "CreateOrder",
						status: "open",
					}),
				}),
			);
		} finally {
			await archiver.close();
			await forwarder.close();
		}
	});

	test("archives a failed Call createOrder before preserving the RPC error", async () => {
		const metrics = new CapturingOtelMetrics();
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deadLetterPath: join(
				archiveTestDirectory,
				"failed-call-create-order-loss.jsonl",
			),
			deploymentId: "order-test",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		const errorLog = spyOn(log, "error").mockImplementation(() => {});
		const { exchange, calls } = createOrderExchangeFixture({
			createOrderError: new ExchangeOrderRejected(
				"post-only order would cross the book",
			),
			fetchOrderBookResult: {
				bids: [[2.09, 100]],
				asks: [[2.1, 100]],
			},
		});
		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
			archiver,
		);
		try {
			client = createClient(await bindServer(server));

			await expect(
				executeAction(client, {
					action: Action.Call,
					cex: "binance",
					payload: {
						functionName: "createOrder",
						args: JSON.stringify(["ARB/USDT", "limit", "sell", 10, 2.1]),
						params: JSON.stringify({
							postOnly: true,
							clientOrderId: "FIET-rejected-order-1",
						}),
					},
				}),
			).rejects.toMatchObject({
				code: grpc.status.INTERNAL,
				details: expect.stringContaining(
					"post-only order would cross the book",
				),
			});
			expect(calls.createOrder).toHaveLength(1);

			await Promise.resolve();
			await archiver.flush();
			const archivedRows = forwarder.requests.flatMap(
				(request) => request.body.rows ?? [],
			) as Array<{ table?: string; row: Record<string, unknown> }>;
			const archivedOrder = archivedRows.find(
				(entry) => entry.table === "broker_execution.order_events",
			);
			const archivedMarketSnapshot = archivedRows.find(
				(entry) => entry.table === "broker_execution.market_metadata_snapshots",
			);
			expect(archivedOrder?.row).toMatchObject({
				action: "CreateOrder",
				client_order_id: "FIET-rejected-order-1",
				status: "failed",
				symbol: "ARB/USDT",
				side: "sell",
				order_type: "limit",
				requested_quantity: 10,
				requested_notional: 21,
			});
			expect(archivedMarketSnapshot?.row).toMatchObject({
				client_order_id: "FIET-rejected-order-1",
				symbol: "ARB/USDT",
			});
			expect(archivedOrder?.row.market_metadata_hash).toBe(
				archivedMarketSnapshot?.row.market_metadata_hash,
			);
			expect(metrics.counters).toContainEqual(
				expect.objectContaining({
					name: "cex_market_action_executions_total",
					labels: expect.objectContaining({
						action: "CreateOrder",
						status: "failed",
					}),
				}),
			);
		} finally {
			errorLog.mockRestore();
			await archiver.close();
			await forwarder.close();
		}
	});

	test("does not emit order observability for other Call functions", async () => {
		const metrics = new CapturingOtelMetrics();
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deadLetterPath: join(archiveTestDirectory, "non-create-call-loss.jsonl"),
			deploymentId: "order-test",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		const order = { id: "lookup-order-1", status: "open" };
		const { exchange, calls } = createOrderExchangeFixture({
			fetchOrderResult: order,
		});
		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
			archiver,
		);
		try {
			client = createClient(await bindServer(server));

			const response = await executeAction(client, {
				action: Action.Call,
				cex: "binance",
				payload: {
					functionName: "fetchOrder",
					args: JSON.stringify(["lookup-order-1", "ARB/USDT"]),
					params: "{}",
				},
			});

			expect(JSON.parse(response.result)).toEqual(order);
			expect(calls.fetchOrder).toEqual([["lookup-order-1", "ARB/USDT"]]);
			await Promise.resolve();
			await archiver.flush();
			expect(forwarder.requests).toHaveLength(0);
			expect(
				metrics.counters.filter((metric) =>
					metric.name.startsWith("cex_market_action_"),
				),
			).toHaveLength(0);
			expect(
				metrics.histograms.filter((metric) =>
					metric.name.startsWith("cex_market_action_"),
				),
			).toHaveLength(0);
		} finally {
			await archiver.close();
			await forwarder.close();
		}
	});

	test("handles create-order success without fee fields", async () => {
		const metrics = new CapturingOtelMetrics();
		const { exchange } = createOrderExchangeFixture({
			createOrderResult: {
				id: "order-no-fee",
				symbol: "ARB/USDT",
				side: "sell",
				type: "limit",
				status: "closed",
				amount: 5,
				filled: 5,
				remaining: 0,
				cost: 11,
			},
		});
		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
		);
		client = createClient(await bindServer(server));

		const response = await executeAction(client, {
			action: Action.CreateOrder,
			cex: "binance",
			payload: {
				orderType: "limit",
				amount: "5",
				fromToken: "ARB",
				toToken: "USDT",
				price: "2.2",
			},
		});

		expect(JSON.parse(response.result)).toMatchObject({ id: "order-no-fee" });
		expect(
			findHistogram(metrics, "cex_market_action_fee_amount"),
		).toBeUndefined();
		expect(
			findHistogram(metrics, "cex_market_action_executed_quote_quantity")
				?.value,
		).toBe(11);
	});

	test("emits partial fill telemetry from order-detail verification", async () => {
		const metrics = new CapturingOtelMetrics();
		const { exchange } = createOrderExchangeFixture({
			fetchOrderResult: {
				id: "partial-1",
				symbol: "ARB/USDT",
				side: "buy",
				type: "limit",
				status: "open",
				amount: 10,
				filled: 4,
				remaining: 6,
				cost: 8.4,
				average: 2.1,
			},
		});
		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
		);
		client = createClient(await bindServer(server));

		const response = await executeAction(client, {
			action: Action.GetOrderDetails,
			cex: "binance",
			symbol: "ARB/USDT",
			payload: { orderId: "partial-1" },
		});

		expect(JSON.parse(response.result)).toMatchObject({
			orderId: "partial-1",
			status: "open",
			filled: 4,
			remaining: 6,
		});
		expect(
			findHistogram(metrics, "cex_market_action_filled_amount")?.value,
		).toBe(4);
		expect(
			findHistogram(metrics, "cex_market_action_remaining_amount")?.value,
		).toBe(6);
	});

	test("emits rejected order telemetry without converting it to an RPC error", async () => {
		const metrics = new CapturingOtelMetrics();
		const { exchange } = createOrderExchangeFixture({
			createOrderResult: {
				id: "rejected-1",
				symbol: "ARB/USDT",
				side: "sell",
				type: "market",
				status: "rejected",
				amount: 10,
				filled: 0,
				remaining: 10,
			},
		});
		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
		);
		client = createClient(await bindServer(server));

		const response = await executeAction(client, {
			action: Action.CreateOrder,
			cex: "binance",
			payload: {
				orderType: "market",
				amount: "10",
				fromToken: "ARB",
				toToken: "USDT",
				price: "2",
			},
		});

		expect(JSON.parse(response.result)).toMatchObject({
			id: "rejected-1",
			status: "rejected",
		});
		expect(metrics.counters).toContainEqual(
			expect.objectContaining({
				name: "cex_market_action_executions_total",
				labels: expect.objectContaining({ status: "rejected", result: "ok" }),
			}),
		);
	});

	test("emits failed order telemetry while preserving RPC error behavior", async () => {
		const metrics = new CapturingOtelMetrics();
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deadLetterPath: join(archiveTestDirectory, "failed-order-loss.jsonl"),
			deploymentId: "order-test",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		const exchangeMessage = `exchange rejected order\n${"x".repeat(700)}`;
		const errorLog = spyOn(log, "error").mockImplementation(() => {});
		const { exchange } = createOrderExchangeFixture({
			createOrderError: new ExchangeOrderRejected(exchangeMessage),
			fetchOrderBookResult: {
				bids: [[1.99, 100]],
				asks: [[2.0, 100]],
			},
		});
		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
			archiver,
		);
		try {
			client = createClient(await bindServer(server));

			await expect(
				executeAction(client, {
					action: Action.CreateOrder,
					cex: "binance",
					payload: {
						orderType: "market",
						amount: "10",
						fromToken: "ARB",
						toToken: "USDT",
						price: "2",
						clientOrderId: "failed-client-order-1",
					},
				}),
			).rejects.toMatchObject({
				code: grpc.status.INTERNAL,
				details: expect.stringContaining(
					"ExchangeOrderRejected: exchange rejected order",
				),
			});
			expect(metrics.counters).toContainEqual(
				expect.objectContaining({
					name: "cex_market_action_executions_total",
					labels: expect.objectContaining({
						status: "failed",
						result: "error",
					}),
				}),
			);

			await Promise.resolve();
			await archiver.flush();
			const archivedRows = forwarder.requests.flatMap(
				(request) => request.body.rows ?? [],
			) as Array<{ table?: string; row: Record<string, unknown> }>;
			const archivedOrder = archivedRows.find(
				(entry) => entry.table === "broker_execution.order_events",
			);
			const archivedMarketSnapshot = archivedRows.find(
				(entry) => entry.table === "broker_execution.market_metadata_snapshots",
			);
			expect(archivedOrder?.row.status).toBe("failed");
			expect(archivedOrder?.row.client_order_id).toBe("failed-client-order-1");
			expect(archivedMarketSnapshot?.row.client_order_id).toBe(
				"failed-client-order-1",
			);
			expect(archivedOrder?.row.market_metadata_hash).toBe(
				archivedMarketSnapshot?.row.market_metadata_hash,
			);
			expect(archivedOrder?.row.error_message).toContain(
				"ExchangeOrderRejected [code=-2010]: exchange rejected order",
			);
			expect(String(archivedOrder?.row.error_message)).not.toContain("\n");
			expect(String(archivedOrder?.row.error_message)).toHaveLength(512);
			const telemetryPayload = JSON.parse(
				String(archivedOrder?.row.payload_json),
			) as Record<string, unknown>;
			expect(telemetryPayload).toMatchObject({
				status: "failed",
				errorMessage: "redacted_error",
			});
			expect(JSON.stringify(telemetryPayload)).not.toContain(
				"exchange rejected order",
			);
			expect(JSON.stringify(errorLog.mock.calls)).toContain("redacted_error");
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
				"exchange rejected order",
			);
		} finally {
			errorLog.mockRestore();
			await archiver.close();
			await forwarder.close();
		}
	});
});
