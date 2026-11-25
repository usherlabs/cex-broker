import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import ccxt from "ccxt";
import { handleOrders } from "../src/handlers/execute-action/orders";
import {
	CLIENT_ORDER_ID_FETCH_ORDER_EXCHANGES,
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

// CCXT's fetchOrder reads the unified param in one of these shapes:
// safeString(params, 'clientOrderId'), safeString2(params, 'x', 'clientOrderId')
// or safeStringN(params, ['x', 'clientOrderId']). Bundled sources use either
// quote style.
const READS_CLIENT_ORDER_ID =
	/safe\w*\(\s*\w+,\s*(\[[^\]]*["']clientOrderId["'][^\]]*\]|["']clientOrderId["']|["'][^"']*["'],\s*["']clientOrderId["'])/;

function fetchOrderSource(id: string): string {
	const ExchangeClass = (ccxt as unknown as Record<string, unknown>)[id] as
		| { prototype: Record<string, unknown> }
		| undefined;
	if (!ExchangeClass) {
		return "";
	}
	const proto = ExchangeClass.prototype;
	const source = (name: string) =>
		typeof proto[name] === "function" ? String(proto[name]) : "";
	let body = source("fetchOrder");
	for (const [, delegate] of body.matchAll(/this\.(fetch\w*Order)\(/g)) {
		if (delegate && delegate !== "fetchOrder") {
			body += source(delegate);
		}
	}
	return body;
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
			code: grpc.status.UNIMPLEMENTED,
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

	test("every listed exchange's installed CCXT fetchOrder reads clientOrderId", () => {
		const unmapped = [...CLIENT_ORDER_ID_FETCH_ORDER_EXCHANGES].filter(
			(id) => !READS_CLIENT_ORDER_ID.test(fetchOrderSource(id)),
		);
		expect(unmapped).toEqual([]);
	});
});
