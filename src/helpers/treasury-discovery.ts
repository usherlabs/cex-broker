import type { Exchange } from "@usherlabs/ccxt";

export type ExchangeWithDiscovery = Exchange & {
	has?: Record<string, unknown>;
	markets?: Record<string, unknown>;
	currencies?: Record<string, unknown>;
	fetchMarkets?: (...args: unknown[]) => Promise<unknown>;
	fetchCurrencies?: (...args: unknown[]) => Promise<Record<string, unknown>>;
	fetchDeposits?: (
		code?: string,
		since?: number,
		limit?: number,
		params?: Record<string, unknown>,
	) => Promise<Array<Record<string, unknown>>>;
};

export function callArgs(
	args: unknown[] | undefined,
	params: Record<string, unknown> | undefined,
): unknown[] {
	const argsArray = Array.isArray(args) ? [...args] : [];
	if (params && Object.keys(params).length > 0) {
		argsArray.push(params);
	}
	return argsArray;
}

export async function handleTreasuryDiscoveryCall(
	broker: Exchange,
	functionName: string,
	args: unknown[],
	params: Record<string, unknown>,
): Promise<{ handled: true; result: unknown } | { handled: false }> {
	const discoveryBroker = broker as ExchangeWithDiscovery;

	if (functionName === "fetchMarkets") {
		if (
			typeof discoveryBroker.fetchMarkets === "function" &&
			discoveryBroker.has?.fetchMarkets !== false
		) {
			return {
				handled: true,
				result: await discoveryBroker.fetchMarkets(...callArgs(args, params)),
			};
		}
		if (typeof discoveryBroker.loadMarkets === "function") {
			const loaded = await discoveryBroker.loadMarkets(false, params);
			const markets =
				loaded && typeof loaded === "object" && !Array.isArray(loaded)
					? Object.values(loaded as Record<string, unknown>)
					: Object.values(discoveryBroker.markets ?? {});
			return { handled: true, result: markets };
		}
		throw new Error(
			"venue_discovery_unavailable: fetchMarkets unavailable on broker",
		);
	}

	if (functionName === "fetchCurrencies") {
		if (
			typeof discoveryBroker.fetchCurrencies === "function" &&
			discoveryBroker.has?.fetchCurrencies !== false
		) {
			return {
				handled: true,
				result: await discoveryBroker.fetchCurrencies(
					...callArgs(args, params),
				),
			};
		}
		if (
			discoveryBroker.currencies &&
			Object.keys(discoveryBroker.currencies).length > 0
		) {
			return { handled: true, result: discoveryBroker.currencies };
		}
		throw new Error(
			"venue_discovery_unavailable: fetchCurrencies unavailable on broker",
		);
	}

	return { handled: false };
}

export async function fetchCurrencyMetadata(
	broker: Exchange,
	assetCode: string,
): Promise<Record<string, unknown> | undefined> {
	const discoveryBroker = broker as ExchangeWithDiscovery;
	const normalizedAsset = assetCode.trim().toUpperCase();
	if (
		typeof discoveryBroker.fetchCurrencies === "function" &&
		discoveryBroker.has?.fetchCurrencies !== false
	) {
		const currencies = await discoveryBroker.fetchCurrencies();
		// SAFETY: CCXT currency records are JSON-like objects at this adapter boundary.
		return currencies[normalizedAsset] as unknown as
			| Record<string, unknown>
			| undefined;
	}
	// SAFETY: CCXT's cached currency record has the same JSON-like runtime shape.
	return discoveryBroker.currencies?.[normalizedAsset] as unknown as
		| Record<string, unknown>
		| undefined;
}
