import ccxt, { type Exchange } from "ccxt";

type BinanceWithdrawHistoryEndpoint = {
	sapiGetCapitalWithdrawHistory: (
		params?: Record<string, unknown>,
	) => Promise<unknown>;
};

/**
 * Rejects malformed Binance withdrawal-history responses with ccxt's typed
 * BadResponse instead of letting fetchWithdrawals misread them.
 *
 * An array-shaped SAPI body that is not valid JSON (for example a truncated
 * `[{"id":...` body) reaches ccxt as a raw string. ccxt's fetchWithdrawals
 * parses it leniently and reports no withdrawals, which would hide pending
 * withdrawals from reconciliation. The check runs on the endpoint's result,
 * before ccxt parses it. No-op for non-Binance exchanges.
 */
export function guardBinanceWithdrawalHistory(exchange: Exchange): void {
	if (exchange.id !== "binance") {
		return;
	}
	const endpoint = exchange as unknown as BinanceWithdrawHistoryEndpoint;
	const request = endpoint.sapiGetCapitalWithdrawHistory.bind(exchange);
	endpoint.sapiGetCapitalWithdrawHistory = async (params) => {
		const response = await request(params);
		if (!Array.isArray(response)) {
			throw new ccxt.BadResponse(
				`binance fetchWithdrawals() expected a withdrawal array from sapi but received ${describeUnexpectedResponse(response)}`,
			);
		}
		response.forEach((entry: unknown, index) => {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				throw new ccxt.BadResponse(
					`binance fetchWithdrawals() expected withdrawal objects from sapi but entry ${index} of ${response.length} is ${describeUnexpectedResponse(entry)}`,
				);
			}
		});
		return response;
	};
}

/**
 * Bounded single-line shape summary for BadResponse diagnostics. Never the
 * full body: at most the first 64 characters of a string.
 */
function describeUnexpectedResponse(value: unknown): string {
	if (value === undefined) {
		return "undefined";
	}
	if (value === null) {
		return "null";
	}
	if (typeof value === "string") {
		const head = value.slice(0, 64).replace(/\s+/g, " ");
		return `a string of length ${value.length} starting with ${JSON.stringify(head)}`;
	}
	if (Array.isArray(value)) {
		return `an array of length ${value.length}`;
	}
	if (typeof value === "object") {
		return `an object with keys ${JSON.stringify(Object.keys(value).slice(0, 8))}`;
	}
	return `a ${typeof value} ${String(value).slice(0, 64)}`;
}
