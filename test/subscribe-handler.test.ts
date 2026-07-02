import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { createSubscribeHandler } from "../src/handlers/subscribe/handler";
import type {
	SubscribeRequest,
	SubscribeResponse,
} from "../src/handlers/types";
import type { BrokerPoolEntry } from "../src/helpers/broker";
import { BrokerExecutionArchiver } from "../src/helpers/broker-execution-archive/writer";
import {
	SubscriptionType,
	type SubscriptionType as SubscriptionTypeValue,
} from "../src/helpers/constants";

type MockCallState = {
	writes: SubscribeResponse[];
	endCount: number;
	destroyed: boolean;
};

function createSubscribeCall(
	request: SubscribeRequest,
	options: { writeResults?: boolean[] } = {},
) {
	const emitter = new EventEmitter();
	const state: MockCallState = {
		writes: [],
		endCount: 0,
		destroyed: false,
	};
	const writeResults = [...(options.writeResults ?? [])];
	const call = Object.assign(emitter, {
		metadata: new grpc.Metadata(),
		request,
		getPeer: () => "127.0.0.1:1234",
		write: (response: SubscribeResponse) => {
			state.writes.push(response);
			return writeResults.shift() ?? true;
		},
		end: () => {
			state.endCount += 1;
			emitter.emit("end");
		},
		destroy: (error?: Error) => {
			state.destroyed = true;
			if (error) {
				emitter.emit("error", error);
			}
			emitter.emit("close");
		},
	});
	Object.defineProperty(call, "destroyed", {
		get: () => state.destroyed,
	});

	return {
		call: call as unknown as grpc.ServerWritableStream<
			SubscribeRequest,
			SubscribeResponse
		>,
		state,
	};
}

function nextTick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (condition()) {
			return;
		}
		await nextTick();
	}
	throw new Error("Timed out waiting for test condition");
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createControlledWatch() {
	const calls: unknown[][] = [];
	const resolvers: Array<(value: unknown) => void> = [];
	return {
		calls,
		resolvers,
		watch: (...args: unknown[]) => {
			const deferred = createDeferred<unknown>();
			calls.push(args);
			resolvers.push(deferred.resolve);
			return deferred.promise;
		},
	};
}

async function expectBackpressureWaitsForDrain({
	type,
	method,
	firstValue,
	secondValue,
}: {
	type: SubscriptionTypeValue;
	method: "watchOrderBook" | "watchTrades";
	firstValue: unknown;
	secondValue: unknown;
}) {
	const controlledWatch = createControlledWatch();
	const exchange = {
		[method]: controlledWatch.watch,
	} as unknown as Exchange;
	const { call, state } = createSubscribeCall(
		{
			cex: "binance",
			symbol: "BTC/USDT",
			type,
		},
		{ writeResults: [false] },
	);
	const handler = createSubscribeHandler({
		brokers: createPool(exchange),
		whitelistIps: ["*"],
	});

	const handlerPromise = handler(call);
	await waitFor(() => controlledWatch.calls.length === 1);
	controlledWatch.resolvers[0]?.(firstValue);
	await waitFor(() => state.writes.length === 1);

	await nextTick();
	expect(controlledWatch.calls).toHaveLength(1);

	call.emit("drain");
	await waitFor(() => controlledWatch.calls.length === 2);
	call.emit("close");
	controlledWatch.resolvers[1]?.(secondValue);
	await handlerPromise;

	expect(state.writes).toHaveLength(1);
}

