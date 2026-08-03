import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { startForwarderServer } from "./archive-forwarder-server";

const archiveTestDirectory = mkdtempSync(
	join(tmpdir(), "cex-broker-subscribe-archive-test-"),
);
let deadLetterFileIndex = 0;

function createDeadLetterPath(): string {
	deadLetterFileIndex += 1;
	return join(archiveTestDirectory, `loss-${deadLetterFileIndex}.jsonl`);
}

afterAll(() => {
	rmSync(archiveTestDirectory, { recursive: true, force: true });
});

type MockCallState = {
	writes: SubscribeResponse[];
	endCount: number;
	destroyed: boolean;
	errors: unknown[];
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
		errors: [],
	};
	const writeResults = [...(options.writeResults ?? [])];
	const call = Object.assign(emitter, {
		cancelled: false,
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
	emitter.on("error", (error) => state.errors.push(error));
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

function cancelSubscribeCall(
	call: grpc.ServerWritableStream<SubscribeRequest, SubscribeResponse>,
): void {
	call.cancelled = true;
	call.emit("cancelled", "cancelled");
	call.destroy();
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
	cancelSubscribeCall(call);
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
	| "watchOHLCV"
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
	test("provisioned-only rejects request credentials before broker use", async () => {
		let watchCalls = 0;
		const exchange = {
			watchTicker: async () => {
				watchCalls += 1;
				return { last: 100 };
			},
		} as unknown as Exchange;
		const { call, state } = createSubscribeCall({
			cex: "binance",
			symbol: "BTC/USDT",
			type: SubscriptionType.TICKER,
		});
		call.metadata.set("api-key", "never-log-this-key");
		const metrics: Array<{ name: string; labels: Record<string, unknown> }> =
			[];
		const handler = createSubscribeHandler({
			brokers: createPool(exchange),
			whitelistIps: ["*"],
			credentialPolicy: {
				sourcePolicy: "provisioned_only",
				provisionedProfile: "read_only_key",
			},
			otelMetrics: {
				recordCounter: (name, _value, labels) => {
					metrics.push({ name, labels });
				},
			} as never,
		});

		await handler(call);

		expect(watchCalls).toBe(0);
		expect(state.destroyed).toBe(true);
		expect(state.errors).toContainEqual(
			expect.objectContaining({ code: grpc.status.PERMISSION_DENIED }),
		);
		expect(metrics).toContainEqual({
			name: "cex_request_credentials_rejected_total",
			labels: { rpc: "Subscribe" },
		});
		expect(JSON.stringify(metrics)).not.toContain("never-log-this-key");
	});

	test("keeps a subscription active when close fires without cancellation", async () => {
		const controlledWatch = createControlledWatch();
		const exchange = {
			watchTrades: controlledWatch.watch,
		} as unknown as Exchange;
		const { call } = createSubscribeCall({
			cex: "binance",
			symbol: "BTC/USDT",
			type: SubscriptionType.TRADES,
		});
		const handler = createSubscribeHandler({
			brokers: createPool(exchange),
			whitelistIps: ["*"],
		});
		const handlerPromise = handler(call);

		await waitFor(() => controlledWatch.calls.length === 1);
		call.emit("close");
		controlledWatch.resolvers[0]?.([{ id: "trade-1" }]);
		await waitFor(() => controlledWatch.calls.length === 2);

		cancelSubscribeCall(call);
		controlledWatch.resolvers[1]?.([{ id: "trade-2" }]);
		await handlerPromise;
	});

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
			method: "watchOHLCV",
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
		const server = await startForwarderServer();
		const posts = server.requests;
		const originalInterval = process.env.CEX_BROKER_ORDERBOOK_INTERVAL_MS;
		const originalArchiveEnabled =
			process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
		process.env.CEX_BROKER_ORDERBOOK_INTERVAL_MS = "1";
		process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = "true";

		try {
			const controlledWatch = createControlledWatch();
			const exchange = {
				watchOrderBook: controlledWatch.watch,
			} as unknown as Exchange;
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deadLetterPath: createDeadLetterPath(),
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
			await waitFor(() => archiver.getStats().enqueued >= 5);
			// batchSize 1 auto-flushes on enqueue; wait for that post to reach the
			// forwarder over the real transport rather than racing the round trip.
			await waitFor(() => archiver.getStats().flushed >= 5);
			await waitFor(() => controlledWatch.calls.length >= 2);
			cancelSubscribeCall(call);
			controlledWatch.resolvers[1]?.({
				bids: [[100, 1.5]],
				asks: [[101, 2]],
				timestamp: 1_700_000_000_001,
			});
			await handlerPromise;

			expect(posts.length).toBeGreaterThanOrEqual(1);
			expect(posts[0]?.body).toMatchObject({
				source: "broker_write",
				deployment_id: "test-deploy",
			});
			const rows = posts.flatMap(
				(post) =>
					(post.body.rows ?? []) as Array<{
						table: string;
						row: Record<string, unknown>;
					}>,
			);
			expect(
				rows.some((entry) => entry.table === "market_data.orderbook_snapshots"),
			).toBe(true);
			expect(
				rows.some(
					(entry) => entry.table === "market_data.cex_order_book_levels",
				),
			).toBe(true);
			expect(
				rows.some(
					(entry) => entry.table === "market_data.cex_order_book_depth_summary",
				),
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
			await server.close();
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
		const server = await startForwarderServer();
		const posts = server.requests;
		const originalArchiveEnabled =
			process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
		process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = "true";

		try {
			const controlledWatch = createControlledWatch();
			const exchange = {
				watchOHLCV: controlledWatch.watch,
			} as unknown as Exchange;
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deadLetterPath: createDeadLetterPath(),
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
			await waitFor(() => archiver.getStats().enqueued >= 3);
			// batchSize 1 auto-flushes on enqueue; wait for that post to reach the
			// forwarder over the real transport rather than racing the round trip.
			await waitFor(() => archiver.getStats().flushed >= 3);
			await waitFor(() => controlledWatch.calls.length >= 2);
			cancelSubscribeCall(call);
			controlledWatch.resolvers[1]?.([[1_700_000_000_000, 1, 2, 0.5, 1.5, 10]]);
			await handlerPromise;

			expect(posts.length).toBeGreaterThanOrEqual(1);
			const rows = posts.flatMap(
				(post) =>
					(post.body.rows ?? []) as Array<{
						table: string;
						row: Record<string, unknown>;
					}>,
			);
			expect(rows.some((entry) => entry.table === "market_data.candles")).toBe(
				true,
			);
			expect(
				rows.some((entry) => entry.table === "market_data.cex_ohlcv"),
			).toBe(true);
			const candle = rows.find(
				(entry) => entry.table === "market_data.candles",
			);
			expect(candle?.row).toMatchObject({
				timeframe: "1m",
				open_time_ms: 1_700_000_000_000,
				is_closed: 0,
			});

			await archiver.close();
		} finally {
			await server.close();
			if (originalArchiveEnabled === undefined) {
				delete process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
			} else {
				process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = originalArchiveEnabled;
			}
		}
	});

	test("archives ticker and trades with raw-to-normalized capture linkage", async () => {
		const server = await startForwarderServer();
		const originalEnabled = process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
		process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = "true";
		try {
			const tickerWatch = createControlledWatch();
			const tradesWatch = createControlledWatch();
			const exchange = {
				watchTicker: tickerWatch.watch,
				watchTrades: tradesWatch.watch,
			} as unknown as Exchange;
			const archiver = BrokerExecutionArchiver.create({
				source: "broker_read",
				forwarderUrl: server.url,
				deadLetterPath: createDeadLetterPath(),
				deploymentId: "read-capture-test",
				batchSize: 1,
				flushIntervalMs: 60_000,
			});
			const tickerCall = createSubscribeCall({
				cex: "binance",
				symbol: "BTC/USDT",
				type: SubscriptionType.TICKER,
			}).call;
			const tradesCall = createSubscribeCall({
				cex: "binance",
				symbol: "BTC/USDT",
				type: SubscriptionType.TRADES,
			}).call;
			const handler = createSubscribeHandler({
				brokers: createPool(exchange),
				whitelistIps: ["*"],
				brokerArchiver: archiver,
			});
			const tickerPromise = handler(tickerCall);
			const tradesPromise = handler(tradesCall);
			await waitFor(
				() => tickerWatch.calls.length === 1 && tradesWatch.calls.length === 1,
			);
			tickerWatch.resolvers[0]?.({
				timestamp: 1_700_000_000_100,
				last: 100.5,
				bid: 100,
				ask: 101,
			});
			tradesWatch.resolvers[0]?.([
				{
					id: "trade-1",
					timestamp: 1_700_000_000_200,
					side: "buy",
					price: 100.25,
					amount: 0.5,
				},
			]);
			await waitFor(() => archiver.getStats().flushed >= 4);
			await waitFor(
				() => tickerWatch.calls.length >= 2 && tradesWatch.calls.length >= 2,
			);
			cancelSubscribeCall(tickerCall);
			cancelSubscribeCall(tradesCall);
			tickerWatch.resolvers[1]?.({});
			tradesWatch.resolvers[1]?.([]);
			await Promise.all([tickerPromise, tradesPromise]);

			const rows = server.requests.flatMap(
				(post) =>
					(post.body.rows ?? []) as Array<{
						table: string;
						row: Record<string, unknown>;
					}>,
			);
			for (const [feed, table] of [
				["TICKER", "market_data.cex_ticker_events"],
				["TRADES", "market_data.cex_trades"],
			] as const) {
				const raw = rows.find(
					(entry) =>
						entry.table === "market_data.cex_stream_events" &&
						entry.row.feed === feed,
				);
				const normalized = rows.find((entry) => entry.table === table);
				expect(raw?.row.source).toBe("broker_read");
				expect(normalized?.row.raw_capture_id).toBe(raw?.row.raw_capture_id);
				expect(normalized?.row.raw_checksum).toBe(raw?.row.raw_checksum);
				expect(normalized?.row.normalized_row_checksum).toBeString();
			}
			await archiver.close();
		} finally {
			await server.close();
			if (originalEnabled === undefined) {
				delete process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
			} else {
				process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = originalEnabled;
			}
		}
	});

	test("keeps stream delivery successful while forwarder failure is durably journaled", async () => {
		const server = await startForwarderServer(() => ({ status: 503 }));
		const originalEnabled = process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
		const originalMode = process.env.CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE;
		process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = "true";
		process.env.CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE = "canonical";
		const deadLetterPath = createDeadLetterPath();
		try {
			const controlledWatch = createControlledWatch();
			const exchange = {
				watchTicker: controlledWatch.watch,
			} as unknown as Exchange;
			const archiver = BrokerExecutionArchiver.create({
				source: "broker_read",
				forwarderUrl: server.url,
				deadLetterPath,
				deploymentId: "read-fault-test",
				batchSize: 1,
				flushIntervalMs: 60_000,
			});
			const { call, state } = createSubscribeCall({
				cex: "binance",
				symbol: "BTC/USDT",
				type: SubscriptionType.TICKER,
			});
			const handler = createSubscribeHandler({
				brokers: createPool(exchange),
				whitelistIps: ["*"],
				brokerArchiver: archiver,
			});
			const handlerPromise = handler(call);
			await waitFor(() => controlledWatch.calls.length === 1);
			controlledWatch.resolvers[0]?.({
				timestamp: 1_700_000_000_100,
				last: 100.5,
				bid: 100,
				ask: 101,
			});
			await waitFor(() => state.writes.length === 1);
			expect(JSON.parse(state.writes[0]?.data ?? "{}")).toMatchObject({
				last: 100.5,
			});
			await waitFor(() => server.requests.length >= 1);
			cancelSubscribeCall(call);
			controlledWatch.resolvers[1]?.({});
			await handlerPromise;
			await archiver.close();

			const losses = readFileSync(deadLetterPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(losses).toHaveLength(2);
			expect(
				losses.every(
					(loss) =>
						loss.source === "broker_read" &&
						loss.reason === "shutdown_forwarder_failure",
				),
			).toBe(true);
		} finally {
			await server.close();
			if (originalEnabled === undefined) {
				delete process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
			} else {
				process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = originalEnabled;
			}
			if (originalMode === undefined) {
				delete process.env.CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE;
			} else {
				process.env.CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE = originalMode;
			}
		}
	});
});
