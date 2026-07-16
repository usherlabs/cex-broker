import ccxt from "@usherlabs/ccxt";

class ShutdownTestExchange {
	readonly id = "shutdown-test";
	readonly has = { fetchOHLCV: false };
	enableRateLimit = false;
	timeout = 0;
	#keepAlive: ReturnType<typeof setInterval> | undefined;
	#fetchCount = 0;

	extendExchangeOptions(): void {}

	async fetchOHLCVWs(): Promise<number[][]> {
		this.#fetchCount += 1;
		const countPath = process.env.OHLCV_TEST_EXCHANGE_COUNT_PATH;
		if (countPath) {
			await Bun.write(countPath, String(this.#fetchCount));
		}
		if (!this.#keepAlive) {
			this.#keepAlive = setInterval(() => {}, 1_000);
			const activePath = process.env.OHLCV_TEST_EXCHANGE_ACTIVE_PATH;
			if (activePath) {
				await Bun.write(activePath, "active");
			}
		}
		await Bun.sleep(20);
		return [[Date.now(), 1, 2, 0.5, 1.5, 10]];
	}

	async close(): Promise<unknown[]> {
		const closedPath = process.env.OHLCV_TEST_EXCHANGE_CLOSED_PATH;
		if (closedPath) {
			await Bun.write(closedPath, "close_attempted");
		}
		if (process.env.OHLCV_TEST_EXCHANGE_CLOSE_HANG === "true") {
			await new Promise(() => {});
		}
		if (this.#keepAlive) {
			clearInterval(this.#keepAlive);
			this.#keepAlive = undefined;
		}
		if (closedPath) {
			await Bun.write(closedPath, "closed");
		}
		return [];
	}
}

(ccxt.pro as unknown as Record<string, typeof ShutdownTestExchange>).binance =
	ShutdownTestExchange;
