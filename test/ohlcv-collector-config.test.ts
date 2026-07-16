import { describe, expect, test } from "bun:test";
import {
	loadOhlcvCollectorConfig,
	OHLCV_COLLECTOR_CONFIG_ENV,
	parseOhlcvCollectorConfig,
} from "../services/ohlcv-collector/config";

describe("OHLCV collector config", () => {
	test("parses subscriptions and defaults the timeframe to 1m", () => {
		expect(
			parseOhlcvCollectorConfig([
				{ exchange: " Binance ", symbol: " BTC/USDT " },
				{ exchange: "kraken", symbol: "ETH/USD", timeframe: "5m" },
			]),
		).toEqual([
			{ exchange: "binance", symbol: "BTC/USDT", timeframe: "1m" },
			{ exchange: "kraken", symbol: "ETH/USD", timeframe: "5m" },
		]);
	});

	test.each([
		{ input: undefined },
		{ input: null },
		{ input: {} },
		{ input: [] },
		{ input: [{ exchange: "binance" }] },
		{ input: [{ exchange: "binance", symbol: "BTC/USDT", extra: true }] },
		{
			input: [
				{ exchange: "binance", symbol: "BTC/USDT" },
				{ exchange: "BINANCE", symbol: "BTC/USDT", timeframe: "1m" },
			],
		},
	])("rejects malformed config fail-closed", ({ input }) => {
		expect(() => parseOhlcvCollectorConfig(input)).toThrow(
			"Invalid OHLCV collector config",
		);
	});

	test("rejects missing and invalid JSON config files", async () => {
		await expect(loadOhlcvCollectorConfig(undefined)).rejects.toThrow(
			`${OHLCV_COLLECTOR_CONFIG_ENV} must point to a JSON file`,
		);

		const path = `${process.cwd()}/test/.ohlcv-collector-invalid-${crypto.randomUUID()}.json`;
		await Bun.write(path, "not-json");
		try {
			await expect(loadOhlcvCollectorConfig(path)).rejects.toThrow(
				"is not valid JSON",
			);
		} finally {
			await Bun.file(path).delete();
		}
	});
});
