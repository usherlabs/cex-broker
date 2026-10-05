import ccxt, { type Exchange } from "ccxt";

type AccountIdEndpoints = {
	privateGetAccount: () => Promise<unknown>;
	privateGetV5UserQueryApi: () => Promise<unknown>;
	spotPrivateGetUid: () => Promise<unknown>;
};

/**
 * Fetches the account identifier of the exchange's API key: the account `uid`
 * on Binance and MEXC, and the API key's `userID` on Bybit. Other exchanges
 * reject with ccxt's NotSupported.
 */
export async function fetchAccountId(
	exchange: Exchange,
): Promise<string | undefined> {
	const endpoints = exchange as unknown as AccountIdEndpoints;
	switch (exchange.id) {
		case "binance":
			return stringField(await endpoints.privateGetAccount(), "uid");
		case "bybit": {
			const response = await endpoints.privateGetV5UserQueryApi();
			return stringField(field(response, "result"), "userID");
		}
		case "mexc":
			return stringField(await endpoints.spotPrivateGetUid(), "uid");
		default:
			throw new ccxt.NotSupported(
				`${exchange.id} fetchAccountId() is not supported yet`,
			);
	}
}

function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function stringField(value: unknown, key: string): string | undefined {
	const result = field(value, key);
	return result === undefined || result === null ? undefined : String(result);
}