function createPool(
	exchange: Exchange,
	cex = "binance",
): Record<string, BrokerPoolEntry> {
	return {
		[cex]: {
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
			type: SubscriptionType.TRADES,
			method: "watchTrades",
			firstValue: [{ id: "trade-1" }],
			secondValue: [{ id: "trade-2" }],
		},
		{
			type: SubscriptionType.ORDERBOOK,
			method: "watchOrderBook",
			firstValue: { bids: [[1, 2]], asks: [[3, 4]] },
			secondValue: { bids: [[5, 6]], asks: [[7, 8]] },
		},
	] satisfies Array<{
		type: SubscriptionTypeValue;
		method: "watchOrderBook" | "watchTrades";
		firstValue: unknown;
		secondValue: unknown;
	}>)("waits for drain before consuming another $method event after write backpressure", async ({
		type,
		method,
		firstValue,
		secondValue,
	}) => {
		await expectBackpressureWaitsForDrain({
			type,
			method,
			firstValue,
			secondValue,
		});
	});

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
			cex: "mexc",
			method: "watchBalance",
			errorMessage: "balance boom",
			expectedError: "Failed to fetch balance: balance boom",
		},
		{
			type: SubscriptionType.ORDERS,
			cex: "mexc",
			method: "watchOrders",
			errorMessage: "orders boom",
			expectedError: "Failed to fetch orders: orders boom",
		},
	] satisfies Array<{
		type: SubscriptionTypeValue;
		cex?: string;
		method: ThrowingSubscriptionMethod;
		errorMessage: string;
		expectedError: string;
	}>)("closes $method stream after writing terminal error", async ({
		type,
		cex = "binance",
		method,
		errorMessage,
		expectedError,
	}) => {
		const exchange = createThrowingExchange(method, errorMessage);
		const { call, state } = createSubscribeCall({
			cex,
			symbol: "BTC/USDT",
			type,
		});
		const handler = createSubscribeHandler({
			brokers: createPool(exchange, cex),
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

	test("archives orderbook snapshot rows to the forwarder", async () => {
		const originalFetch = globalThis.fetch;
		const originalInterval = process.env.CEX_BROKER_ORDERBOOK_INTERVAL_MS;
		const originalArchiveEnabled =
			process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
		const posts: unknown[] = [];
		globalThis.fetch = (async (_url, init) => {
			posts.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		process.env.CEX_BROKER_ORDERBOOK_INTERVAL_MS = "1";
		process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = "true";

		try {
			const controlledWatch = createControlledWatch();
			const exchange = {
				watchOrderBook: controlledWatch.watch,
			} as unknown as Exchange;
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: "http://127.0.0.1:9/archive",
				deploymentId: "test-deploy",
				batchSize: 1,
				flushIntervalMs: 60_000,
			});
			const { call } = createSubscribeCall({
				cex: "binance",
				symbol: "BTC/USDT",
				type: SubscriptionType.ORDERBOOK,
			});
			const handler = createSubscribeHandler({
				brokers: createPool(exchange),
				whitelistIps: ["*"],
				brokerArchiver: archiver,
			});

			const handlerPromise = handler(call);
			await waitFor(() => controlledWatch.calls.length === 1);
			controlledWatch.resolvers[0]?.({
				bids: [[100, 1.5]],
				asks: [[101, 2]],
				timestamp: 1_700_000_000_000,
			});
			await waitFor(() => archiver.getStats().enqueued >= 1);
			await archiver.flush();
			await waitFor(() => controlledWatch.calls.length >= 2);
			call.emit("close");
			controlledWatch.resolvers[1]?.({
				bids: [[100, 1.5]],
				asks: [[101, 2]],
				timestamp: 1_700_000_000_001,
			});
			await handlerPromise;

			expect(posts.length).toBeGreaterThanOrEqual(1);
			expect(posts[0]).toMatchObject({
				source: "broker_write",
				deployment_id: "test-deploy",
			});
			const rows = posts.flatMap(
				(post) =>
					(
						post as {
							rows: Array<{ table: string; row: Record<string, unknown> }>;
						}
					).rows,
			);
			expect(
				rows.some((entry) => entry.table === "market_data.orderbook_snapshots"),
			).toBe(true);
			const snapshotRow = rows.find(
				(entry) => entry.table === "market_data.orderbook_snapshots",
			);
			expect(snapshotRow?.row).toMatchObject({
				exchange: "binance",
				symbol: "BTC/USDT",
				best_bid: 100,
				best_ask: 101,
				bids_price: [100],
				asks_price: [101],
			});

			await archiver.close();
		} finally {
			globalThis.fetch = originalFetch;
			if (originalInterval === undefined) {
				delete process.env.CEX_BROKER_ORDERBOOK_INTERVAL_MS;
			} else {
				process.env.CEX_BROKER_ORDERBOOK_INTERVAL_MS = originalInterval;
			}
			if (originalArchiveEnabled === undefined) {
				delete process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
			} else {
				process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = originalArchiveEnabled;
			}
		}
	});

	test("archives OHLCV candle rows to the forwarder", async () => {
		const originalFetch = globalThis.fetch;
		const originalArchiveEnabled =
			process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
		const posts: unknown[] = [];
		globalThis.fetch = (async (_url, init) => {
			posts.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = "true";

		try {
			const controlledWatch = createControlledWatch();
			const exchange = {
				fetchOHLCVWs: controlledWatch.watch,
			} as unknown as Exchange;
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: "http://127.0.0.1:9/archive",
				deploymentId: "test-deploy",
				batchSize: 1,
				flushIntervalMs: 60_000,
			});
			const { call } = createSubscribeCall({
				cex: "binance",
				symbol: "BTC/USDT",
				type: SubscriptionType.OHLCV,
				options: { timeframe: "1m" },
			});
			const handler = createSubscribeHandler({
				brokers: createPool(exchange),
				whitelistIps: ["*"],
				brokerArchiver: archiver,
			});

			const handlerPromise = handler(call);
			await waitFor(() => controlledWatch.calls.length === 1);
			controlledWatch.resolvers[0]?.([[1_700_000_000_000, 1, 2, 0.5, 1.5, 10]]);
			await waitFor(() => archiver.getStats().enqueued >= 1);
			await archiver.flush();
			await waitFor(() => controlledWatch.calls.length >= 2);
			call.emit("close");
			controlledWatch.resolvers[1]?.([[1_700_000_000_000, 1, 2, 0.5, 1.5, 10]]);
			await handlerPromise;

			expect(posts.length).toBeGreaterThanOrEqual(1);
			const rows = (
				posts[0] as {
					rows: Array<{ table: string; row: Record<string, unknown> }>;
				}
			).rows;
			expect(rows.some((entry) => entry.table === "market_data.candles")).toBe(
				true,
			);
			expect(rows[0]?.row).toMatchObject({
				timeframe: "1m",
				open_time_ms: 1_700_000_000_000,
				is_closed: 0,
			});

			await archiver.close();
		} finally {
			globalThis.fetch = originalFetch;
			if (originalArchiveEnabled === undefined) {
				delete process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
			} else {
				process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = originalArchiveEnabled;
			}
		}
	});
});
