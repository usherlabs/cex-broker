export type PublicFeedName = "ORDERBOOK" | "TICKER" | "TRADES" | "OHLCV";

export type PublicFeedKeyInput = {
	exchange: string;
	symbol: string;
	marketType: string;
	feed: PublicFeedName;
	acquisitionProfileId?: string;
	timeframe?: string;
};

export function normalizePublicExchange(exchange: string): string {
	return exchange.trim().toLowerCase();
}

export function resolvePublicOhlcvTimeframe(
	timeframe: string | undefined,
): string {
	return timeframe?.trim() || "1m";
}

export function buildPublicFeedKey(input: PublicFeedKeyInput): string {
	const common = [
		normalizePublicExchange(input.exchange),
		input.symbol,
		input.marketType,
		input.feed,
	];
	if (input.feed === "ORDERBOOK") {
		if (!input.acquisitionProfileId) {
			throw new Error("ORDERBOOK public feed identity requires a profile");
		}
		common.push(input.acquisitionProfileId);
	}
	if (input.feed === "OHLCV") {
		common.push(resolvePublicOhlcvTimeframe(input.timeframe));
	}
	return common.join("|");
}
