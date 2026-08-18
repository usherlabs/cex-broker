import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import {
	MarketDataCollector,
	OhlcvStreamStaleError,
} from "../services/ohlcv-collector/collector";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../src/proto-package-definition";

type SubscribeRequest = {
	cex: string;
	symbol: string;
	type: string;
	options: Record<string, string>;
};

type SubscribeCall = grpc.ServerWritableStream<SubscribeRequest, unknown>;

const grpcObject = grpc.loadPackageDefinition(
	CEX_BROKER_PACKAGE_DEFINITION,
) as unknown as {
	cex_broker: {
		cex_service: {
			service: grpc.ServiceDefinition<grpc.UntypedServiceImplementation>;
		};
	};
};

function bindServer(server: grpc.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.bindAsync(
			"127.0.0.1:0",
			grpc.ServerCredentials.createInsecure(),
			(error, port) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(port);
			},
		);
	});
}

async function startSubscribeServer(
	onSubscribe: (call: SubscribeCall) => void,
): Promise<{ server: grpc.Server; port: number }> {
	const server = new grpc.Server();
	server.addService(grpcObject.cex_broker.cex_service.service, {
		Subscribe: onSubscribe,
	});
	return { server, port: await bindServer(server) };
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) {
			return;
		}
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for OHLCV collector condition");
}

function endWithError(call: SubscribeCall): void {
	call.emit(
		"error",
		Object.assign(new Error("test stream unavailable"), {
			code: grpc.status.UNAVAILABLE,
			details: "test stream unavailable",
			metadata: new grpc.Metadata(),
		}),
	);
}

function writeBar(call: SubscribeCall): void {
	call.write({
		data: JSON.stringify([1_700_000_000_000, 1, 2, 0.5, 1.5, 10]),
		timestamp: Date.now(),
		symbol: call.request.symbol,
		type: "OHLCV",
	});
}

class CapturingMetrics {
	readonly counters: Array<{
		name: string;
		value: number;
		labels: Record<string, string | number>;
	}> = [];

	async recordCounter(
		name: string,
		value: number,
		labels: Record<string, string | number>,
	): Promise<void> {
		this.counters.push({ name, value, labels });
	}
}

