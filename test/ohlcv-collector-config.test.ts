import { describe, expect, test } from "bun:test";
import {
	COLLECTOR_BROKER_URL_ENV,
	loadCollectorBrokerUrl,
	loadMarketDataCollectorConfig,
	loadOhlcvCollectorConfig,
	MARKET_DATA_COLLECTOR_CONFIG_ENV,
	OHLCV_COLLECTOR_CONFIG_ENV,
	parseCollectorBrokerUrl,
	parseMarketDataCollectorConfig,
	parseOhlcvCollectorConfig,
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

	test.each([
		{
			environment: "production",
			subscriptions: [
				{ exchange: "binance", symbol: "BTC/USDT", feed: "TICKER" },
			],
		},
		{
			captureBundleId: "bundle-a",
			subscriptions: [
				{ exchange: "binance", symbol: "BTC/USDT", feed: "TICKER" },
			],
		},
		{
			subscriptions: [
				{ exchange: "binance", symbol: "BTC/USDT", feed: "ORDERBOOK" },
			],
		},
		{
			subscriptions: [
				{ exchange: "binance", symbol: "BTC/USDT", feed: "OHLCV" },
			],
		},
	])("rejects collector-owned identity or incomplete feed configuration", (input) => {
		expect(() => parseMarketDataCollectorConfig(input)).toThrow(
			"Invalid market-data collector config",
		);
	});

	test.each([
		{ input: undefined },
		{ input: null },
		{ input: {} },
		{ input: { subscriptions: [] } },
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

	test("exposes canonical and legacy config environments", () => {
		expect(MARKET_DATA_COLLECTOR_CONFIG_ENV).toBe(
			"CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG",
		);
		expect(OHLCV_COLLECTOR_CONFIG_ENV).toBe(
			"CEX_BROKER_OHLCV_COLLECTOR_CONFIG",
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

describe("collector broker target", () => {
	test.each([
		"broker.internal:8086",
		"127.0.0.1:8086",
		"[2001:db8::1]:8086",
	])("accepts a gRPC authority: %s", (value) => {
		expect(parseCollectorBrokerUrl(value)).toBe(value);
	});

	test.each([
		undefined,
		"",
		"broker.internal",
		"http://broker.internal:8086",
		"broker.internal:0",
		"broker.internal:65536",
		"[2001:db8::1]",
	])("rejects a missing or malformed gRPC authority: %s", (value) => {
		expect(() => parseCollectorBrokerUrl(value)).toThrow(
			COLLECTOR_BROKER_URL_ENV,
		);
	});

	test("loads the target from the collector-only environment variable", () => {
		expect(COLLECTOR_BROKER_URL_ENV).toBe("CEX_BROKER_URL");
		expect(loadCollectorBrokerUrl(" broker.internal:8086 ")).toBe(
			"broker.internal:8086",
		);
	});
});

describe("OHLCV collector compatibility config", () => {
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
	])("rejects malformed compatibility config fail-closed", ({ input }) => {
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
