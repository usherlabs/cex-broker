import type { Exchange } from "@usherlabs/ccxt";

export type BrokerMarketType = "spot" | "swap" | "future";

export type TradableSymbolMatch = {
	symbol: string;
	side: "buy" | "sell";
	marketType: BrokerMarketType;
};

type CcxtMarket = {
	symbol?: string;
	base?: string;
	quote?: string;
	type?: string;
	spot?: boolean;
	swap?: boolean;
	future?: boolean;
};

export function parseMarketType(value: unknown): BrokerMarketType {
	if (typeof value !== "string") {
		return "spot";
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "swap" || normalized === "perp") {
		return "swap";
	}
	if (normalized === "future" || normalized === "futures") {
		return "future";
	}
	return "spot";
}

export function marketTypeToCcxtType(
	marketType: BrokerMarketType,
): "spot" | "swap" | "future" {
	return marketType;
}

function marketMatchesType(
	market: CcxtMarket,
	marketType: BrokerMarketType,
): boolean {
	if (marketType === "spot") {
		return market.spot === true || market.type === "spot";
	}
	if (marketType === "swap") {
		return market.swap === true || market.type === "swap";
	}
	return market.future === true || market.type === "future";
}

function findMarketByPair(
	markets: Record<string, CcxtMarket>,
	fromToken: string,
	toToken: string,
	marketType: BrokerMarketType,
	preferSide: "sell" | "buy",
): TradableSymbolMatch | null {
	const directPair = `${fromToken}/${toToken}`;
	const reversePair = `${toToken}/${fromToken}`;
	const orderedPairs =
		preferSide === "sell"
			? [directPair, reversePair]
			: [reversePair, directPair];

	for (const pair of orderedPairs) {
		for (const market of Object.values(markets)) {
			if (!market?.symbol) {
				continue;
			}
			const marketBase = market.base?.toUpperCase();
			const marketQuote = market.quote?.toUpperCase();
			const [pairBase, pairQuote] = pair.split("/");
			if (marketBase !== pairBase || marketQuote !== pairQuote) {
				continue;
			}
			if (!marketMatchesType(market, marketType)) {
				continue;
			}
			return {
				symbol: market.symbol,
				side: pair === directPair ? "sell" : "buy",
				marketType,
			};
		}
	}

	return null;
}

export async function findTradableSymbol(
	broker: Exchange,
	fromToken: string,
	toToken: string,
	marketType: BrokerMarketType = "spot",
): Promise<TradableSymbolMatch | null> {
	const fromUpper = fromToken.trim().toUpperCase();
	const toUpper = toToken.trim().toUpperCase();
	await broker.loadMarkets();
	const markets = (broker as Exchange & { markets?: Record<string, CcxtMarket> })
		.markets;
	if (!markets || typeof markets !== "object") {
		return null;
	}

	const direct = findMarketByPair(markets, fromUpper, toUpper, marketType, "sell");
	if (direct) {
		return direct;
	}

	return findMarketByPair(markets, fromUpper, toUpper, marketType, "buy");
}

export async function resolveSubscriptionSymbol(
	broker: Exchange,
	symbol: string,
	marketTypeInput: unknown,
): Promise<string> {
	const trimmed = symbol.trim();
	if (trimmed.includes(":")) {
		return trimmed;
	}
	if (!trimmed.includes("/")) {
		return trimmed;
	}

	const marketType = parseMarketType(marketTypeInput);
	if (marketType === "spot") {
		return trimmed;
	}

	const [base, quote] = trimmed.split("/");
	if (!base || !quote) {
		return trimmed;
	}

	const match = await findTradableSymbol(broker, base, quote, marketType);
	return match?.symbol ?? trimmed;
}

export type ParsedMarketPattern = {
	symbolPattern: string;
	requiredMarketType?: BrokerMarketType;
};

export function parseMarketPattern(symbolPattern: string): ParsedMarketPattern {
	const atIndex = symbolPattern.lastIndexOf("@");
	if (atIndex <= 0) {
		return { symbolPattern };
	}

	const basePattern = symbolPattern.slice(0, atIndex);
	const suffix = symbolPattern.slice(atIndex + 1).trim().toLowerCase();
	if (suffix === "spot" || suffix === "swap" || suffix === "perp" || suffix === "future" || suffix === "futures") {
		return {
			symbolPattern: basePattern,
			requiredMarketType: parseMarketType(suffix),
		};
	}

	return { symbolPattern };
}