export const ARCHIVE_SMOKE_RPC_METHODS = ["Subscribe"] as const;
export const ARCHIVE_SMOKE_FEEDS = [
	"ORDERBOOK",
	"TICKER",
	"TRADES",
	"OHLCV",
] as const;

const REQUIRED_FEEDS = new Set<string>(ARCHIVE_SMOKE_FEEDS);

/**
 * Fail closed before any live connection is opened. The smoke may exercise
 * only the four public market-data Subscribe paths; ExecuteAction and private
 * account or asset-moving streams are never part of its operation inventory.
 */
export function assertArchiveSmokeSafety(input: {
	rpcMethods: readonly string[];
	feeds: readonly string[];
}): void {
	const feeds = new Set(input.feeds);
	const safe =
		input.rpcMethods.length === 1 &&
		input.rpcMethods[0] === "Subscribe" &&
		input.feeds.length === REQUIRED_FEEDS.size &&
		feeds.size === REQUIRED_FEEDS.size &&
		[...feeds].every((feed) => REQUIRED_FEEDS.has(feed));
	if (!safe) {
		throw new Error(
			"Archive live smoke is limited to all-four public Subscribe operations",
		);
	}
}
