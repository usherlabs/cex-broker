import { describe, expect, test } from "bun:test";
import {
	ORDER_BOOK_CALL_METHODS,
	parseOrderBookCallPayload,
} from "../src/helpers/order-book";

describe("order-book helper parser", () => {
	test("supports depth_limit and construction_mode aliases", () => {
		const payload = parseOrderBookCallPayload(
			{
				method: ORDER_BOOK_CALL_METHODS.FETCH_SNAPSHOT,
				depth_limit: "3",
				construction_mode: "sampled_top_n_snapshot",
			},
			{ exchange: "binance", symbol: "BTC/USDT" },
		);

		expect(payload).toMatchObject({
			kind: "order_book",
			payload: {
				method: ORDER_BOOK_CALL_METHODS.FETCH_SNAPSHOT,
				depthLimit: 3,
				constructionMode: "sampled_top_n_snapshot",
			},
		});
	});

	test("rejects malformed historical cadence", () => {
		const payload = parseOrderBookCallPayload(
			{
				method: ORDER_BOOK_CALL_METHODS.FETCH_HISTORICAL_SNAPSHOTS,
				depthLimit: "5",
				start: "2026-06-02T00:00:00Z",
				end: "2026-06-02T00:01:00Z",
				cadence: "fast",
			},
			{ exchange: "binance", symbol: "BTC/USDT" },
		);

		expect(payload).toMatchObject({
			kind: "error",
			message:
				"ValidationError: cadence must be a positive duration such as 1s",
		});
	});

	test("rejects historical requests where start is after end", () => {
		const payload = parseOrderBookCallPayload(
			{
				method: ORDER_BOOK_CALL_METHODS.FETCH_HISTORICAL_SNAPSHOTS,
				depthLimit: "5",
				start: "2026-06-02T00:02:00Z",
				end: "2026-06-02T00:01:00Z",
				cadence: "1s",
			},
			{ exchange: "binance", symbol: "BTC/USDT" },
		);

		expect(payload).toMatchObject({
			kind: "error",
			message: "ValidationError: start must be before end",
		});
	});
});
