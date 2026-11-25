import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { handleOrders } from "../src/handlers/execute-action/orders";
import {
	fetchOrderByReference,
	supportsClientOrderLookup,
} from "../src/helpers/client-order-lookup";
import { Action } from "../src/helpers/constants";
import {
	createActionContext,
	createOfflineExchange,
} from "./order-bounds-fixtures";

async function getOrderDetails(
	payload: Record<string, string>,
	exchange = createOfflineExchange(),
) {
	const fixture = createActionContext(Action.GetOrderDetails, exchange.broker, {
		payload,
		symbol: "BTC/USDT",
	});
	await handleOrders(fixture.ctx);
	return { ...fixture, calls: exchange.calls };
}

describe("GetOrderDetails by clientOrderId", () => {
	test("looks the order up through CCXT's fetchOrderWithClientOrderId", async () => {
		const { getError, getResult, calls } = await getOrderDetails({
			clientOrderId: "client-1",
		});
		expect(getError()).toBeNull();
		// CCXT's base fetchOrderWithClientOrderId calls fetchOrder with an empty
		// id and the unified clientOrderId param; binance maps it to
		// origClientOrderId.
		expect(calls.fetchOrder).toEqual([
			["", "BTC/USDT", { clientOrderId: "client-1" }],
		]);
		expect(getResult()).toMatchObject({
			orderId: "order-1",
			clientOrderId: "client-1",
			status: "closed",
		});
	});

	test("keeps lookup by orderId unchanged", async () => {
		const { getError, calls } = await getOrderDetails({ orderId: "order-1" });
		expect(getError()).toBeNull();
		expect(calls.fetchOrder).toEqual([["order-1", "BTC/USDT", {}]]);
	});

	test("refuses an exchange without a clientOrderId mapping before calling it", async () => {
		const exchange = createOfflineExchange("gate");
		const { getError, calls } = await getOrderDetails(
			{ clientOrderId: "client-1" },
			exchange,
		);
		expect(getError()).toEqual({
			code: grpc.status.FAILED_PRECONDITION,
			message:
				"client_order_lookup_unsupported: gate does not support order lookup by clientOrderId",
		});
		expect(calls.fetchOrder).toEqual([]);
	});

	test.each([
		[{}],
		[{ orderId: "order-1", clientOrderId: "client-1" }],
	])("requires exactly one order reference: %j", async (payload) => {
		const { getError, calls } = await getOrderDetails(payload);
		expect(getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(getError()?.message).toBe(
			"ValidationError: orderId: Provide exactly one of orderId or clientOrderId",
		);
		expect(calls.fetchOrder).toEqual([]);
	});

	test("honours CCXT's own fetchOrderWithClientOrderId flag", () => {
		const { broker } = createOfflineExchange("gate");
		expect(supportsClientOrderLookup(broker)).toBe(false);
		broker.has.fetchOrderWithClientOrderId = true;
		expect(supportsClientOrderLookup(broker)).toBe(true);
	});

	test("rejects native ID aliases that could override the first-class ID", async () => {
		const { getError, calls } = await getOrderDetails({
			clientOrderId: "client-1",
			params: JSON.stringify({ origClientOrderId: "other" }),
		});
		expect(getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(calls.fetchOrder).toEqual([]);
	});

	test("refuses derivatives on a spot-only client ID route", () => {
		const { broker } = createOfflineExchange("mexc");
		expect(supportsClientOrderLookup(broker, "BTC/USDT")).toBe(true);
		expect(supportsClientOrderLookup(broker, "BTC/USDT:USDT")).toBe(false);
		expect(
			supportsClientOrderLookup(broker, "BTC/USDT", { type: "swap" }),
		).toBe(false);
	});

	test.each([
		[
			"binance",
			"privateGetOrder",
			"origClientOrderId",
			{ orderId: "native-1", symbol: "BTCUSDT" },
		],
		[
			"mexc",
			"spotPrivateGetOrder",
			"origClientOrderId",
			{ orderId: "native-1", symbol: "BTCUSDT" },
		],
		[
			"okx",
			"privateGetTradeOrder",
			"clOrdId",
			{ data: [{ ordId: "native-1", instId: "BTCUSDT" }] },
		],
	] as const)("uses the pinned CCXT %s spot endpoint with the selected ID", async (id, endpoint, nativeKey, response) => {
		const { broker } = createOfflineExchange(id);
		const nativeRequests: unknown[] = [];
		const exchange = broker as unknown as Record<string, unknown>;
		exchange.fetchOrder = Object.getPrototypeOf(broker).fetchOrder;
		exchange.fetch = () => {
			throw new Error("Native endpoint must be stubbed");
		};
		exchange[endpoint] = async (params: unknown) => {
			nativeRequests.push(params);
			return response;
		};
		await fetchOrderByReference(
			broker,
			{ clientOrderId: "selected-client-id" },
			"BTC/USDT",
			{},
		);
		expect(nativeRequests).toEqual([
			expect.objectContaining({ [nativeKey]: "selected-client-id" }),
		]);
	});
});
