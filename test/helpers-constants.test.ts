import { describe, expect, test } from "bun:test";
import {
	getActionName,
	getSubscriptionTypeName,
	resolveAction,
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

	test("defaults invalid numeric subscription types to ORDERBOOK", () => {
		expect(resolveSubscriptionType(999 as never)).toBe(
			SubscriptionType.ORDERBOOK,
		);
	});

	test("rejects invalid numeric actions", () => {
		expect(resolveAction(999 as never)).toBeUndefined();
	});

	test("returns stable action labels for metrics", () => {
		expect(getActionName(11)).toBe("FetchAccountId");
		expect(getActionName(undefined)).toBe("unknown_undefined");
	});

	test("reports inherited action labels as unknown", () => {
		expect(getActionName("__proto__")).toBe("unknown___proto__");
	});

	test("reports inherited subscription type labels as unknown", () => {
		expect(getSubscriptionTypeName("__proto__")).toBe("unknown___proto__");
	});
});
