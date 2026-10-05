import { describe, expect, test } from "bun:test";
import ccxt, { type Exchange } from "ccxt";
import { createBroker } from "../src/helpers/broker";

// Guards guardBinanceWithdrawalHistory, installed on every broker exchange.
//
// An array-shaped SAPI body that is not valid JSON (for example a truncated
// `[{"id":...` body) reaches ccxt as a raw string. Before the guard it failed
// with `TypeError: Cannot create property 'type' on string '['` — the 4,129
// identical failures recorded on the SGX broker; current ccxt instead parses
// it leniently and reports no withdrawals. The guard rejects a non-array
// response, and array entries that cannot be withdrawal objects, with ccxt's
// typed BadResponse and a bounded shape summary. The bodies go through the
// real ccxt REST boundary via the exchange's fetch implementation.

const RAW_ARRAY_SHAPED_BODY =
	'[{"id":"69e53ad305124b96b43668ceab158a18","amount":"28.75","coin":"USDC",';

type Stubbable = Record<string, unknown>;

function createBinanceAnswering(body: string): Exchange {
	const exchange = createBroker("binance", { apiKey: "k", apiSecret: "s" });
	if (!exchange) throw new Error("binance broker was not created");
	// fetchWithdrawals awaits loadMarkets first; keep the test offline.
	(exchange as unknown as Stubbable).loadMarkets = async () => ({});
	exchange.fetchImplementation = async (url: string) => {
		expect(url).toStartWith(
			"https://api.binance.com/sapi/v1/capital/withdraw/history",
		);
		return new Response(body, {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	return exchange;
}

async function withdrawalsError(exchange: Exchange): Promise<Error> {
	try {
		await exchange.fetchWithdrawals(undefined, undefined, 50);
	} catch (error) {
		return error as Error;
	}
	throw new Error("fetchWithdrawals resolved");
}

describe("binance fetchWithdrawals response guard", () => {
	test("array-shaped non-JSON body surfaces BadResponse with a bounded summary", async () => {
		const error = await withdrawalsError(
			createBinanceAnswering(RAW_ARRAY_SHAPED_BODY),
		);
		expect(error).toBeInstanceOf(ccxt.BadResponse);
		const message = error.message;
		expect(message).toContain(
			"binance fetchWithdrawals() expected a withdrawal array",
		);
		expect(message).toContain(
			`a string of length ${RAW_ARRAY_SHAPED_BODY.length}`,
		);
		// Bounded context: at most a 64-character head of the body.
		expect(message).toContain(
			JSON.stringify(RAW_ARRAY_SHAPED_BODY.slice(0, 64)),
		);
		expect(message).not.toContain(RAW_ARRAY_SHAPED_BODY);
		expect(message.length).toBeLessThan(320);
	});

	test("non-object array entries surface BadResponse with the index", async () => {
		const error = await withdrawalsError(
			createBinanceAnswering(
				JSON.stringify([
					{ id: "wd-1", coin: "USDC", amount: "1", status: 6 },
					'{"id":"wd-2"',
				]),
			),
		);
		expect(error).toBeInstanceOf(ccxt.BadResponse);
		expect(error.message).toContain("expected withdrawal objects");
		expect(error.message).toContain("entry 1 of 2 is a string of length");
	});

	test("valid withdrawal arrays still parse as withdrawals", async () => {
		const exchange = createBinanceAnswering(
			JSON.stringify([
				{
					id: "69e53ad305124b96b43668ceab158a18",
					amount: "28.75",
					transactionFee: "0.25",
					coin: "USDC",
					status: 6,
					address: "0x0AB991497116f7F5532a4c2f4f7B1784488628e1",
					txId: "0x77fbf2cf2c85b552f0fd31fd2e56dc95c08adae031d96f3717d8b17e1aea3e46",
					applyTime: "2021-04-15 12:09:16",
					network: "ARBITRUM",
					transferType: 0,
				},
			]),
		);
		const withdrawals = await exchange.fetchWithdrawals();
		expect(withdrawals).toHaveLength(1);
		expect(withdrawals[0]?.type).toBe("withdrawal");
		expect(withdrawals[0]?.id).toBe("69e53ad305124b96b43668ceab158a18");
		expect(withdrawals[0]?.status).toBe("ok");
	});

	test("empty withdrawal arrays still parse to an empty list", async () => {
		const exchange = createBinanceAnswering("[]");
		expect(await exchange.fetchWithdrawals()).toEqual([]);
	});
});
