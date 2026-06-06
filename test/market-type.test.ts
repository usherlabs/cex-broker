import { describe, expect, test } from "bun:test";
import type { Exchange } from "@usherlabs/ccxt";
import {
	findTradableSymbol,
	parseMarketPattern,
	parseMarketType,
	resolveSubscriptionSymbol,
} from "../src/helpers/market-type";

function createMarket(
	symbol: string,
	type: "spot" | "swap" | "future",
): Record<string, unknown> {
	const [baseQuote, settle] = symbol.split(":");
	const [base, quote] = baseQuote.split("/");
	return {
		symbol,
		base,
		quote,
		type,
		spot: type === "spot",
		swap: type === "swap",
		future: type === "future",
		settle,
	};
}

function createBrokerMock(
	marketDefs: Array<{ symbol: string; type: "spot" | "swap" | "future" }>,
): Exchange {
	const markets = Object.fromEntries(
		marketDefs.map(({ symbol, type }) => [
			symbol,
			createMarket(symbol, type),
		]),
	);
	return {
		markets,
		loadMarkets: async () => markets,
	} as unknown as Exchange;
}

describe("market-type helper", () => {
	test("parseMarketType defaults to spot and accepts perp alias", () => {
		expect(parseMarketType(undefined)).toBe("spot");
		expect(parseMarketType("spot")).toBe("spot");
		expect(parseMarketType("perp")).toBe("swap");
		expect(parseMarketType("swap")).toBe("swap");
		expect(parseMarketType("future")).toBe("future");
	});

	test("parseMarketPattern extracts @swap suffix", () => {
		expect(parseMarketPattern("ETH/USDC@swap")).toEqual({
			symbolPattern: "ETH/USDC",
			requiredMarketType: "swap",
		});
		expect(parseMarketPattern("ETH/USDC")).toEqual({
			symbolPattern: "ETH/USDC",
		});
	});

	test("findTradableSymbol resolves spot markets", async () => {
		const broker = createBrokerMock([
			{ symbol: "ETH/USDC", type: "spot" },
			{ symbol: "ETH/USDC:USDC", type: "swap" },
		]);
		const result = await findTradableSymbol(broker, "ETH", "USDC", "spot");
		expect(result).toEqual({
			symbol: "ETH/USDC",
			side: "sell",
			marketType: "spot",
		});
	});

	test("findTradableSymbol resolves swap markets with settle suffix", async () => {
		const broker = createBrokerMock([
			{ symbol: "ETH/USDC", type: "spot" },
			{ symbol: "ETH/USDC:USDC", type: "swap" },
		]);
		const result = await findTradableSymbol(broker, "ETH", "USDC", "swap");
		expect(result).toEqual({
			symbol: "ETH/USDC:USDC",
			side: "sell",
			marketType: "swap",
		});
	});

	test("resolveSubscriptionSymbol keeps explicit perp symbol", async () => {
		const broker = createBrokerMock([
			{ symbol: "ETH/USDC:USDC", type: "swap" },
		]);
		await expect(
			resolveSubscriptionSymbol(broker, "ETH/USDC:USDC", "swap"),
		).resolves.toBe("ETH/USDC:USDC");
	});

	test("resolveSubscriptionSymbol upgrades bare pair when marketType is swap", async () => {
		const broker = createBrokerMock([
			{ symbol: "ETH/USDC", type: "spot" },
			{ symbol: "ETH/USDC:USDC", type: "swap" },
		]);
		await expect(
			resolveSubscriptionSymbol(broker, "ETH/USDC", "swap"),
		).resolves.toBe("ETH/USDC:USDC");
	});
});