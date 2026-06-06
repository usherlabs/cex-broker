import * as grpc from "@grpc/grpc-js";
import { Action, type Action as ActionType } from "../../helpers/constants";
import type { ActionHandler, ExecuteActionContext } from "./context";
import { handleDeposit } from "./deposit";
import { handleInternalTransfer } from "./internal-transfer";
import { handleOrders } from "./orders";
import { handlePassThrough } from "./pass-through";
import { handleTreasuryCall } from "./treasury-call";
import { handlePerpConfig } from "./perp-config";
import { handleWithdraw } from "./withdraw";

/** Maps each ExecuteAction to its handler module. Cluster routers (orders, pass-through) are registered per action. */
export const ACTION_HANDLERS: Partial<Record<ActionType, ActionHandler>> = {
	[Action.Deposit]: handleDeposit,
	[Action.Withdraw]: handleWithdraw,
	[Action.Call]: handleTreasuryCall,
	[Action.InternalTransfer]: handleInternalTransfer,
	[Action.CreateOrder]: handleOrders,
	[Action.GetOrderDetails]: handleOrders,
	[Action.CancelOrder]: handleOrders,
	[Action.FetchCurrency]: handlePassThrough,
	[Action.FetchAccountId]: handlePassThrough,
	[Action.FetchFees]: handlePassThrough,
	[Action.FetchDepositAddresses]: handlePassThrough,
	[Action.FetchBalances]: handlePassThrough,
	[Action.FetchTicker]: handlePassThrough,
	[Action.GetPerpConfigState]: handlePerpConfig,
	[Action.SetPerpConfigState]: handlePerpConfig,
};

export async function dispatchExecuteAction(
	ctx: ExecuteActionContext,
): Promise<void> {
	const handler = ACTION_HANDLERS[ctx.action];
	if (!handler) {
		ctx.wrappedCallback({
			code: grpc.status.INVALID_ARGUMENT,
			message: "Invalid Action",
		});
		return;
	}
	await handler(ctx);
}
