import { describe, expect, test } from "bun:test";
import {
	loadMarketDataCollectorConfig,
	MARKET_DATA_COLLECTOR_CONFIG_ENV,
	parseMarketDataCollectorConfig,
} from "../services/ohlcv-collector/config";

describe("market-data collector config", () => {
	test("validates all four feed supervisors and feed-specific options", () => {
		const parsed = parseMarketDataCollectorConfig({
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

		expect(parsed).toEqual({
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
	});

	test("strictly rejects archive identity fields", () => {
		for (const field of ["captureBundleId", "environment"]) {
			expect(() =>
				parseMarketDataCollectorConfig({
					subscriptions: [
						{
							exchange: "binance",
							symbol: "BTC/USDT",
							feed: "TICKER",
						},
					],
					[field]: field === "captureBundleId" ? "bundle-a" : "production",
				}),
			).toThrow("Invalid market-data collector config");
		}
	});

	test.each([
		{ input: undefined },
		{ input: null },
		{ input: {} },
		{ input: { subscriptions: [] } },
		{
			input: {
				subscriptions: [
					{ exchange: "binance", symbol: "BTC/USDT", feed: "ORDERBOOK" },
				],
			},
		},
		{
			input: {
				subscriptions: [
					{
						exchange: "binance",
						symbol: "BTC/USDT",
						feed: "TICKER",
						extra: true,
					},
				],
			},
		},
		{
			input: {
				subscriptions: [
					{ exchange: "binance", symbol: "BTC/USDT", feed: "TICKER" },
					{ exchange: "BINANCE", symbol: "BTC/USDT", feed: "TICKER" },
				],
			},
		},
	])("rejects malformed config fail-closed", ({ input }) => {
		expect(() => parseMarketDataCollectorConfig(input)).toThrow(
			"Invalid market-data collector config",
		);
	});

	test("exposes only the canonical config environment", () => {
		expect(MARKET_DATA_COLLECTOR_CONFIG_ENV).toBe(
			"CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG",
		);
	});

	test("rejects missing and invalid JSON config files", async () => {
		await expect(loadMarketDataCollectorConfig(undefined)).rejects.toThrow(
			`${MARKET_DATA_COLLECTOR_CONFIG_ENV} must point to a JSON file`,
		);

		const path = `${process.cwd()}/test/.market-data-collector-invalid-${crypto.randomUUID()}.json`;
		await Bun.write(path, "not-json");
		try {
			await expect(loadMarketDataCollectorConfig(path)).rejects.toThrow(
				"is not valid JSON",
			);
		} finally {
			await Bun.file(path).delete();
		}
	});
});
