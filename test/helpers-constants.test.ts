import { describe, expect, test } from "bun:test";
import {
	getActionName,
	resolveSubscriptionType,
	SubscriptionType,
} from "../src/helpers/constants";

describe("Helper Constants", () => {
	test("defaults omitted subscription types to ORDERBOOK", () => {
		expect(resolveSubscriptionType(undefined)).toBe(SubscriptionType.ORDERBOOK);
		expect(resolveSubscriptionType(SubscriptionType.NO_ACTION)).toBe(
			SubscriptionType.ORDERBOOK,
		);
	});

	test("preserves explicit subscription types", () => {
		expect(resolveSubscriptionType(SubscriptionType.TRADES)).toBe(
			SubscriptionType.TRADES,
		);
	});

	test("returns stable action labels for metrics", () => {
		expect(getActionName(11)).toBe("FetchAccountId");
		expect(getActionName(undefined)).toBe("unknown_undefined");
	});
});
