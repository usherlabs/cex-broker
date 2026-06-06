import * as grpc from "@grpc/grpc-js";
import { validateDeposit } from "../../helpers";
import {
	marketTypeToCcxtType,
	parseMarketType,
} from "../../helpers/market-type";
import { Action } from "../../helpers/constants";
import {
	mapCcxtErrorToGrpcStatus,
	stableGrpcErrorCode,
} from "../../helpers/grpc/status";
import { log } from "../../helpers/logger";
import { getErrorMessage, safeLogError } from "../../helpers/shared/errors";
import {
	buildTransferNetworkEvidence,
	resolveTransferNetwork,
	type TransferNetworkResolution,
} from "../../helpers/transfer-network";
import {
	type ExchangeWithDiscovery,
	fetchCurrencyMetadata,
} from "../../helpers/treasury-discovery";
import {
	FetchDepositAddressesPayloadSchema,
	FetchFeesPayloadSchema,
} from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import { parsePayloadForAction, rejectWithGrpcError } from "./context";

async function handleFetchCurrency(ctx: ExecuteActionContext): Promise<void> {
	const {
		call,
		wrappedCallback,
		policy,
		brokers,
		metadata,
		normalizedCex,
		cex,
		symbol,
		selectedBrokerAccount,
		broker,
		verity,
		applyVerityToBroker,
		useVerity,
		verityProverUrl,
		otelMetrics,
	} = ctx;
	const verityProof = verity.proof;

	if (!symbol) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `ValidationError: Symbol requied`,
			},
			null,
		);
	}
	try {
		const assetCode = symbol.trim().toUpperCase();
		const currencyInfo = await fetchCurrencyMetadata(broker, assetCode);
		if (!currencyInfo) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.NOT_FOUND,
					message: `venue_discovery_unavailable: currency not found for ${assetCode}`,
				},
				null,
			);
		}
		const networkEvidence = buildTransferNetworkEvidence(currencyInfo);
		ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify({
				...currencyInfo,
				exchange: normalizedCex,
				asset: assetCode,
				code: currencyInfo.code ?? assetCode,
				id: currencyInfo.id ?? null,
				networks: networkEvidence.networks,
				networkAliases: networkEvidence.aliases,
				raw: currencyInfo,
			}),
		});
	} catch (error) {
		safeLogError(`Error fetching currency ${symbol} from ${cex}`, error);
		const message = getErrorMessage(error);
		ctx.wrappedCallback(
			{
				code:
					stableGrpcErrorCode(message) ??
					mapCcxtErrorToGrpcStatus(error) ??
					grpc.status.INTERNAL,
				message: message.startsWith("venue_discovery_unavailable:")
					? message
					: `venue_discovery_unavailable: ${message}`,
			},
			null,
		);
	}
}

