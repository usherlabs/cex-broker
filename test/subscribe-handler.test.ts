import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { createSubscribeHandler } from "../src/handlers/subscribe/handler";
import type {
	SubscribeRequest,
	SubscribeResponse,
} from "../src/handlers/types";
import type { BrokerPoolEntry } from "../src/helpers/broker";
import {
	SubscriptionType,
	type SubscriptionType as SubscriptionTypeValue,
} from "../src/helpers/constants";

type MockCallState = {
	writes: SubscribeResponse[];
	endCount: number;
};

function createSubscribeCall(request: SubscribeRequest) {
	const state: MockCallState = {
		writes: [],
		endCount: 0,
	};
	const call = {
		metadata: new grpc.Metadata(),
		request,
		getPeer: () => "127.0.0.1:1234",
		write: (response: SubscribeResponse) => {
			state.writes.push(response);
			return true;
		},
		end: () => {
			state.endCount += 1;
		},
		on: () => call,
		emit: () => true,
		destroy: () => undefined,
	} as unknown as grpc.ServerWritableStream<
		SubscribeRequest,
		SubscribeResponse
	>;

	return { call, state };
}

function createPool(exchange: Exchange): Record<string, BrokerPoolEntry> {
	return {
		binance: {
			primary: { exchange, label: "primary" },
			secondaryBrokers: [],
		},
	};
}

type ThrowingSubscriptionMethod =
	| "watchOrderBook"
	| "watchTrades"
	| "watchTicker"
	| "fetchOHLCVWs"
	| "watchBalance"
	| "watchOrders";

function createThrowingExchange(
	method: ThrowingSubscriptionMethod,
	errorMessage: string,
) {
	return {
		[method]: async () => {
			throw new Error(errorMessage);
		},
	} as unknown as Exchange;
}

describe("subscribe handler", () => {
	test.each([
		{
			type: SubscriptionType.ORDERBOOK,
			method: "watchOrderBook",
			errorMessage: "orderbook boom",
			expectedError: "Failed to fetch orderbook: orderbook boom",
		},
		{
			type: SubscriptionType.TRADES,
			method: "watchTrades",
			errorMessage: "trades boom",
			expectedError: "Failed to fetch trades: trades boom",
		},
		{
			type: SubscriptionType.TICKER,
			method: "watchTicker",
			errorMessage: "ticker boom",
			expectedError: "Failed to fetch ticker: ticker boom",
		},
		{
			type: SubscriptionType.OHLCV,
			method: "fetchOHLCVWs",
			errorMessage: "ohlcv boom",
			expectedError: "Failed to fetch OHLCV: ohlcv boom",
		},
		{
			type: SubscriptionType.BALANCE,
			method: "watchBalance",
			errorMessage: "balance boom",
			expectedError: "Failed to fetch balance: balance boom",
		},
		{
			type: SubscriptionType.ORDERS,
			method: "watchOrders",
			errorMessage: "orders boom",
			expectedError: "Failed to fetch orders: orders boom",
		},
	] satisfies Array<{
		type: SubscriptionTypeValue;
		method: ThrowingSubscriptionMethod;
		errorMessage: string;
		expectedError: string;
	}>)("closes $method stream after writing terminal error", async ({
		type,
		method,
		errorMessage,
		expectedError,
	}) => {
		const exchange = createThrowingExchange(method, errorMessage);
		const { call, state } = createSubscribeCall({
			cex: "binance",
			symbol: "BTC/USDT",
			type,
		});
		const handler = createSubscribeHandler({
			brokers: createPool(exchange),
			whitelistIps: ["*"],
		});

		await handler(call);

		expect(state.writes).toHaveLength(1);
		expect(JSON.parse(state.writes[0]?.data ?? "{}")).toEqual({
			error: expectedError,
		});
		expect(state.writes[0]).toMatchObject({
			symbol: "BTC/USDT",
			type,
		});
		expect(state.endCount).toBe(1);
	});

	test("outer catch reports the resolved subscription type", async () => {
		const exchange = {
			loadMarkets: async () => {
				throw new Error("markets unavailable");
			},
		} as unknown as Exchange;
		const { call, state } = createSubscribeCall({
			cex: "binance",
			symbol: "BTC/USDT",
			type: SubscriptionType.TICKER,
			options: { marketType: "swap" },
		});
		const handler = createSubscribeHandler({
			brokers: createPool(exchange),
			whitelistIps: ["*"],
		});

		await handler(call);

		expect(state.writes).toHaveLength(1);
		expect(JSON.parse(state.writes[0]?.data ?? "{}")).toEqual({
			error: "Internal server error: markets unavailable",
		});
		expect(state.writes[0]).toMatchObject({
			symbol: "",
			type: SubscriptionType.TICKER,
		});
		expect(state.endCount).toBe(1);
	});
});
