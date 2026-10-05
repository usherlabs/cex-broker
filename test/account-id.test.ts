import { describe, expect, test } from "bun:test";
import ccxt from "ccxt";
import { fetchAccountId } from "../src/helpers/account-id";
import { createBroker } from "../src/helpers/broker";

function brokerAnswering(cex: string, urls: string[], body: unknown) {
	const exchange = createBroker(cex, { apiKey: "k", apiSecret: "s" });
	if (!exchange) throw new Error(`${cex} broker was not created`);
	exchange.fetchImplementation = async (url: string) => {
		urls.push(url);
		return Response.json(body);
	};
	return exchange;
}

describe("fetchAccountId", () => {
	test.each([
		[
			"binance",
			"https://api.binance.com/api/v3/account?",
			{ uid: 354937868, balances: [] },
			"354937868",
		],
		[
			"bybit",
			"https://api.bybit.com/v5/user/query-api?",
			{ retCode: 0, retMsg: "", result: { userID: 24617703, id: "13770661" } },
			"24617703",
		],
		[
			"mexc",
			"https://api.mexc.com/api/v3/uid?",
			{ uid: "29276000" },
			"29276000",
		],
	])("reads the %s account id from its account endpoint", async (cex, endpoint, body, accountId) => {
		const urls: string[] = [];
		const exchange = brokerAnswering(cex, urls, body);
		expect(await fetchAccountId(exchange)).toBe(accountId);
		expect(urls).toHaveLength(1);
		expect(urls[0]).toStartWith(endpoint);
	});

	test("rejects other exchanges with NotSupported before any request", async () => {
		const urls: string[] = [];
		const exchange = brokerAnswering("kraken", urls, {});
		await expect(fetchAccountId(exchange)).rejects.toBeInstanceOf(
			ccxt.NotSupported,
		);
		expect(urls).toEqual([]);
	});
});
