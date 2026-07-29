import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import ccxt, { type Exchange } from "@usherlabs/ccxt";
import type { ExecuteActionContext } from "../src/handlers/execute-action/context";
import { handleOrders } from "../src/handlers/execute-action/orders";
import { Action } from "../src/helpers/constants";
import type { PolicyConfig } from "../src/types";

type CallbackError = { code?: number; message?: string };
type CallbackResponse = { result?: string };

function createFixture(createOrderResult: unknown = { id: "order-1" }) {
	const createOrderCalls: unknown[][] = [];
	const broker = {
		loadMarkets: async () => {},
		markets: {
			"USDC/USDT": {
				symbol: "USDC/USDT",
				base: "USDC",
				quote: "USDT",
				spot: true,
				type: "spot",
			},
		},
		createOrder: async (...args: unknown[]) => {
			createOrderCalls.push(args);
			if (createOrderResult instanceof Error) {
				throw createOrderResult;
			}
			return createOrderResult;
		},
	} as unknown as Exchange;

	let callbackError: CallbackError | null = null;
	let callbackResponse: CallbackResponse | null = null;
	const ctx = {
		action: Action.CreateOrder,
		call: { request: { payload: {} } },
		wrappedCallback: (
			error: CallbackError | null,
			response: CallbackResponse | null,
		) => {
			callbackError = error;
			callbackResponse = response;
		},
		cex: "binance",
		normalizedCex: "binance",
		symbol: "USDC/USDT",
		broker,
		verity: { proof: "" },
		policy: {
			order: { rule: { markets: ["*"], limits: [] } },
		} as unknown as PolicyConfig,
		brokers: {},
	} as unknown as ExecuteActionContext;

	return {
		ctx,
		createOrderCalls,
		getError: () => callbackError,
		getResponse: () => callbackResponse,
	};
}

function createOrderPayload(
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		orderType: "limit",
		amount: "10",
		fromToken: "USDC",
		toToken: "USDT",
		price: "1",
		marketType: "spot",
		...overrides,
	};
}

describe("passive CreateOrder", () => {
	test("keeps the existing ccxt request and response byte-for-byte when intent is absent", async () => {
		const order = { id: "ordinary-1", status: "open" };
		const fixture = createFixture(order);
		fixture.ctx.call.request.payload = createOrderPayload({
			clientOrderId: "client-1",
			params: JSON.stringify({ timeInForce: "IOC", strategyId: 7 }),
		});

		await handleOrders(fixture.ctx);

		expect(fixture.createOrderCalls).toEqual([
			[
				"USDC/USDT",
				"limit",
				"sell",
				10,
				1,
				{
					timeInForce: "IOC",
					strategyId: 7,
					clientOrderId: "client-1",
				},
			],
		]);
		expect(fixture.getError()).toBeNull();
		expect(fixture.getResponse()?.result).toBe(JSON.stringify(order));
	});

	test("adds postOnly without clobbering params and reports accepted passive placement", async () => {
		const order = { id: "passive-1", status: "open" };
		const fixture = createFixture(order);
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
			params: JSON.stringify({ timeInForce: "GTC", strategyId: 9 }),
		});

		await handleOrders(fixture.ctx);

		expect(fixture.createOrderCalls[0]?.[5]).toEqual({
			timeInForce: "GTC",
			strategyId: 9,
			postOnly: true,
		});
		expect(JSON.parse(fixture.getResponse()?.result ?? "{}")).toEqual({
			...order,
			passivePlacementOutcome: "accepted_passive",
		});
	});

	test("overrides a conflicting caller postOnly value to preserve passive intent", async () => {
		const fixture = createFixture();
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
			params: JSON.stringify({ postOnly: 0, strategyId: 9 }),
		});

		await handleOrders(fixture.ctx);

		expect(fixture.createOrderCalls[0]?.[5]).toEqual({
			postOnly: true,
			strategyId: 9,
		});
	});

	test("rejects passive market orders as invalid before calling ccxt", async () => {
		const fixture = createFixture();
		fixture.ctx.call.request.payload = createOrderPayload({
			orderType: "market",
			orderIntent: "passive_only",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.createOrderCalls).toHaveLength(0);
		expect(fixture.getError()).toEqual({
			code: grpc.status.INVALID_ARGUMENT,
			message:
				"ValidationError: passive_only order intent requires a limit order",
		});
	});

	test("rejects unknown order intents in the payload schema", async () => {
		const fixture = createFixture();
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "maker_if_possible",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.createOrderCalls).toHaveLength(0);
		expect(fixture.getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(fixture.getError()?.message).toContain("orderIntent");
	});

	test("maps an immediately fillable venue rejection to would-cross", async () => {
		const fixture = createFixture(
			new ccxt.InvalidOrder("binance Order would immediately match and take."),
		);
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.getError()?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(fixture.getError()?.message).toStartWith(
			"passive_order_would_cross:",
		);
	});

	test("maps missing ccxt post-only support to unsupported", async () => {
		const fixture = createFixture(
			new ccxt.NotSupported("binance post-only orders are not supported"),
		);
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.getError()?.code).toBe(grpc.status.UNIMPLEMENTED);
		expect(fixture.getError()?.message).toStartWith(
			"passive_order_unsupported:",
		);
	});

	test("maps any other passive venue rejection to rejected", async () => {
		const fixture = createFixture(
			new ccxt.InvalidOrder("binance passive order rejected: invalid price"),
		);
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.getError()?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(fixture.getError()?.message).toStartWith("passive_order_rejected:");
	});
});