describe("market-data collector supervision", () => {
	test("exposes accepted logical frames to the equivalence observer in order", async () => {
		const payloads = [
			JSON.stringify({ sequence: 1 }),
			JSON.stringify({ sequence: 2 }),
		];
		const { server, port } = await startSubscribeServer((call) => {
			for (const data of payloads) {
				call.write({
					data,
					timestamp: Date.now(),
					symbol: call.request.symbol,
					type: call.request.type,
				});
			}
		});
		const observed: string[] = [];
		const abort = new AbortController();
		const collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: [
				{
					exchange: "binance",
					symbol: "BTC/USDT",
					feed: "ORDERBOOK",
					depthLimit: 25,
				},
			],
			onFrame: (_subscription, response) => observed.push(response.data),
		});
		const runPromise = collector.run(abort.signal);

		try {
			await waitFor(() => observed.length === 2);
			expect(observed).toEqual(payloads);
		} finally {
			abort.abort();
			await runPromise;
			server.forceShutdown();
		}
	});

	test("opens independent supervisors for all four market feeds", async () => {
		const requests: SubscribeRequest[] = [];
		const { server, port } = await startSubscribeServer((call) => {
			requests.push(call.request);
			call.write({
				data: JSON.stringify({ ok: true }),
				timestamp: Date.now(),
				symbol: call.request.symbol,
				type: call.request.type,
			});
		});
		const abort = new AbortController();
		const collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: [
				{
					exchange: "binance",
					symbol: "BTC/USDT",
					feed: "ORDERBOOK",
					depthLimit: 25,
				},
				{ exchange: "binance", symbol: "BTC/USDT", feed: "TICKER" },
				{ exchange: "binance", symbol: "BTC/USDT", feed: "TRADES" },
				{
					exchange: "binance",
					symbol: "BTC/USDT",
					feed: "OHLCV",
					timeframe: "1m",
					bootstrapLimit: 100,
				},
			],
		});
		const runPromise = collector.run(abort.signal);

		try {
			await waitFor(() => requests.length === 4);
			expect(requests).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "ORDERBOOK",
						options: { depthLimit: "25" },
					}),
					expect.objectContaining({ type: "TICKER", options: {} }),
					expect.objectContaining({ type: "TRADES", options: {} }),
					expect.objectContaining({
						type: "OHLCV",
						options: { timeframe: "1m", bootstrapLimit: "100" },
					}),
				]),
			);
		} finally {
			abort.abort();
			await runPromise;
			server.forceShutdown();
		}
	});

	test.each([
		{ terminal: "error" as const },
		{ terminal: "end" as const },
	])("resubscribes after stream $terminal", async ({ terminal }) => {
		const requests: SubscribeRequest[] = [];
		const { server, port } = await startSubscribeServer((call) => {
			requests.push(call.request);
			if (requests.length === 1) {
				queueMicrotask(() => {
					if (terminal === "error") {
						endWithError(call);
					} else {
						call.end();
					}
				});
				return;
			}
			writeBar(call);
		});
		const metrics = new CapturingMetrics();
		const abort = new AbortController();
		const collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: [
				{
					exchange: "binance",
					symbol: "BTC/USDT",
					feed: "OHLCV",
					timeframe: "1m",
				},
			],
			metrics,
			retry: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
		});
		const runPromise = collector.run(abort.signal);

		try {
			await waitFor(
				() =>
					requests.length >= 2 &&
					metrics.counters.some(
						(counter) =>
							counter.name === "cex_ohlcv_collector_bars_received_total",
					),
			);
			expect(requests.slice(0, 2)).toEqual([
				{
					cex: "binance",
					symbol: "BTC/USDT",
					type: "OHLCV",
					options: { timeframe: "1m" },
				},
				{
					cex: "binance",
					symbol: "BTC/USDT",
					type: "OHLCV",
					options: { timeframe: "1m" },
				},
			]);
			expect(metrics.counters).toContainEqual({
				name: "cex_ohlcv_collector_reconnects_total",
				value: 1,
				labels: {
					exchange: "binance",
					feed: "OHLCV",
					symbol: "BTC/USDT",
					timeframe: "1m",
				},
			});
			expect(metrics.counters).toContainEqual({
				name: "cex_ohlcv_collector_bars_received_total",
				value: 1,
				labels: {
					exchange: "binance",
					feed: "OHLCV",
					symbol: "BTC/USDT",
					timeframe: "1m",
				},
			});
		} finally {
			abort.abort();
			await runPromise;
			server.forceShutdown();
		}
	});

	test("one pair erroring leaves the other pair stream open", async () => {
		const subscriptionCounts = new Map<string, number>();
		let healthyStreamClosed = false;
		const { server, port } = await startSubscribeServer((call) => {
			const symbol = call.request.symbol;
			const count = (subscriptionCounts.get(symbol) ?? 0) + 1;
			subscriptionCounts.set(symbol, count);
			if (symbol === "ETH/USDT") {
				call.once("cancelled", () => {
					healthyStreamClosed = true;
				});
				writeBar(call);
				return;
			}
			if (count === 1) {
				queueMicrotask(() => endWithError(call));
			}
		});
		const abort = new AbortController();
		const collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: [
				{
					exchange: "binance",
					symbol: "BTC/USDT",
					feed: "OHLCV",
					timeframe: "1m",
				},
				{
					exchange: "binance",
					symbol: "ETH/USDT",
					feed: "OHLCV",
					timeframe: "1m",
				},
			],
			retry: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
		});
		const runPromise = collector.run(abort.signal);

		try {
			await waitFor(
				() =>
					(subscriptionCounts.get("BTC/USDT") ?? 0) >= 2 &&
					(subscriptionCounts.get("ETH/USDT") ?? 0) === 1,
			);
			await Bun.sleep(20);
			expect(subscriptionCounts.get("BTC/USDT")).toBe(2);
			expect(subscriptionCounts.get("ETH/USDT")).toBe(1);
			expect(healthyStreamClosed).toBe(false);
		} finally {
			abort.abort();
			await runPromise;
			server.forceShutdown();
		}
	});

	test("fails the run when an OHLCV stream goes silent past the cadence deadline", async () => {
		const { server, port } = await startSubscribeServer((call) => {
			// One bar, then silence: the upstream-dead case (WS death without a
			// close event) — the stream stays open but never delivers again.
			writeBar(call);
		});
		const metrics = new CapturingMetrics();
		const abort = new AbortController();
		const collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: [
				{
					exchange: "binance",
					symbol: "BTC/USDT",
					feed: "OHLCV",
					timeframe: "1m",
				},
			],
			metrics,
			ohlcvStaleDeadlineMs: 50,
		});

		try {
			await expect(collector.run(abort.signal)).rejects.toBeInstanceOf(
				OhlcvStreamStaleError,
			);
			expect(metrics.counters).toContainEqual({
				name: "cex_ohlcv_collector_stale_streams_total",
				value: 1,
				labels: {
					exchange: "binance",
					feed: "OHLCV",
					symbol: "BTC/USDT",
					timeframe: "1m",
				},
			});
		} finally {
			abort.abort();
			server.forceShutdown();
		}
	});

	test("frames arriving within the deadline keep the OHLCV stream alive", async () => {
		let stopWriting = false;
		const { server, port } = await startSubscribeServer((call) => {
			const interval = setInterval(() => {
				if (stopWriting || call.cancelled) {
					clearInterval(interval);
					return;
				}
				writeBar(call);
			}, 10);
			call.once("cancelled", () => clearInterval(interval));
		});
		const metrics = new CapturingMetrics();
		const abort = new AbortController();
		const collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: [
				{
					exchange: "binance",
					symbol: "BTC/USDT",
					feed: "OHLCV",
					timeframe: "1m",
				},
			],
			metrics,
			ohlcvStaleDeadlineMs: 250,
		});
		const runPromise = collector.run(abort.signal);

		try {
			await waitFor(
				() =>
					metrics.counters.filter(
						(counter) =>
							counter.name === "cex_ohlcv_collector_bars_received_total",
					).length >= 10,
			);
			expect(
				collector.getHealthSnapshot()["binance:BTC/USDT:OHLCV"]?.state,
			).toBe("healthy");
		} finally {
			stopWriting = true;
			abort.abort();
			await runPromise;
			server.forceShutdown();
		}
	});

	test("a silent event-driven feed stays subscribed through OHLCV-length silence", async () => {
		// TRADES has no guaranteed cadence: a quiet market is legitimate silence,
		// so the message-gap deadline must not apply to it.
		let subscribed = false;
		const { server, port } = await startSubscribeServer(() => {
			subscribed = true;
		});
		const abort = new AbortController();
		const collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: [
				{ exchange: "binance", symbol: "BTC/USDT", feed: "TRADES" },
			],
			ohlcvStaleDeadlineMs: 10,
		});
		const runPromise = collector.run(abort.signal);

		try {
			await waitFor(() => subscribed);
			await Bun.sleep(100);
			expect(
				collector.getHealthSnapshot()["binance:BTC/USDT:TRADES"]?.state,
			).toBe("connecting");
		} finally {
			abort.abort();
			await runPromise;
			server.forceShutdown();
		}
	});

	test("rejects an unparseable OHLCV timeframe at construction", () => {
		expect(
			() =>
				new MarketDataCollector({
					brokerUrl: "127.0.0.1:1",
					subscriptions: [
						{
							exchange: "binance",
							symbol: "BTC/USDT",
							feed: "OHLCV",
							timeframe: "one-minute",
						},
					],
				}),
		).toThrow('Unsupported OHLCV timeframe "one-minute"');
	});
});
