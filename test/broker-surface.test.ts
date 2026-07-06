import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import {
	buildBrokerSurfaceDeniedError,
	classifyAction,
	classifyCcxtMethod,
	classifySubscription,
	isBrokerAccessAllowed,
	resolveBrokerSurfaceFromEnv,
	validateBrokerSurface,
} from "../src/helpers/broker-surface";
import { Action, SubscriptionType } from "../src/helpers/constants";

describe("broker surface classification", () => {
	test("classifies mutating ExecuteAction values as write", () => {
		expect(classifyAction(Action.CreateOrder)).toBe("write");
		expect(classifyAction(Action.CancelOrder)).toBe("write");
		expect(classifyAction(Action.Withdraw)).toBe("write");
		expect(classifyAction(Action.Deposit)).toBe("write");
		expect(classifyAction(Action.InternalTransfer)).toBe("write");
		expect(classifyAction(Action.SetPerpConfigState)).toBe("write");
	});

	test("classifies fetch-style ExecuteAction values as read", () => {
		expect(classifyAction(Action.FetchBalances)).toBe("read");
		expect(classifyAction(Action.FetchTicker)).toBe("read");
		expect(classifyAction(Action.GetOrderDetails)).toBe("read");
		expect(classifyAction(Action.GetPerpConfigState)).toBe("read");
	});

	test("classifies Call separately for CCXT dispatch", () => {
		expect(classifyAction(Action.Call)).toBe("call");
	});

	test("classifies user stream subscriptions as write and market streams as read", () => {
		expect(classifySubscription(SubscriptionType.ORDERS)).toBe("write");
		expect(classifySubscription(SubscriptionType.BALANCE)).toBe("write");
		expect(classifySubscription(SubscriptionType.ORDERBOOK)).toBe("read");
		expect(classifySubscription(SubscriptionType.OHLCV)).toBe("read");
	});

	test("classifies CCXT method names for Action.Call", () => {
		expect(classifyCcxtMethod("fetchBalance")).toBe("read");
		expect(classifyCcxtMethod("fetch_order_book_snapshot")).toBe("read");
		expect(classifyCcxtMethod("createOrder")).toBe("write");
		expect(classifyCcxtMethod("withdraw")).toBe("write");
		expect(classifyCcxtMethod("customBrokerMethod")).toBe("unknown");
	});
});

describe("broker surface guards", () => {
	test("denies read or write access based on deployment flags", () => {
		const readOnly = { readEnabled: true, writeEnabled: false };
		const writeOnly = { readEnabled: false, writeEnabled: true };

		expect(isBrokerAccessAllowed(readOnly, "read")).toBe(true);
		expect(isBrokerAccessAllowed(readOnly, "write")).toBe(false);
		expect(isBrokerAccessAllowed(writeOnly, "read")).toBe(false);
		expect(isBrokerAccessAllowed(writeOnly, "write")).toBe(true);
		expect(isBrokerAccessAllowed(readOnly, "unknown")).toBe(false);
		expect(isBrokerAccessAllowed(writeOnly, "unknown")).toBe(false);
		expect(
			isBrokerAccessAllowed(
				{ readEnabled: true, writeEnabled: true },
				"unknown",
			),
		).toBe(true);
	});

	test("builds FAILED_PRECONDITION errors for disabled surfaces", () => {
		expect(buildBrokerSurfaceDeniedError("read")).toEqual({
			code: grpc.status.FAILED_PRECONDITION,
			message: "Read operations are disabled on this broker deployment",
		});
		expect(buildBrokerSurfaceDeniedError("write")).toEqual({
			code: grpc.status.FAILED_PRECONDITION,
			message: "Write operations are disabled on this broker deployment",
		});
	});

	test("requires at least one enabled surface", () => {
		expect(() =>
			validateBrokerSurface({ readEnabled: false, writeEnabled: false }),
		).toThrow(/at least one broker surface/i);
	});

	test("defaults both surfaces to enabled from env", () => {
		const previousRead = process.env.CEX_BROKER_READ_ENABLED;
		const previousWrite = process.env.CEX_BROKER_WRITE_ENABLED;
		delete process.env.CEX_BROKER_READ_ENABLED;
		delete process.env.CEX_BROKER_WRITE_ENABLED;

		try {
			expect(resolveBrokerSurfaceFromEnv()).toEqual({
				readEnabled: true,
				writeEnabled: true,
			});
		} finally {
			if (previousRead === undefined) {
				delete process.env.CEX_BROKER_READ_ENABLED;
			} else {
				process.env.CEX_BROKER_READ_ENABLED = previousRead;
			}
			if (previousWrite === undefined) {
				delete process.env.CEX_BROKER_WRITE_ENABLED;
			} else {
				process.env.CEX_BROKER_WRITE_ENABLED = previousWrite;
			}
		}
	});
});