async function handleFetchAccountId(ctx: ExecuteActionContext): Promise<void> {
	const {
		call,
		wrappedCallback,
		policy,
		brokers,
		metadata,
		normalizedCex,
		cex,
		symbol,
		selectedBrokerAccount,
		broker,
		verity,
		applyVerityToBroker,
		useVerity,
		verityProverUrl,
		otelMetrics,
	} = ctx;
	const verityProof = verity.proof;

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

async function handleFetchFees(ctx: ExecuteActionContext): Promise<void> {
	const {
		call,
		wrappedCallback,
		policy,
		brokers,
		metadata,
		normalizedCex,
		cex,
		symbol,
		selectedBrokerAccount,
		broker,
		verity,
		applyVerityToBroker,
		useVerity,
		verityProverUrl,
		otelMetrics,
	} = ctx;
	const verityProof = verity.proof;

	if (!symbol) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `ValidationError: Symbol required`,
			},
			null,
		);
	}
	const feesPayload = parsePayloadForAction(ctx, FetchFeesPayloadSchema);
	if (feesPayload === null) return;
	const includeAllFees =
		feesPayload.includeAllFees || feesPayload.includeFundingFees === true;
	try {
		await broker.loadMarkets();
		const fetchFundingFees = async (currencyCodes: string[]) => {
			let fundingFeeSource:
				| "fetchDepositWithdrawFees"
				| "currencies"
				| "unavailable" = "unavailable";
			const fundingFeesByCurrency: Record<string, unknown> = {};
			if (broker.has.fetchDepositWithdrawFees) {
				try {
					const feeMap = (await broker.fetchDepositWithdrawFees(
						currencyCodes,
					)) as unknown as Record<
						string,
						{
							deposit?: unknown;
							withdraw?: unknown;
							networks?: unknown;
							fee?: number;
							percentage?: boolean;
						}
					>;
					for (const code of currencyCodes) {
						const feeInfo = feeMap[code];
						if (!feeInfo) {
							continue;
						}
						const fallbackFee =
							feeInfo.fee !== undefined || feeInfo.percentage !== undefined
								? {
										fee: feeInfo.fee ?? null,
										percentage: feeInfo.percentage ?? null,
									}
								: null;
						fundingFeesByCurrency[code] = {
							deposit: feeInfo.deposit ?? fallbackFee,
							withdraw: feeInfo.withdraw ?? fallbackFee,
							networks: feeInfo.networks ?? {},
						};
					}
					if (Object.keys(fundingFeesByCurrency).length > 0) {
						fundingFeeSource = "fetchDepositWithdrawFees";
					}
				} catch (error) {
					safeLogError(
						`Error fetching deposit/withdraw fee map for ${symbol} from ${cex}`,
						error,
					);
				}
			}
			if (fundingFeeSource === "unavailable") {
				try {
					const currencies = await broker.fetchCurrencies();
					for (const code of currencyCodes) {
						const currency = currencies[code];
						if (!currency) {
							continue;
						}
						fundingFeesByCurrency[code] = {
							deposit: {
								enabled: currency.deposit ?? null,
							},
							withdraw: {
								enabled: currency.withdraw ?? null,
								fee: currency.fee ?? null,
								limits: currency.limits?.withdraw ?? null,
							},
							networks: currency.networks ?? {},
						};
					}
					if (Object.keys(fundingFeesByCurrency).length > 0) {
						fundingFeeSource = "currencies";
					}
				} catch (error) {
					safeLogError(
						`Error fetching currency metadata for fees for ${symbol} from ${cex}`,
						error,
					);
				}
			}
			return { fundingFeeSource, fundingFeesByCurrency };
		};
		const isMarketSymbol = symbol.includes("/");
		if (isMarketSymbol) {
			const market = await broker.market(symbol);
			const generalFee = broker.fees ?? null;
			const feeStatus = broker.fees ? "available" : "unknown";
			if (!broker.fees) {
				log.warn(`Fee metadata unavailable for ${cex}`, { symbol });
			}
			if (!includeAllFees) {
				return ctx.wrappedCallback(null, {
					proof: ctx.verity.proof,
					result: JSON.stringify({
						feeScope: "market",
						generalFee,
						feeStatus,
						market,
					}),
				});
			}
			const currencyCodes = Array.from(new Set([market.base, market.quote]));
			const { fundingFeeSource, fundingFeesByCurrency } =
				await fetchFundingFees(currencyCodes);
			return ctx.wrappedCallback(null, {
				proof: ctx.verity.proof,
				result: JSON.stringify({
					feeScope: "market+funding",
					generalFee,
					feeStatus,
					market,
					fundingFeeSource,
					fundingFeesByCurrency,
				}),
			});
		}
		const tokenCode = symbol.toUpperCase();
		const { fundingFeeSource, fundingFeesByCurrency } = await fetchFundingFees([
			tokenCode,
		]);
		return ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify({
				feeScope: "token",
				symbol: tokenCode,
				fundingFeeSource,
				fundingFeesByCurrency,
			}),
		});
	} catch (error) {
		safeLogError(`Error fetching fees for ${symbol} from ${cex}`, error);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: `Error fetching fees from ${cex}`,
			},
			null,
		);
	}
}

async function handleFetchDepositAddresses(
	ctx: ExecuteActionContext,
): Promise<void> {
	const {
		call,
		wrappedCallback,
		policy,
		brokers,
		metadata,
		normalizedCex,
		cex,
		symbol,
		selectedBrokerAccount,
		broker,
		verity,
		applyVerityToBroker,
		useVerity,
		verityProverUrl,
		otelMetrics,
	} = ctx;
	const verityProof = verity.proof;

	if (!symbol) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `ValidationError: Symbol requied`,
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
	const {
		call,
		wrappedCallback,
		policy,
		brokers,
		metadata,
		normalizedCex,
		cex,
		symbol,
		selectedBrokerAccount,
		broker,
		verity,
		applyVerityToBroker,
		useVerity,
		verityProverUrl,
		otelMetrics,
	} = ctx;
	const verityProof = verity.proof;

	try {
		// Determine balance type: free | used | total (default: total)
		const payload = (call.request.payload as Record<string, unknown>) || {};
		const providedBalanceType = payload.balanceType as string | undefined;
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
		const params = { ...payload } as Record<string, unknown>;
		delete (params as Record<string, unknown>).balanceType; // Remove balanceType from params before passing to CCXT
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
	const {
		call,
		wrappedCallback,
		policy,
		brokers,
		metadata,
		normalizedCex,
		cex,
		symbol,
		selectedBrokerAccount,
		broker,
		verity,
		applyVerityToBroker,
		useVerity,
		verityProverUrl,
		otelMetrics,
	} = ctx;
	const verityProof = verity.proof;

	if (!symbol) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `ValidationError: Symbol requied`,
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
	if (ctx.action === Action.FetchCurrency) return handleFetchCurrency(ctx);
	if (ctx.action === Action.FetchAccountId) return handleFetchAccountId(ctx);
	if (ctx.action === Action.FetchFees) return handleFetchFees(ctx);
	if (ctx.action === Action.FetchDepositAddresses)
		return handleFetchDepositAddresses(ctx);
	if (ctx.action === Action.FetchBalances) return handleFetchBalances(ctx);
	if (ctx.action === Action.FetchTicker) return handleFetchTicker(ctx);
}
