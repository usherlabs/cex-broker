import * as grpc from "@grpc/grpc-js";
import type { z } from "zod";
import { Action, type Action as ActionType } from "../../helpers/constants";
import { parsePayload } from "../../helpers/grpc/payload";
import {
	EmptyActionPayloadSchema,
	FetchCurrencyPayloadSchema,
	FetchFeesPayloadSchema,
	GetPerpConfigStatePayloadSchema,
} from "../../schemas/action-payloads";
import { handleBatch } from "./batch";
import type {
	ActionDescriptor,
	ActionRequestValidation,
	ExecuteActionContext,
} from "./context";
import { handleDeposit } from "./deposit";
import { handleInternalTransfer } from "./internal-transfer";
import { handleOrders } from "./orders";
import { handlePassThrough } from "./pass-through";
import { handlePerpConfig } from "./perp-config";
import { handleTreasuryCall } from "./treasury-call";
import { handleWithdraw } from "./withdraw";

function valid(): ActionRequestValidation {
	return { valid: true };
}

function requireSymbol(
	request: ExecuteActionContext["call"]["request"],
): ActionRequestValidation {
	return request.symbol?.trim()
		? valid()
		: { valid: false, message: "symbol is required" };
}

function requireSpotSymbol(
	request: ExecuteActionContext["call"]["request"],
): ActionRequestValidation {
	const symbol = request.symbol?.trim() ?? "";
	return /^[^/\s]+\/[^/\s]+$/.test(symbol)
		? valid()
		: {
				valid: false,
				message: "symbol must be a slash-delimited spot pair",
			};
}

function validatePayload<T>(
	schema: z.ZodType<T>,
	request: ExecuteActionContext["call"]["request"],
): ActionRequestValidation {
	const parsed = parsePayload(schema, request.payload);
	return parsed.success ? valid() : { valid: false, message: parsed.message };
}

function validateSymbolAndPayload<T>(schema: z.ZodType<T>) {
	return (
		request: ExecuteActionContext["call"]["request"],
	): ActionRequestValidation => {
		const symbolValidation = requireSymbol(request);
		return symbolValidation.valid
			? validatePayload(schema, request)
			: symbolValidation;
	};
}

function validateSpotSymbolAndPayload<T>(schema: z.ZodType<T>) {
	return (
		request: ExecuteActionContext["call"]["request"],
	): ActionRequestValidation => {
		const symbolValidation = requireSpotSymbol(request);
		return symbolValidation.valid
			? validatePayload(schema, request)
			: symbolValidation;
	};
}

function validateFetchBalances(
	request: ExecuteActionContext["call"]["request"],
): ActionRequestValidation {
	const balanceType = request.payload?.balanceType;
	if (
		balanceType !== undefined &&
		!new Set(["free", "used", "total"]).has(balanceType)
	) {
		return {
			valid: false,
			message: "balanceType must be free, used, or total",
		};
	}
	return valid();
}

/** Authoritative ExecuteAction metadata. Batch eligibility is derived only from this registry. */
export const ACTION_DESCRIPTORS: Partial<Record<ActionType, ActionDescriptor>> =
	{
		[Action.Deposit]: {
			handler: handleDeposit,
			access: "write",
			batchable: false,
		},
		[Action.Withdraw]: {
			handler: handleWithdraw,
			access: "write",
			batchable: false,
		},
		[Action.Call]: {
			handler: handleTreasuryCall,
			access: "write",
			batchable: false,
		},
		[Action.InternalTransfer]: {
			handler: handleInternalTransfer,
			access: "write",
			batchable: false,
		},
		[Action.CreateOrder]: {
			handler: handleOrders,
			access: "write",
			batchable: false,
		},
		[Action.GetOrderDetails]: {
			handler: handleOrders,
			access: "read",
			batchable: false,
		},
		[Action.CancelOrder]: {
			handler: handleOrders,
			access: "write",
			batchable: false,
		},
		[Action.FetchCurrency]: {
			handler: handlePassThrough,
			access: "read",
			batchable: true,
			validateBatchRequest: validateSymbolAndPayload(
				FetchCurrencyPayloadSchema,
			),
		},
		[Action.FetchAccountId]: {
			handler: handlePassThrough,
			access: "read",
			batchable: true,
			validateBatchRequest: (request) =>
				validatePayload(EmptyActionPayloadSchema, request),
		},
		[Action.FetchFees]: {
			handler: handlePassThrough,
			access: "read",
			batchable: true,
			validateBatchRequest: validateSpotSymbolAndPayload(
				FetchFeesPayloadSchema,
			),
		},
		[Action.FetchDepositAddresses]: {
			handler: handlePassThrough,
			access: "read",
			batchable: false,
		},
		[Action.FetchBalances]: {
			handler: handlePassThrough,
			access: "read",
			batchable: true,
			validateBatchRequest: validateFetchBalances,
		},
		[Action.FetchTicker]: {
			handler: handlePassThrough,
			access: "read",
			batchable: true,
			validateBatchRequest: validateSymbolAndPayload(EmptyActionPayloadSchema),
		},
		[Action.GetPerpConfigState]: {
			handler: handlePerpConfig,
			access: "read",
			batchable: true,
			validateBatchRequest: (request) =>
				validatePayload(GetPerpConfigStatePayloadSchema, request),
		},
		[Action.SetPerpConfigState]: {
			handler: handlePerpConfig,
			access: "write",
			batchable: false,
		},
		[Action.FetchMarketRules]: {
			handler: handlePassThrough,
			access: "read",
			batchable: true,
			validateBatchRequest: validateSpotSymbolAndPayload(
				EmptyActionPayloadSchema,
			),
		},
		[Action.Batch]: {
			handler: (ctx) => handleBatch(ctx, getActionDescriptor),
			access: "read",
			batchable: false,
		},
	};

export function getActionDescriptor(
	action: ActionType,
): ActionDescriptor | undefined {
	return ACTION_DESCRIPTORS[action];
}

export async function dispatchExecuteAction(
	ctx: ExecuteActionContext,
): Promise<void> {
	const descriptor = getActionDescriptor(ctx.action);
	if (!descriptor) {
		ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: "Invalid Action",
			},
			null,
		);
		return;
	}
	await descriptor.handler(ctx);
}
