import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import {
	ACTION_DESCRIPTORS,
	dispatchExecuteAction,
	getActionDescriptor,
} from "../src/handlers/execute-action/registry";
import { Action } from "../src/helpers/constants";

const EXECUTABLE_ACTIONS = Object.values(Action).filter(
	(action): action is (typeof Action)[keyof typeof Action] =>
		typeof action === "number" && action !== Action.NoAction,
);

const BATCHABLE_ACTIONS: ReadonlySet<number> = new Set([
	Action.FetchBalances,
	Action.FetchTicker,
	Action.FetchCurrency,
	Action.FetchAccountId,
	Action.FetchFees,
	Action.GetPerpConfigState,
	Action.FetchMarketRules,
]);

describe("execute-action registry", () => {
	test("classifies every executable action", () => {
		for (const action of EXECUTABLE_ACTIONS) {
			const descriptor = getActionDescriptor(action);
			expect(descriptor).toBeDefined();
			expect(typeof descriptor?.handler).toBe("function");
			expect(["read", "write"]).toContain(descriptor?.access);
		}
		expect(Object.keys(ACTION_DESCRIPTORS)).toHaveLength(
			EXECUTABLE_ACTIONS.length,
		);
	});

	test("derives the exact v1 batchable set from descriptors", () => {
		for (const action of EXECUTABLE_ACTIONS) {
			const descriptor = getActionDescriptor(action);
			expect(descriptor?.batchable).toBe(BATCHABLE_ACTIONS.has(action));
			if (descriptor?.batchable) {
				expect(descriptor.access).toBe("read");
				expect(typeof descriptor.validateBatchRequest).toBe("function");
			}
		}
	});

	test("rejects invalid actions with a unary callback error and null response", async () => {
		const calls: unknown[][] = [];

		await dispatchExecuteAction({
			action: "InvalidAction",
			wrappedCallback: (...args: unknown[]) => {
				calls.push(args);
			},
		} as unknown as Parameters<typeof dispatchExecuteAction>[0]);

		expect(calls).toEqual([
			[
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: "Invalid Action",
				},
				null,
			],
		]);
	});
});
