import { describe, expect, test } from "bun:test";
import { ACTION_HANDLERS } from "../src/handlers/execute-action/registry";
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
});
