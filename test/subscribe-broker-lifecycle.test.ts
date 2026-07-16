import { describe, expect, test } from "bun:test";
import type { Exchange } from "@usherlabs/ccxt";
import { SubscribeBrokerLifecycle } from "../src/handlers/subscribe";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
};

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function fakeBroker(close: () => Promise<void>): Exchange {
	return { close } as unknown as Exchange;
}

const context = { cex: "binance", symbol: "BTC/USDT" };

describe("SubscribeBrokerLifecycle", () => {
	test("closeAll rejects when a broker close fails but still closes the rest", async () => {
		const lifecycle = new SubscribeBrokerLifecycle();
		let healthyClosed = false;
		lifecycle.register(
			fakeBroker(async () => {
				healthyClosed = true;
			}),
			context,
		);
		lifecycle.register(
			fakeBroker(async () => {
				throw new Error("exchange refused to close");
			}),
			context,
		);

		await expect(lifecycle.closeAll()).rejects.toThrow(/1 request-scoped/);
		expect(healthyClosed).toBe(true);
	});

	test("closeAll waits for brokers registered while shutdown is in progress", async () => {
		const lifecycle = new SubscribeBrokerLifecycle();
		const firstClose = deferred();
		let lateClosed = false;
		lifecycle.register(
			fakeBroker(() => firstClose.promise),
			context,
		);

		let closeAllSettled = false;
		const closing = lifecycle.closeAll().then(() => {
			closeAllSettled = true;
		});

		// Registration racing shutdown: closeAll has already snapshotted its
		// first drain round when this broker arrives.
		const lateClose = deferred();
		lifecycle.register(
			fakeBroker(async () => {
				await lateClose.promise;
				lateClosed = true;
			}),
			context,
		);

		firstClose.resolve();
		await Bun.sleep(10);
		expect(closeAllSettled).toBe(false);

		lateClose.resolve();
		await closing;
		expect(lateClosed).toBe(true);
	});
});
