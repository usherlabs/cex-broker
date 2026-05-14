import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { Action } from "../src/helpers/constants";
import {
	buildOrderExecutionTelemetry,
	extractOrderTelemetryIds,
} from "../src/helpers/order-telemetry";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";
import {
	bindServer,
	CapturingOtelMetrics,
	createBinancePool,
	createOrderExchangeFixture,
	executeAction,
	grpcObj,
} from "./order-telemetry-fixtures";

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
		const { exchange } = createOrderExchangeFixture({
			createOrderError: new Error("exchange rejected order"),
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
				},
			}),
		).rejects.toMatchObject({
			code: grpc.status.INTERNAL,
			details: "Order Creation failed",
		});
		expect(metrics.counters).toContainEqual(
			expect.objectContaining({
				name: "cex_market_action_executions_total",
				labels: expect.objectContaining({ status: "failed", result: "error" }),
			}),
		);
	});
});
