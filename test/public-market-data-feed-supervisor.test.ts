import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import type { BrokerPoolEntry } from "../src/helpers/broker";
import {
	type PublicMarketDataArchiveSink,
	PublicMarketDataFeedSupervisor,
} from "../src/helpers/public-market-data-feed";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline)
			throw new Error("timed out waiting for condition");
		await Bun.sleep(1);
	}
}

function controlledExchange(
	options: { unwatch?: boolean; fetchOhlcv?: Array<unknown | Error> } = {
		unwatch: true,
	},
) {
	const orderbooks: Deferred<unknown>[] = [];
	const tickers: Deferred<unknown>[] = [];
	const ohlcv: Deferred<unknown>[] = [];
	const calls = {
		orderbook: [] as unknown[][],
		ticker: [] as unknown[][],
		ohlcv: [] as unknown[][],
		fetchOhlcv: [] as unknown[][],
		unwatchOrderbook: 0,
		close: 0,
	};
	const exchange = {
		watchOrderBook: (...args: unknown[]) => {
			calls.orderbook.push(args);
			const next = deferred<unknown>();
			orderbooks.push(next);
			return next.promise;
		},
		watchTicker: (...args: unknown[]) => {
			calls.ticker.push(args);
			const next = deferred<unknown>();
			tickers.push(next);
			return next.promise;
		},
		watchOHLCV: (...args: unknown[]) => {
			calls.ohlcv.push(args);
			const next = deferred<unknown>();
			ohlcv.push(next);
			return next.promise;
		},
		fetchOHLCV: async (...args: unknown[]) => {
			calls.fetchOhlcv.push(args);
			const result = options.fetchOhlcv?.shift();
			if (result instanceof Error) throw result;
			if (result !== undefined) return result;
			return [[1_700_000_000_000, 1, 2, 0.5, 1.5, 10]];
		},
		close: async () => {
			calls.close += 1;
		},
		...(options.unwatch
			? {
					unWatchOrderBook: async () => {
						calls.unwatchOrderbook += 1;
						orderbooks.at(-1)?.reject(new Error("unwatched"));
					},
					unWatchTicker: async () => {
						tickers.at(-1)?.reject(new Error("unwatched"));
					},
					unWatchTrades: async () => {},
					unWatchOHLCV: async () => {
						ohlcv.at(-1)?.reject(new Error("unwatched"));
					},
				}
			: {}),
	} as unknown as Exchange;
	return { exchange, calls, orderbooks, tickers, ohlcv };
}

function pool(exchange: Exchange): Record<string, BrokerPoolEntry> {
	return {
		binance: {
			primary: { exchange, label: "primary" },
			secondaryBrokers: [],
		},
	};
}

function recordingArchiveSink() {
	const calls = {
		orderbook: 0,
		ticker: 0,
		ohlcv: 0,
		bootstrap: 0,
	};
	const sink: PublicMarketDataArchiveSink = {
		orderbook: () => {
			calls.orderbook += 1;
		},
		ticker: () => {
			calls.ticker += 1;
		},
		trades: () => {},
		ohlcv: () => {
			calls.ohlcv += 1;
		},
		ohlcvBootstrap: () => {
			calls.bootstrap += 1;
		},
	};
	return { sink, calls };
}

