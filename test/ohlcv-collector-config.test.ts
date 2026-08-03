import { describe, expect, test } from "bun:test";
import {
	loadOhlcvCollectorConfig,
	MARKET_DATA_COLLECTOR_CONFIG_ENV,
	OHLCV_COLLECTOR_CONFIG_ENV,
	parseMarketDataCollectorConfig,
	parseOhlcvCollectorConfig,
} from "../services/ohlcv-collector/config";

describe("market-data collector config", () => {
	test("validates all four feed supervisors and feed-specific options", () => {
		const parsed = parseMarketDataCollectorConfig({
			captureBundleId: "bundle-2026-08-03",
			environment: "production",
			subscriptions: [
				{
					exchange: " Binance ",
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

		expect(parsed.captureBundleId).toBe("bundle-2026-08-03");
		expect(parsed.subscriptions.map(({ feed }) => feed)).toEqual([
			"ORDERBOOK",
			"TICKER",
			"TRADES",
			"OHLCV",
		]);
		expect(parsed.subscriptions[0]).toMatchObject({
			exchange: "binance",
			depthLimit: 25,
		});
	});

	test.each([
		{
			captureBundleId: "",
			environment: "production",
			subscriptions: [
				{ exchange: "binance", symbol: "BTC/USDT", feed: "TICKER" },
			],
		},
		{
			captureBundleId: "bundle-a",
			environment: "production",
			subscriptions: [
				{ exchange: "binance", symbol: "BTC/USDT", feed: "ORDERBOOK" },
			],
		},
		{
			captureBundleId: "bundle-a",
			environment: "production",
			subscriptions: [
				{ exchange: "binance", symbol: "BTC/USDT", feed: "OHLCV" },
			],
		},
	])("rejects incomplete production feed configuration", (input) => {
		expect(() => parseMarketDataCollectorConfig(input)).toThrow(
			"Invalid market-data collector config",
		);
	});

	test("exposes canonical and legacy config environments", () => {
		expect(MARKET_DATA_COLLECTOR_CONFIG_ENV).toBe(
			"CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG",
		);
		expect(OHLCV_COLLECTOR_CONFIG_ENV).toBe(
			"CEX_BROKER_OHLCV_COLLECTOR_CONFIG",
		);
	});
});

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
