import { describe, expect, test } from "bun:test";
import ccxt from "@usherlabs/ccxt";

// Guards the @usherlabs/ccxt patch (patches/@usherlabs%2Fccxt@0.0.14.patch)
// hunk on binance.fetchWithdrawals.
//
// Without the guard, an array-shaped SAPI body that is not valid JSON (for
// example a truncated `[{"id":...` body) leaks through the base
// handleRestResponse as a raw string: parseJson returns undefined for it and
// handleRestResponse returns `json || responseBody`. fetchWithdrawals then
// indexes that string and throws `TypeError: Cannot create property 'type' on
// string '['` — the 4,129 identical failures recorded on the SGX broker. The
// patch rejects a non-array response, and array entries that cannot be
// withdrawal objects, with ccxt's typed BadResponse and a bounded shape
// summary instead. Uses the real ccxt binance class so this fails if the
// patch is ever dropped (e.g. on a version bump).

const RAW_ARRAY_SHAPED_BODY =
	'[{"id":"69e53ad305124b96b43668ceab158a18","amount":"28.75","coin":"USDC",';

type Stubbable = Record<string, unknown>;

function createBinance() {
	const exchange = new ccxt.binance({ apiKey: "k", secret: "s" });
	// fetchWithdrawals awaits loadMarkets first; keep the test offline.
	(exchange as unknown as Stubbable).loadMarkets = async () => ({});
	return exchange;
}

function stubWithdrawHistory(
	exchange: InstanceType<typeof ccxt.binance>,
	response: unknown,
) {
	(exchange as unknown as Stubbable).sapiGetCapitalWithdrawHistory =
		async () => response;
}

describe("binance fetchWithdrawals response guard (ccxt patch)", () => {
	test("array-shaped non-JSON body surfaces BadResponse, not a TypeError", async () => {
		const exchange = createBinance();
		// Drive the recorded shape through the real REST boundary so the stub
		// returns exactly what the SAPI call would have returned on rc112.
		let leaked: unknown;
		try {
			leaked = exchange.handleRestResponse(
				{
					status: 200,
					statusText: "OK",
					headers: {},
					data: RAW_ARRAY_SHAPED_BODY,
				},
				"https://api.binance.com/sapi/v1/capital/withdraw/history",
				"GET",
			);
		} catch (error) {
			// A future ccxt that already rejects unparseable bodies at the base
			// boundary satisfies the same typed contract.
			expect(error).toBeInstanceOf(ccxt.BadResponse);
			return;
		}
		expect(typeof leaked).toBe("string");
		stubWithdrawHistory(exchange, leaked);

		let caught: unknown;
		try {
			await exchange.fetchWithdrawals(undefined, undefined, 50);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ccxt.BadResponse);
		const message = (caught as Error).message;
		expect(message).not.toContain("Cannot create property");
		expect(message).toContain("binance fetchWithdrawals()");
		expect(message).toContain("expected a withdrawal array");
		expect(message).toContain(
			`a string of length ${RAW_ARRAY_SHAPED_BODY.length}`,
		);
		// Bounded context: the summary carries at most a 64-character head of
		// the body, never the whole thing.
		expect(message).toContain(JSON.stringify(RAW_ARRAY_SHAPED_BODY.slice(0, 64)));
		expect(message).not.toContain(RAW_ARRAY_SHAPED_BODY);
		expect(message.length).toBeLessThan(320);
	});

	test("non-object array entries surface BadResponse with the index", async () => {
		const exchange = createBinance();
		stubWithdrawHistory(exchange, [
			{ id: "wd-1", coin: "USDC", amount: "1", status: 6 },
			'{"id":"wd-2"',
		]);

		let caught: unknown;
		try {
			await exchange.fetchWithdrawals();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ccxt.BadResponse);
		const message = (caught as Error).message;
		expect(message).not.toContain("Cannot create property");
		expect(message).toContain("expected withdrawal objects");
		expect(message).toContain("entry 1 of 2 is a string of length");
	});

	test("valid withdrawal arrays still parse as withdrawals", async () => {
		const exchange = createBinance();
		stubWithdrawHistory(exchange, [
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
		]);

		const withdrawals = await exchange.fetchWithdrawals();
		expect(withdrawals).toHaveLength(1);
		expect(withdrawals[0]?.type).toBe("withdrawal");
		expect(withdrawals[0]?.id).toBe("69e53ad305124b96b43668ceab158a18");
		expect(withdrawals[0]?.status).toBe("ok");
	});

	test("empty withdrawal arrays still parse to an empty list", async () => {
		const exchange = createBinance();
		stubWithdrawHistory(exchange, []);
		expect(await exchange.fetchWithdrawals()).toEqual([]);
	});
});