describe("PublicMarketDataFeedSupervisor", () => {
	test("shares one Binance ORDERBOOK watch/archive cadence and projects per subscriber", async () => {
		const controlled = controlledExchange({ unwatch: true });
		const archive = recordingArchiveSink();
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: archive.sink,
			enabledOrderBookProfileIds: new Set(["binance:l2-diff:500"]),
		});
		const shallow = await supervisor.subscribe({
			exchange: " Binance ",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "ORDERBOOK",
			depthLimit: 1,
		});
		const full = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "ORDERBOOK",
		});

		await waitFor(() => controlled.calls.orderbook.length === 1);
		expect(controlled.calls.orderbook[0]).toEqual(["BTC/USDT", 500]);
		controlled.orderbooks[0]?.resolve({
			bids: [
				[100, 1],
				[99, 2],
			],
			asks: [
				[101, 3],
				[102, 4],
			],
			timestamp: 10,
		});

		const shallowFrame = (await shallow[Symbol.asyncIterator]().next()).value;
		const fullFrame = (await full[Symbol.asyncIterator]().next()).value;
		expect(JSON.parse(shallowFrame?.data ?? "{}")).toMatchObject({
			bids: [[100, 1]],
			asks: [[101, 3]],
			depthLimit: 1,
		});
		expect(JSON.parse(fullFrame?.data ?? "{}")).toMatchObject({
			bids: [
				[100, 1],
				[99, 2],
			],
			depthLimit: 2,
		});
		expect(archive.calls.orderbook).toBe(1);
		await waitFor(() => controlled.calls.orderbook.length === 2);

		shallow.close();
		full.close();
		await supervisor.close();
		expect(controlled.calls.unwatchOrderbook).toBe(1);
		expect(controlled.calls.close).toBe(0);
	});

	test("late joiners wait for the next accepted observation", async () => {
		const controlled = controlledExchange();
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: recordingArchiveSink().sink,
		});
		const first = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "TICKER",
		});
		await waitFor(() => controlled.tickers.length === 1);
		controlled.tickers[0]?.resolve({ last: 100 });
		expect(
			JSON.parse(
				(await first[Symbol.asyncIterator]().next()).value?.data ?? "{}",
			),
		).toEqual({ last: 100 });
		await waitFor(() => controlled.tickers.length === 2);

		const late = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "TICKER",
		});
		let lateSettled = false;
		const lateNext = late[Symbol.asyncIterator]()
			.next()
			.then((value) => {
				lateSettled = true;
				return value;
			});
		await Bun.sleep(5);
		expect(lateSettled).toBe(false);
		controlled.tickers[1]?.resolve({ last: 101 });
		expect(JSON.parse((await lateNext).value?.data ?? "{}")).toEqual({
			last: 101,
		});
		first.close();
		late.close();
		await supervisor.close();
	});

	test("isolates a slow subscriber overflow while archive and healthy delivery continue", async () => {
		const controlled = controlledExchange();
		const archive = recordingArchiveSink();
		const overflowLabels: Array<Record<string, string | number>> = [];
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: archive.sink,
			bufferLimits: { frameLimit: 1, byteLimit: 10_000 },
			metrics: {
				recordCounter: async (name, _value, labels) => {
					if (name === "public_feed_subscriber_overflow_total") {
						overflowLabels.push(labels);
					}
				},
			},
		});
		const slow = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "TICKER",
		});
		const healthy = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "TICKER",
		});

		await waitFor(() => controlled.tickers.length === 1);
		controlled.tickers[0]?.resolve({ last: 1 });
		expect(
			JSON.parse(
				(await healthy[Symbol.asyncIterator]().next()).value?.data ?? "{}",
			),
		).toEqual({ last: 1 });
		await waitFor(() => controlled.tickers.length === 2);
		controlled.tickers[1]?.resolve({ last: 2 });
		expect(
			JSON.parse(
				(await healthy[Symbol.asyncIterator]().next()).value?.data ?? "{}",
			),
		).toEqual({ last: 2 });

		await expect(slow[Symbol.asyncIterator]().next()).rejects.toThrow(
			"Public market-data subscriber fell behind",
		);
		expect(archive.calls.ticker).toBe(2);
		expect(overflowLabels).toEqual([
			{
				exchange_bucket: "configured",
				feed: "TICKER",
				market_type: "spot",
			},
		]);
		healthy.close();
		await supervisor.close();
	});

	test("bounds acquisition-profile metric labels", async () => {
		const controlled = controlledExchange();
		const profileLabels: Array<Record<string, string | number>> = [];
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: recordingArchiveSink().sink,
			metrics: {
				recordCounter: async (name, _value, labels) => {
					if (name === "public_feed_acquisition_profiles_total") {
						profileLabels.push(labels);
					}
				},
			},
		});
		const subscriber = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "ORDERBOOK",
		});

		expect(profileLabels).toEqual([
			{
				exchange_bucket: "configured",
				feed: "ORDERBOOK",
				market_type: "spot",
				profile_class: "conservative",
			},
		]);
		expect(profileLabels[0]).not.toHaveProperty("exchange");
		expect(profileLabels[0]).not.toHaveProperty("symbol");
		expect(profileLabels[0]).not.toHaveProperty("profile");
		subscriber.close();
		await supervisor.close();
	});

	test("keeps first-positive OHLCV bootstrap ownership unclaimed after a zero request", async () => {
		const controlled = controlledExchange();
		const archive = recordingArchiveSink();
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: archive.sink,
		});
		const zero = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "OHLCV",
			timeframe: "1m",
			bootstrapLimit: 0,
		});
		expect(controlled.calls.fetchOhlcv).toHaveLength(0);

		const collector = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "OHLCV",
			timeframe: "1m",
			bootstrapLimit: 100,
		});
		expect(controlled.calls.fetchOhlcv).toEqual([
			["BTC/USDT", "1m", undefined, 100],
		]);
		expect(archive.calls.bootstrap).toBe(1);
		expect(
			JSON.parse(
				(await collector[Symbol.asyncIterator]().next()).value?.data ?? "[]",
			),
		).toHaveLength(1);
		zero.close();
		collector.close();
		await supervisor.close();
	});

	test("releases failed OHLCV bootstrap ownership for a later positive retry", async () => {
		const controlled = controlledExchange({
			unwatch: true,
			fetchOhlcv: [
				new Error("history unavailable"),
				[[1_700_000_060_000, 2, 3, 1, 2.5, 11]],
			],
		});
		const archive = recordingArchiveSink();
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: archive.sink,
		});
		const first = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "OHLCV",
			bootstrapLimit: 100,
		});
		const retry = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "OHLCV",
			bootstrapLimit: 100,
		});
		expect(controlled.calls.fetchOhlcv).toHaveLength(2);
		expect(archive.calls.bootstrap).toBe(1);
		expect(
			JSON.parse(
				(await retry[Symbol.asyncIterator]().next()).value?.data ?? "[]",
			),
		).toHaveLength(1);
		first.close();
		retry.close();
		await supervisor.close();
	});

	test("delivers later OHLCV bootstrap before live without a second archive bootstrap", async () => {
		const firstHistory = [[1_700_000_000_000, 1, 2, 0.5, 1.5, 10]];
		const laterHistory = [[1_700_000_060_000, 2, 3, 1, 2.5, 11]];
		const controlled = controlledExchange({
			unwatch: true,
			fetchOhlcv: [firstHistory, laterHistory],
		});
		const archive = recordingArchiveSink();
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: archive.sink,
		});
		const first = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			feed: "OHLCV",
			bootstrapLimit: 100,
		});
		await first[Symbol.asyncIterator]().next();
		await waitFor(() => controlled.ohlcv.length === 1);
		const later = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			feed: "OHLCV",
			bootstrapLimit: 50,
		});
		const iterator = later[Symbol.asyncIterator]();
		expect(JSON.parse((await iterator.next()).value?.data ?? "[]")).toEqual(
			laterHistory,
		);
		controlled.ohlcv[0]?.resolve([[1_700_000_120_000, 3, 4, 2, 3.5, 12]]);
		expect(JSON.parse((await iterator.next()).value?.data ?? "[]")).toEqual([
			[1_700_000_120_000, 3, 4, 2, 3.5, 12],
		]);
		expect(archive.calls.bootstrap).toBe(1);
		expect(archive.calls.ohlcv).toBe(1);
		first.close();
		later.close();
		await supervisor.close();
	});

	test("keeps a later OHLCV subscriber live when its local bootstrap fetch fails", async () => {
		const controlled = controlledExchange({
			unwatch: true,
			fetchOhlcv: [
				[[1_700_000_000_000, 1, 2, 0.5, 1.5, 10]],
				new Error("later history unavailable"),
			],
		});
		const archive = recordingArchiveSink();
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: archive.sink,
		});
		const first = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			feed: "OHLCV",
			bootstrapLimit: 100,
		});
		await first[Symbol.asyncIterator]().next();
		await waitFor(() => controlled.ohlcv.length === 1);
		const later = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			feed: "OHLCV",
			bootstrapLimit: 50,
		});
		controlled.ohlcv[0]?.resolve([[1_700_000_060_000, 2, 3, 1, 2.5, 11]]);
		expect(
			JSON.parse(
				(await later[Symbol.asyncIterator]().next()).value?.data ?? "[]",
			),
		).toEqual([[1_700_000_060_000, 2, 3, 1, 2.5, 11]]);
		expect(archive.calls.bootstrap).toBe(1);
		expect(archive.calls.ohlcv).toBe(1);
		first.close();
		later.close();
		await supervisor.close();
	});

	test("ignores a watch result that resolves after final-subscriber retirement", async () => {
		const controlled = controlledExchange({ unwatch: false });
		const archive = recordingArchiveSink();
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: archive.sink,
			retirementTimeoutMs: 20,
		});
		const subscription = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "TICKER",
		});
		await waitFor(() => controlled.tickers.length === 1);
		subscription.close();
		controlled.tickers[0]?.resolve({ last: 100 });
		await Bun.sleep(1);
		expect(archive.calls.ticker).toBe(0);
		await supervisor.close();
	});

	test("fans out an upstream failure and permits a fresh worker", async () => {
		const controlled = controlledExchange();
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: recordingArchiveSink().sink,
		});
		const first = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			feed: "TICKER",
		});
		await waitFor(() => controlled.tickers.length === 1);
		controlled.tickers[0]?.reject(new Error("venue disconnected"));
		await expect(first[Symbol.asyncIterator]().next()).rejects.toThrow(
			"Failed to fetch ticker: venue disconnected",
		);

		const fresh = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			feed: "TICKER",
		});
		await waitFor(() => controlled.tickers.length === 2);
		controlled.tickers[1]?.resolve({ last: 101 });
		expect(
			JSON.parse(
				(await fresh[Symbol.asyncIterator]().next()).value?.data ?? "{}",
			),
		).toEqual({ last: 101 });
		fresh.close();
		await supervisor.close();
	});

	test("fails replacement rather than overlapping a configured primary without unwatch", async () => {
		const controlled = controlledExchange({ unwatch: false });
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: pool(controlled.exchange),
			archiveSink: recordingArchiveSink().sink,
			retirementTimeoutMs: 10,
		});
		const first = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "TICKER",
		});
		await waitFor(() => controlled.calls.ticker.length === 1);
		first.close();
		await expect(
			supervisor.subscribe({
				exchange: "binance",
				symbol: "BTC/USDT",
				marketType: "spot",
				feed: "TICKER",
			}),
		).rejects.toThrow("Public feed retirement timed out");
		expect(controlled.calls.ticker).toHaveLength(1);
		controlled.tickers[0]?.resolve({ last: 100 });
		await expect(supervisor.close()).rejects.toThrow(/public feed worker/);
	});

	test("uses the primary archive label even when metadata selects a secondary", async () => {
		const controlled = controlledExchange();
		let archivedAccountSelector: string | undefined;
		const archive = recordingArchiveSink();
		archive.sink.ticker = (input) => {
			archivedAccountSelector = input.accountSelector;
		};
		const metadata = new grpc.Metadata();
		metadata.set("use-secondary-key", "1");
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: {
				binance: {
					primary: { exchange: controlled.exchange, label: "primary" },
					secondaryBrokers: [
						{
							exchange: controlledExchange().exchange,
							label: "secondary:1",
							index: 1,
						},
					],
				},
			},
			archiveSink: archive.sink,
		});
		const subscription = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "TICKER",
			metadata,
		});
		await waitFor(() => controlled.tickers.length === 1);
		controlled.tickers[0]?.resolve({ last: 100 });
		await subscription[Symbol.asyncIterator]().next();
		expect(archivedAccountSelector).toBe("primary");
		subscription.close();
		await supervisor.close();
	});

	test("keeps a request-created exchange alive until the final subscriber leaves", async () => {
		const first = controlledExchange();
		const duplicate = controlledExchange();
		const candidates = [first.exchange, duplicate.exchange];
		let accountSelector: string | undefined = "unexpected";
		const archive = recordingArchiveSink();
		archive.sink.ticker = (input) => {
			accountSelector = input.accountSelector;
		};
		const supervisor = new PublicMarketDataFeedSupervisor({
			brokers: {},
			archiveSink: archive.sink,
			createRequestBroker: () => candidates.shift() ?? null,
			createPublicBroker: () => null,
		});
		const owner = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "TICKER",
		});
		const remaining = await supervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "TICKER",
		});
		await waitFor(() => duplicate.calls.close === 1);

		owner.close();
		expect(first.calls.close).toBe(0);
		await waitFor(() => first.tickers.length === 1);
		first.tickers[0]?.resolve({ last: 100 });
		await remaining[Symbol.asyncIterator]().next();
		expect(accountSelector).toBeUndefined();
		remaining.close();
		await supervisor.close();
		expect(first.calls.close).toBe(1);
	});
});
