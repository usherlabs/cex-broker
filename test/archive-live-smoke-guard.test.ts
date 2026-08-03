import { describe, expect, test } from "bun:test";
import {
	ARCHIVE_SMOKE_FEEDS,
	ARCHIVE_SMOKE_RPC_METHODS,
	assertArchiveSmokeSafety,
} from "../scripts/archive-live-smoke-contract";

describe("archive live-smoke safety contract", () => {
	test("permits only public Subscribe operations for all four feeds", () => {
		expect(ARCHIVE_SMOKE_RPC_METHODS).toEqual(["Subscribe"]);
		expect(ARCHIVE_SMOKE_FEEDS).toEqual([
			"ORDERBOOK",
			"TICKER",
			"TRADES",
			"OHLCV",
		]);
		expect(() =>
			assertArchiveSmokeSafety({
				rpcMethods: ARCHIVE_SMOKE_RPC_METHODS,
				feeds: ARCHIVE_SMOKE_FEEDS,
			}),
		).not.toThrow();
	});

	test("rejects ExecuteAction, private feeds, missing feeds, and duplicates", () => {
		for (const unsafe of [
			{
				rpcMethods: ["Subscribe", "ExecuteAction"],
				feeds: ARCHIVE_SMOKE_FEEDS,
			},
			{ rpcMethods: ["Subscribe"], feeds: ["ORDERBOOK", "ORDERS"] },
			{ rpcMethods: ["Subscribe"], feeds: ["ORDERBOOK", "TICKER", "TRADES"] },
			{
				rpcMethods: ["Subscribe"],
				feeds: ["ORDERBOOK", "TICKER", "TRADES", "OHLCV", "OHLCV"],
			},
		]) {
			expect(() => assertArchiveSmokeSafety(unsafe)).toThrow(
				"public Subscribe operations",
			);
		}
	});
});
