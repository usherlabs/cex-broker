import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { handleOrders } from "../src/handlers/execute-action/orders";
import { Action } from "../src/helpers/constants";
import { stableGrpcErrorCode } from "../src/helpers/grpc/status";
import {
	buildCreateOrderParams,
	checkTimeInForceRequest,
	resolveTimeInForceSupport,
} from "../src/helpers/order-time-in-force";
import { CreateOrderPayloadSchema } from "../src/schemas/action-payloads";
import {
	BTC_USDT_SWAP_MARKET,
	createActionContext,
	createOfflineExchange,
	testPolicy,
} from "./order-bounds-fixtures";

function limitSell(overrides: Record<string, string> = {}) {
	return {
		orderType: "limit",
		fromToken: "BTC",
		toToken: "USDT",
		amount: "0.01",
		price: "30000",
		...overrides,
	};
}

async function createOrder(
	payload: Record<string, string>,
	exchange = createOfflineExchange(),
) {
	const fixture = createActionContext(Action.CreateOrder, exchange.broker, {
		payload,
		symbol: "BTC/USDT",
	});
	await handleOrders(fixture.ctx);
	return { ...fixture, calls: exchange.calls };
}

describe("CreateOrder timeInForce", () => {
	test.each([
		"GTC",
		"IOC",
		"FOK",
	] as const)("passes %s through CCXT's unified timeInForce param", async (timeInForce) => {
		const { getError, calls } = await createOrder(limitSell({ timeInForce }));
		expect(getError()).toBeNull();
		expect(calls.createOrder).toEqual([
			["BTC/USDT", "limit", "sell", 0.01, 30000, { timeInForce }],
		]);
	});

	test("normalises a lower-case value", async () => {
		const { getError, calls } = await createOrder(
			limitSell({ timeInForce: " ioc " }),
		);
		expect(getError()).toBeNull();
		expect(calls.createOrder[0]?.[5]).toEqual({ timeInForce: "IOC" });
	});

	test("sends PO as CCXT's postOnly flag and reports a passive placement", async () => {
		const { getError, getResult, calls } = await createOrder(
			limitSell({ timeInForce: "PO", clientOrderId: "bound-1" }),
		);
		expect(getError()).toBeNull();
		expect(calls.createOrder[0]?.[5]).toEqual({
			clientOrderId: "bound-1",
			postOnly: true,
		});
		expect(getResult().passivePlacementOutcome).toBe("accepted_passive");
	});

	test("accepts PO together with the passive_only intent", async () => {
		const { getError, calls } = await createOrder(
			limitSell({ timeInForce: "PO", orderIntent: "passive_only" }),
		);
		expect(getError()).toBeNull();
		expect(calls.createOrder[0]?.[5]).toEqual({ postOnly: true });
	});

	test.each([
		[
			"a market order",
			{ orderType: "market", timeInForce: "IOC" },
			"requires a limit order",
		],
		[
			"passive_only with IOC",
			{ orderIntent: "passive_only", timeInForce: "IOC" },
			"conflicts with timeInForce IOC",
		],
		[
			"params.timeInForce",
			{ timeInForce: "IOC", params: JSON.stringify({ timeInForce: "GTC" }) },
			"params.timeInForce cannot be combined",
		],
		[
			"params.postOnly",
			{ timeInForce: "FOK", params: JSON.stringify({ postOnly: 1 }) },
			"params.postOnly cannot be combined",
		],
	])("refuses %s before resolving the market", async (_name, overrides, detail) => {
		const { getError, calls } = await createOrder(limitSell(overrides));
		expect(getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(getError()?.message).toStartWith("order_time_in_force_invalid:");
		expect(getError()?.message).toContain(detail);
		expect(calls.createOrder).toEqual([]);
	});

	test("refuses a value outside GTC, IOC, FOK and PO", async () => {
		const { getError, calls } = await createOrder(
			limitSell({ timeInForce: "GTD" }),
		);
		expect(getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(getError()?.message).toStartWith("ValidationError: timeInForce");
		expect(calls.createOrder).toEqual([]);
	});

	test("refuses a value the exchange does not advertise for the market", async () => {
		const exchange = createOfflineExchange();
		(exchange.broker as unknown as { features: unknown }).features = {
			spot: { createOrder: { timeInForce: { GTC: true, IOC: false } } },
		};
		const { getError, calls } = await createOrder(
			limitSell({ timeInForce: "IOC" }),
			exchange,
		);
		expect(getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(getError()?.message).toBe(
			"order_time_in_force_unsupported: binance does not advertise timeInForce IOC for BTC/USDT",
		);
		expect(calls.createOrder).toEqual([]);
	});

	test("refuses every value when the exchange publishes no features", async () => {
		const exchange = createOfflineExchange();
		(exchange.broker as unknown as { features: unknown }).features = undefined;
		const { getError, calls } = await createOrder(
			limitSell({ timeInForce: "GTC" }),
			exchange,
		);
		expect(getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(calls.createOrder).toEqual([]);
	});

	test("keeps legacy params.timeInForce pass-through when the field is absent", async () => {
		const { getError, calls } = await createOrder(
			limitSell({ params: JSON.stringify({ timeInForce: "IOC" }) }),
		);
		expect(getError()).toBeNull();
		expect(calls.createOrder[0]?.[5]).toEqual({ timeInForce: "IOC" });
	});
});

describe("timeInForce helpers", () => {
	const parse = (payload: Record<string, string>) =>
		CreateOrderPayloadSchema.parse(payload);

	test("builds unchanged params when no timeInForce is given", () => {
		expect(buildCreateOrderParams(parse(limitSell()))).toEqual({});
		expect(checkTimeInForceRequest(parse(limitSell()))).toBeUndefined();
	});

	test("reads linear swap features for a swap market", () => {
		const { broker } = createOfflineExchange("binance", {
			markets: [BTC_USDT_SWAP_MARKET],
		});
		expect(
			resolveTimeInForceSupport(broker, "BTC/USDT:USDT", "IOC").supported,
		).toBe(true);
		(broker as unknown as { features: unknown }).features = {
			swap: { linear: { createOrder: { timeInForce: { FOK: true } } } },
		};
		expect(
			resolveTimeInForceSupport(broker, "BTC/USDT:USDT", "FOK").supported,
		).toBe(true);
		expect(
			resolveTimeInForceSupport(broker, "BTC/USDT:USDT", "IOC").supported,
		).toBe(false);
	});

	test("maps the stable prefixes to gRPC statuses", () => {
		expect(stableGrpcErrorCode("order_time_in_force_invalid: x")).toBe(
			grpc.status.INVALID_ARGUMENT,
		);
		expect(stableGrpcErrorCode("order_time_in_force_unsupported: x")).toBe(
			grpc.status.INVALID_ARGUMENT,
		);
		expect(stableGrpcErrorCode("client_order_lookup_unsupported: x")).toBe(
			grpc.status.FAILED_PRECONDITION,
		);
	});

	test("policy still applies to an order with timeInForce", async () => {
		const exchange = createOfflineExchange();
		const fixture = createActionContext(Action.CreateOrder, exchange.broker, {
			payload: limitSell({ timeInForce: "IOC" }),
			symbol: "BTC/USDT",
			policy: testPolicy({
				order: { rule: { markets: ["BINANCE:ETH/USDT"], limits: [] } },
			}),
		});
		await handleOrders(fixture.ctx);
		expect(fixture.getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(fixture.getError()?.message).toContain("is not allowed");
		expect(exchange.calls.createOrder).toEqual([]);
	});
});
