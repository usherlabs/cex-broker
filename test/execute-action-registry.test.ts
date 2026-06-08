import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import {
	ACTION_HANDLERS,
	dispatchExecuteAction,
} from "../src/handlers/execute-action/registry";
import { Action } from "../src/helpers/constants";

const REGISTERED_ACTIONS = [
	Action.Deposit,
	Action.Withdraw,
	Action.Call,
	Action.InternalTransfer,
	Action.CreateOrder,
	Action.GetOrderDetails,
	Action.CancelOrder,
	Action.FetchCurrency,
	Action.FetchAccountId,
	Action.FetchFees,
	Action.FetchDepositAddresses,
	Action.FetchBalances,
	Action.FetchTicker,
] as const;

describe("execute-action registry", () => {
	test("registers all supported ExecuteAction handlers", () => {
		for (const action of REGISTERED_ACTIONS) {
			expect(typeof ACTION_HANDLERS[action]).toBe("function");
		}
	});

	test("rejects invalid actions with a unary callback error and null response", async () => {
		const calls: unknown[][] = [];

		await dispatchExecuteAction({
			action: "InvalidAction",
			wrappedCallback: (...args) => {
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
