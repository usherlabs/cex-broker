import * as grpc from "@grpc/grpc-js";
import { validateDeposit } from "../../helpers";
import { Action } from "../../helpers/constants";
import { stableGrpcErrorCode } from "../../helpers/grpc/status";
import {
	marketTypeToCcxtType,
	parseMarketType,
} from "../../helpers/market-type";
import { getErrorMessage, safeLogError } from "../../helpers/shared/errors";
import {
	resolveTransferNetwork,
	type TransferNetworkResolution,
} from "../../helpers/transfer-network";
import { FetchDepositAddressesPayloadSchema } from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import { parsePayloadForAction } from "./context";
import {
	handleFetchCurrencyEvidence,
	handleFetchFeesEvidence,
	handleFetchMarketRulesEvidence,
} from "./venue-evidence";

async function handleFetchAccountId(ctx: ExecuteActionContext): Promise<void> {
	const { cex, broker } = ctx;

	try {
		const accountId = await broker.fetchAccountId();
		// Return normalized response
		return ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify({ accountId }),
		});
	} catch (error) {
		safeLogError(`Error fetching account ID ${cex}`, error);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: `Error fetching account ID from ${cex}`,
			},
			null,
		);
	}
}

async function handleFetchDepositAddresses(
	ctx: ExecuteActionContext,
): Promise<void> {
	const { policy, cex, symbol, broker } = ctx;

	if (!symbol) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `ValidationError: Symbol required`,
			},
			null,
		);
	}
	const fetchDepositAddresses = parsePayloadForAction(
		ctx,
		FetchDepositAddressesPayloadSchema,
	);
	if (fetchDepositAddresses === null) return;
	let depositNetwork: TransferNetworkResolution;
	try {
		depositNetwork = await resolveTransferNetwork(
			broker,
			symbol,
			fetchDepositAddresses.chain,
		);
	} catch (error) {
		const message = getErrorMessage(error);
		return ctx.wrappedCallback(
			{
				code: stableGrpcErrorCode(message) ?? grpc.status.INVALID_ARGUMENT,
				message,
			},
			null,
		);
	}
	const depositValidation = validateDeposit(
		policy,
		cex,
		depositNetwork.brokerNetworkId,
		symbol,
	);
	if (!depositValidation.valid) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.PERMISSION_DENIED,
				message: `policy_deposit_denied: ${depositValidation.error}`,
			},
			null,
		);
	}
	try {
		const depositAddresses =
			broker.has.fetchDepositAddress === true
				? [
						await broker.fetchDepositAddress(symbol, {
							network: depositNetwork.exchangeNetworkId,
							...(fetchDepositAddresses.params ?? {}),
						}),
					]
				: await broker.fetchDepositAddressesByNetwork(symbol, {
						network: depositNetwork.exchangeNetworkId,
						...(fetchDepositAddresses.params ?? {}),
					});
		if (depositAddresses.length > 0) {
			return ctx.wrappedCallback(null, {
				proof: ctx.verity.proof,
				result: JSON.stringify(
					depositAddresses.map((depositAddress) => ({
						...depositAddress,
						operatorAlias: depositNetwork.operatorAlias,
						brokerNetworkId: depositNetwork.brokerNetworkId,
						exchangeNetworkId: depositNetwork.exchangeNetworkId,
					})),
				),
			});
		}
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: "Deposit confirmation failed",
			},
			null,
		);
	} catch (error: unknown) {
		safeLogError("Fetch Deposit Addresses confirmation failed", error);
		const message = getErrorMessage(error);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: "Fetch Deposit Addresses confirmation failed: " + message,
			},
			null,
		);
	}
}

async function handleFetchBalances(ctx: ExecuteActionContext): Promise<void> {
	const { call, cex, symbol, broker } = ctx;

	try {
		// Determine balance type: free | used | total (default: total)
		const payload: Record<string, unknown> = {
			...(call.request.payload ?? {}),
		};
		const providedBalanceType =
			typeof payload.balanceType === "string" ? payload.balanceType : undefined;
		const balanceType = (providedBalanceType ?? "total").toString();
		const validBalanceTypes = new Set(["free", "used", "total"]);
		if (!validBalanceTypes.has(balanceType)) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: `ValidationError: invalid balanceType '${providedBalanceType}'. Expected one of: free | used | total`,
				},
				null,
			);
		}
		const params = { ...payload };
		delete params.balanceType; // Remove balanceType from params before passing to CCXT
		const marketType = parseMarketType(params.marketType);
		delete params.marketType;
		// Default market type to spot unless explicitly provided
		if (params.type === undefined) {
			params.type = marketTypeToCcxtType(marketType);
		}
		// Always return the same schema with empty objects when not requested
		let responseBalances: Record<string, number> = {};
		if (balanceType === "free") {
			// biome-ignore lint/suspicious/noExplicitAny: ccxt typing quirk for partial balances
			const partial = (await broker.fetchFreeBalance(params)) as any;
			responseBalances = partial ?? {};
		} else if (balanceType === "used") {
			// biome-ignore lint/suspicious/noExplicitAny: ccxt typing quirk for partial balances
			const partial = (await broker.fetchUsedBalance(params)) as any;
			responseBalances = partial ?? {};
		} else if (balanceType === "total") {
			// biome-ignore lint/suspicious/noExplicitAny: ccxt typing quirk for partial balances
			const partial = (await broker.fetchTotalBalance(params)) as any;
			responseBalances = partial ?? {};
		}
		// Extract and isolate the symbol if it exists.
		if (symbol) {
			if (typeof responseBalances[symbol] === "number") {
				responseBalances = {
					[symbol]: responseBalances[symbol] ?? 0,
				};
			} else {
				responseBalances = {};
			}
		}
		ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify({
				balances: responseBalances,
				balanceType,
			}),
		});
	} catch (error) {
		safeLogError(`Error fetching balance from ${cex}`, error);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: `Failed to fetch balance from ${cex}`,
			},
			null,
		);
	}
}

async function handleFetchTicker(ctx: ExecuteActionContext): Promise<void> {
	const { cex, symbol, broker } = ctx;

	if (!symbol) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `ValidationError: Symbol required`,
			},
			null,
		);
	}
	try {
		const ticker = await broker.fetchTicker(symbol);
		ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify(ticker),
		});
	} catch (error) {
		safeLogError(`Error fetching ticker from ${cex}`, error);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: `Failed to fetch ticker from ${cex}`,
			},
			null,
		);
	}
}

export async function handlePassThrough(
	ctx: ExecuteActionContext,
): Promise<void> {
	if (ctx.action === Action.FetchCurrency)
		return handleFetchCurrencyEvidence(ctx);
	if (ctx.action === Action.FetchAccountId) return handleFetchAccountId(ctx);
	if (ctx.action === Action.FetchFees) return handleFetchFeesEvidence(ctx);
	if (ctx.action === Action.FetchMarketRules)
		return handleFetchMarketRulesEvidence(ctx);
	if (ctx.action === Action.FetchDepositAddresses)
		return handleFetchDepositAddresses(ctx);
	if (ctx.action === Action.FetchBalances) return handleFetchBalances(ctx);
	if (ctx.action === Action.FetchTicker) return handleFetchTicker(ctx);
}
