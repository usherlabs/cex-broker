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
	test.each([
		["sell", "USDC", "USDT"],
		["buy", "USDT", "USDC"],
	])("uses exact amountBase and price verbatim on %s", async (side, fromToken, toToken) => {
		const fixture = createFixture();
		fixture.ctx.call.request.payload = createOrderPayload({
			fromToken,
			toToken,
			amount: "999",
			amountBase: "1.000000000000000001",
			price: "2.000000000000000003",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.getError()).toBeNull();
		expect(fixture.createOrderCalls).toEqual([
			[
				"USDC/USDT",
				"limit",
				side,
				"1.000000000000000001",
				"2.000000000000000003",
				{},
			],
		]);
	});

	test("keeps legacy buy quote-to-base division when amountBase is absent", async () => {
		const fixture = createFixture();
		fixture.ctx.call.request.payload = createOrderPayload({
			fromToken: "USDT",
			toToken: "USDC",
			amount: "10",
			price: "2",
		});
		await handleOrders(fixture.ctx);
		expect(fixture.createOrderCalls).toEqual([
			["USDC/USDT", "limit", "buy", 5, 2, {}],
		]);
	});

	test.each([
		"",
		"0",
		"0.000",
		"-1",
		"+1",
		"1e-3",
		"NaN",
		"Infinity",
		"0x10",
		" 1",
		"1 ",
		"1.",
		".1",
		"1.2.3",
		"1\n",
	])("refuses invalid amountBase %j without submitting", async (amountBase) => {
		const fixture = createFixture();
		fixture.ctx.call.request.payload = createOrderPayload({ amountBase });
		await handleOrders(fixture.ctx);
		expect(fixture.getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(fixture.createOrderCalls).toEqual([]);
	});

	test.each([
		"",
		"0",
		"-1",
		"1e-3",
		"NaN",
		"Infinity",
		" 1",
		"1.2.3",
	])("refuses invalid exact price %j without submitting", async (price) => {
		const fixture = createFixture();
		fixture.ctx.call.request.payload = createOrderPayload({
			amountBase: "1",
			price,
		});
		await handleOrders(fixture.ctx);
		expect(fixture.getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(fixture.createOrderCalls).toEqual([]);
	});

	test.each([
		["sell", "USDC", "USDT", "1.000000000000000001", "2", 0, 1, false],
		["sell", "USDC", "USDT", "0.999999999999999999", "2", 1, 2, false],
		["sell", "USDC", "USDT", "1.000000000000000000", "2", 1, 1, true],
		["buy", "USDT", "USDC", "0.500000000000000001", "2", 0, 1, false],
		["buy", "USDT", "USDC", "0.499999999999999999", "2", 1, 2, false],
		["buy", "USDT", "USDC", "0.500000000000000000", "2", 1, 1, true],
		["buy", "USDT", "USDC", "0.00000001", "1", 1e-8, 1e-8, true],
	])("checks exact fromToken limits on %s (%s → %s, base %s)", async (_, fromToken, toToken, amountBase, price, min, max, allowed) => {
		const fixture = createFixture();
		fixture.ctx.policy.order.rule.limits = [
			{ from: fromToken, to: toToken, min, max },
		];
		fixture.ctx.call.request.payload = createOrderPayload({
			fromToken,
			toToken,
			amountBase,
			price,
			amount: allowed ? "999" : min === 0 ? "0.5" : "1.5",
		});
		await handleOrders(fixture.ctx);
		expect(fixture.createOrderCalls).toHaveLength(allowed ? 1 : 0);
		expect(fixture.getError()?.code ?? null).toBe(
			allowed ? null : grpc.status.INVALID_ARGUMENT,
		);
	});

	test("amountBase does not bypass market or direction allow-lists", async () => {
		for (const rule of [
			{ markets: ["binance:BTC/USDT"], limits: [] },
			{
				markets: ["*"],
				limits: [{ from: "USDT", to: "USDC", min: 0, max: 100 }],
			},
		]) {
			const fixture = createFixture();
			fixture.ctx.policy.order.rule = rule;
			fixture.ctx.call.request.payload = createOrderPayload({
				amountBase: "1",
			});
			await handleOrders(fixture.ctx);
			expect(fixture.getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
			expect(fixture.createOrderCalls).toEqual([]);
		}
	});

	test.each([
		[
			"post-only rejection",
			new ccxt.InvalidOrder("Post-only order rejected"),
			"passive_order_rejected",
		],
		[
			"would-cross refusal",
			new ccxt.OrderImmediatelyFillable("order would cross"),
			"passive_order_would_cross",
		],
		[
			"immediate execution refusal",
			new ccxt.InvalidOrder("Post only order would immediately execute"),
			"passive_order_would_cross",
		],
		[
			"timeout",
			new ccxt.RequestTimeout("request timed out"),
			"passive_order_unknown",
		],
		[
			"network loss",
			new ccxt.NetworkError("connection reset"),
			"passive_order_unknown",
		],
		[
			"network message mentions post-only",
			new ccxt.NetworkError("post-only rejected response could not be read"),
			"passive_order_unknown",
		],
		[
			"negated post-only rejection",
			new Error("Post-only order was not rejected"),
			"passive_order_unknown",
		],
		[
			"unknown invalid order",
			new ccxt.InvalidOrder("invalid price"),
			"passive_order_unknown",
		],
		[
			"unknown error",
			new Error("unexpected response"),
			"passive_order_unknown",
		],
		[
			"ambiguous post-only timeout",
			new Error("post-only order timed out"),
			"passive_order_unknown",
		],
	])("classifies %s without claiming a lost submission was rejected", async (_, error, expected) => {
		const fixture = createFixture(error);
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
		});
		await handleOrders(fixture.ctx);
		expect(fixture.createOrderCalls).toHaveLength(1);
		expect(fixture.getResponse()).toBeNull();
		expect(fixture.getError()?.message).toStartWith(`${expected}:`);
	});

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

	test("preserves insufficient funds as the stable error code", async () => {
		const fixture = createFixture(
			new ccxt.InsufficientFunds("binance account has insufficient balance"),
		);
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.getError()?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(fixture.getError()?.message).toStartWith("InsufficientFunds:");
		expect(fixture.getError()?.message).not.toStartWith("passive_");
	});

	test.each([
		[
			"authentication failure",
			new ccxt.AuthenticationError("binance invalid api key"),
		],
		[
			"permission failure",
			new ccxt.PermissionDenied("binance key cannot create orders"),
		],
	])("preserves %s as the authentication stable error code", async (_, error) => {
		const fixture = createFixture(error);
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.getError()?.code).toBe(grpc.status.UNAUTHENTICATED);
		expect(fixture.getError()?.message).toStartWith("AuthenticationError:");
		expect(fixture.getError()?.message).not.toStartWith("passive_");
	});

	test("maps an explicit post-only venue rejection to rejected", async () => {
		const fixture = createFixture(
			new ccxt.InvalidOrder("binance post-only order rejected: invalid price"),
		);
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.getError()?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(fixture.getError()?.message).toStartWith("passive_order_rejected:");
	});

	test("does not classify a pre-submission failure as a passive venue rejection", async () => {
		const fixture = createFixture();
		(
			fixture.ctx.broker as unknown as { loadMarkets: () => Promise<void> }
		).loadMarkets = async () => {
			throw new Error("market resolution unavailable");
		};
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
		});

		await handleOrders(fixture.ctx);

		expect(fixture.createOrderCalls).toHaveLength(0);
		expect(fixture.getError()?.message).not.toStartWith("passive_order_");
	});

	test("does not classify a post-submission failure as a passive venue rejection", async () => {
		const circularOrder: Record<string, unknown> = { id: "order-1" };
		circularOrder.self = circularOrder;
		const fixture = createFixture(circularOrder);
		fixture.ctx.call.request.payload = createOrderPayload({
			orderIntent: "passive_only",
		});

		await handleOrders(fixture.ctx);

		// The order is resting on the venue; a passive code would tell the client
		// it was never placed and invite a duplicate repost.
		expect(fixture.createOrderCalls).toHaveLength(1);
		expect(fixture.getError()?.code).toBe(grpc.status.INTERNAL);
		expect(fixture.getError()?.message).not.toStartWith("passive_order_");
	});
});
