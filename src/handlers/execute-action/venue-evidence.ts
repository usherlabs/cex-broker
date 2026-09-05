import * as grpc from "@grpc/grpc-js";
import { normalizeBrokerNetworkId } from "../../helpers";
import {
	mapCcxtErrorToGrpcStatus,
	stableGrpcErrorCode,
} from "../../helpers/grpc/status";
import { safeLogRedactedError } from "../../helpers/shared/errors";
import { isRecord } from "../../helpers/shared/guards";
import { buildTransferNetworkEvidence } from "../../helpers/transfer-network";
import {
	canonicalNonnegativeDecimal,
	canonicalOptionalDecimal,
	decimalFractionToBasisPoints,
	evidenceExchange,
	evidenceSourceDigest,
	extractTradingFeeRates,
	precisionIncrement,
	resolveEvidenceAccountScope,
	resolveSpotMarketIdentity,
	sanitizeVenueError,
} from "../../helpers/venue-evidence";
import {
	MarketRuleEvidenceSchema,
	TradingFeeEvidenceSchema,
	TransferNetworkEvidenceSchema,
} from "../../schemas/action-evidence";
import {
	EmptyActionPayloadSchema,
	FetchCurrencyPayloadSchema,
	FetchFeesPayloadSchema,
} from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import {
	parsePayloadForAction,
	requireSymbol,
	successWithProof,
} from "./context";

function failVenueDiscovery(
	ctx: ExecuteActionContext,
	error: unknown,
	operation: string,
): void {
	safeLogRedactedError(`${operation} failed`, error);
	const sanitized = sanitizeVenueError(error, ctx.broker);
	const message = sanitized.startsWith("venue_discovery_unavailable:")
		? sanitized
		: `venue_discovery_unavailable: ${sanitized}`;
	ctx.wrappedCallback(
		{
			code:
				stableGrpcErrorCode(message) ??
				mapCcxtErrorToGrpcStatus(error) ??
				grpc.status.UNIMPLEMENTED,
			message,
		},
		null,
	);
}

function optionalDecimalFields(
	values: Array<[string, unknown, string]>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value, field] of values) {
		const normalized = canonicalOptionalDecimal(value, field);
		if (normalized !== undefined) {
			result[key] = normalized;
		}
	}
	return result;
}

export async function handleFetchFeesEvidence(
	ctx: ExecuteActionContext,
): Promise<void> {
	if (
		!requireSymbol(
			ctx,
			"ValidationError: symbol must be a slash-delimited spot pair",
		)
	) {
		return;
	}
	if (!/^[^/\s]+\/[^/\s]+$/.test(ctx.symbol.trim())) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: "ValidationError: symbol must be a slash-delimited spot pair",
			},
			null,
		);
	}
	if (parsePayloadForAction(ctx, FetchFeesPayloadSchema) === null) {
		return;
	}

	try {
		const identity = await resolveSpotMarketIdentity(ctx.broker, ctx.symbol);
		const exchange = evidenceExchange(ctx.broker);
		if (
			exchange.has?.fetchTradingFee === false ||
			typeof exchange.fetchTradingFee !== "function"
		) {
			throw new Error(
				`fee_unavailable: ${ctx.normalizedCex} does not support fetchTradingFee`,
			);
		}
		const sourceResponse = await exchange.fetchTradingFee(
			identity.unifiedSymbol,
		);
		if (
			isRecord(sourceResponse) &&
			typeof sourceResponse.symbol === "string" &&
			sourceResponse.symbol.trim().toUpperCase() !== identity.unifiedSymbol
		) {
			throw new Error(
				`fee_unavailable: trading-fee response symbol does not match ${identity.unifiedSymbol}`,
			);
		}
		const { makerRate, takerRate } = extractTradingFeeRates(sourceResponse);
		const accountScope = resolveEvidenceAccountScope(
			ctx.selectedBrokerAccount,
			ctx.metadata,
		);
		const evidence = TradingFeeEvidenceSchema.parse({
			schemaVersion: "cex-trading-fee-evidence/v1",
			exchange: ctx.normalizedCex,
			marketType: "spot",
			canonicalPair: identity.canonicalPair,
			unifiedSymbol: identity.unifiedSymbol,
			sourceSymbol: identity.sourceSymbol,
			...accountScope,
			observedAt: new Date().toISOString(),
			sourceMethod: "ccxt.fetchTradingFee",
			makerRate,
			takerRate,
			rateUnit: "decimal_fraction",
			makerBasisPoints: decimalFractionToBasisPoints(makerRate),
			takerBasisPoints: decimalFractionToBasisPoints(takerRate),
			basisPointsUnit: "basis_points",
			digestAlgorithm: "sha256-canonical-json-v1",
			sourceDigest: evidenceSourceDigest({
				action: "FetchFees",
				exchange: ctx.normalizedCex,
				requestedKey: identity.canonicalPair,
				accountSelector: accountScope.accountSelector,
				sourceMethod: "ccxt.fetchTradingFee",
				source: sourceResponse,
				broker: ctx.broker,
			}),
		});
		successWithProof(ctx, evidence);
	} catch (error) {
		safeLogRedactedError(
			`FetchFees failed for ${ctx.normalizedCex}/${ctx.symbol}`,
			error,
		);
		const sanitized = sanitizeVenueError(error, ctx.broker);
		const message = sanitized.startsWith("fee_unavailable:")
			? sanitized
			: `fee_unavailable: ${sanitized}`;
		ctx.wrappedCallback(
			{
				code: grpc.status.FAILED_PRECONDITION,
				message,
			},
			null,
		);
	}
}

export async function handleFetchMarketRulesEvidence(
	ctx: ExecuteActionContext,
): Promise<void> {
	if (
		!requireSymbol(
			ctx,
			"ValidationError: symbol must be a slash-delimited spot pair",
		)
	) {
		return;
	}
	if (!/^[^/\s]+\/[^/\s]+$/.test(ctx.symbol.trim())) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: "ValidationError: symbol must be a slash-delimited spot pair",
			},
			null,
		);
	}
	if (parsePayloadForAction(ctx, EmptyActionPayloadSchema) === null) {
		return;
	}

	try {
		const identity = await resolveSpotMarketIdentity(ctx.broker, ctx.symbol);
		const precision = isRecord(identity.market.precision)
			? identity.market.precision
			: {};
		const limits = isRecord(identity.market.limits)
			? identity.market.limits
			: {};
		const amountLimits = isRecord(limits.amount) ? limits.amount : {};
		const priceLimits = isRecord(limits.price) ? limits.price : {};
		const costLimits = isRecord(limits.cost) ? limits.cost : {};
		const precisionMode = evidenceExchange(ctx.broker).precisionMode;
		if (precisionMode === undefined || precisionMode === null) {
			throw new Error(
				"venue_discovery_unavailable: precision mode is unavailable",
			);
		}
		const accountScope = resolveEvidenceAccountScope(
			ctx.selectedBrokerAccount,
			ctx.metadata,
		);
		const evidence = MarketRuleEvidenceSchema.parse({
			schemaVersion: "cex-market-rule-evidence/v1",
			exchange: ctx.normalizedCex,
			marketType: "spot",
			canonicalPair: identity.canonicalPair,
			unifiedSymbol: identity.unifiedSymbol,
			sourceSymbol: identity.sourceSymbol,
			baseAsset: identity.baseAsset,
			quoteAsset: identity.quoteAsset,
			active: true,
			precisionMode,
			priceIncrement: precisionIncrement(
				precision.price,
				precisionMode,
				"price increment",
			),
			amountIncrement: precisionIncrement(
				precision.amount,
				precisionMode,
				"amount increment",
			),
			minimumAmount: canonicalNonnegativeDecimal(
				amountLimits.min,
				"minimum amount",
			),
			minimumNotional: canonicalNonnegativeDecimal(
				costLimits.min,
				"minimum notional",
			),
			...optionalDecimalFields([
				["maximumAmount", amountLimits.max, "maximum amount"],
				["maximumPrice", priceLimits.max, "maximum price"],
				["maximumNotional", costLimits.max, "maximum notional"],
			]),
			...accountScope,
			observedAt: new Date().toISOString(),
			sourceMethod: "ccxt.loadMarkets",
			digestAlgorithm: "sha256-canonical-json-v1",
			sourceDigest: evidenceSourceDigest({
				action: "FetchMarketRules",
				exchange: ctx.normalizedCex,
				requestedKey: identity.canonicalPair,
				accountSelector: accountScope.accountSelector,
				sourceMethod: "ccxt.loadMarkets",
				source: identity.market,
				broker: ctx.broker,
			}),
		});
		successWithProof(ctx, evidence);
	} catch (error) {
		failVenueDiscovery(
			ctx,
			error,
			`FetchMarketRules ${ctx.normalizedCex}/${ctx.symbol}`,
		);
	}
}

export async function handleFetchCurrencyEvidence(
	ctx: ExecuteActionContext,
): Promise<void> {
	if (!requireSymbol(ctx)) {
		return;
	}
	const payload = parsePayloadForAction(ctx, FetchCurrencyPayloadSchema);
	if (payload === null) {
		return;
	}
	const asset = ctx.symbol.trim().toUpperCase();
	const requestedAlias = payload.network.trim().toUpperCase();
	try {
		const exchange = evidenceExchange(ctx.broker);
		if (
			exchange.has?.fetchCurrencies === false ||
			typeof exchange.fetchCurrencies !== "function"
		) {
			throw new Error(
				`venue_discovery_unavailable: fetchCurrencies unavailable for ${asset}`,
			);
		}
		const currencies = await exchange.fetchCurrencies();
		const currency = currencies[asset] as unknown;
		if (!isRecord(currency)) {
			throw new Error(
				`venue_discovery_unavailable: currency not found for ${asset}`,
			);
		}
		const networkEvidence = buildTransferNetworkEvidence(currency);
		const brokerNetworkId = normalizeBrokerNetworkId(requestedAlias);
		const resolution =
			networkEvidence.aliases[requestedAlias] ??
			networkEvidence.aliases[brokerNetworkId];
		if (!resolution?.networkKey) {
			throw new Error(
				`network_alias_unresolved: ${asset}/${requestedAlias} is not available in discovered transfer networks`,
			);
		}
		const networks: Record<string, unknown> = isRecord(currency.networks)
			? currency.networks
			: {};
		const networkCandidate = networks[resolution.networkKey];
		if (
			!isRecord(networkCandidate) ||
			typeof networkCandidate.deposit !== "boolean" ||
			typeof networkCandidate.withdraw !== "boolean"
		) {
			throw new Error(
				`venue_discovery_unavailable: transfer availability is incomplete for ${asset}/${requestedAlias}`,
			);
		}
		const network = networkCandidate;
		const limits: Record<string, unknown> = isRecord(network.limits)
			? network.limits
			: {};
		const withdrawalLimits: Record<string, unknown> = isRecord(limits.withdraw)
			? limits.withdraw
			: {};
		const accountScope = resolveEvidenceAccountScope(
			ctx.selectedBrokerAccount,
			ctx.metadata,
		);
		const evidence = TransferNetworkEvidenceSchema.parse({
			schemaVersion: "cex-transfer-network-evidence/v1",
			exchange: ctx.normalizedCex,
			asset,
			operatorNetworkAlias: requestedAlias,
			brokerNetworkId,
			exchangeNetworkId: resolution.exchangeNetworkId,
			depositAvailable: network.deposit,
			withdrawalAvailable: network.withdraw,
			withdrawalFee:
				canonicalOptionalDecimal(network.fee, "withdrawal fee") ?? null,
			withdrawalLimits: {
				minimum:
					canonicalOptionalDecimal(
						withdrawalLimits.min,
						"minimum withdrawal",
					) ?? null,
				maximum:
					canonicalOptionalDecimal(
						withdrawalLimits.max,
						"maximum withdrawal",
					) ?? null,
			},
			...accountScope,
			observedAt: new Date().toISOString(),
			sourceMethod: "ccxt.fetchCurrencies",
			digestAlgorithm: "sha256-canonical-json-v1",
			sourceDigest: evidenceSourceDigest({
				action: "FetchCurrency",
				exchange: ctx.normalizedCex,
				requestedKey: `${asset}/${requestedAlias}`,
				accountSelector: accountScope.accountSelector,
				sourceMethod: "ccxt.fetchCurrencies",
				source: network,
				broker: ctx.broker,
			}),
		});
		successWithProof(ctx, evidence);
	} catch (error) {
		safeLogRedactedError(
			`FetchCurrency failed for ${ctx.normalizedCex}/${asset}/${requestedAlias}`,
			error,
		);
		const sanitized = sanitizeVenueError(error, ctx.broker);
		const isAliasError = sanitized.startsWith("network_alias_unresolved:");
		const message =
			isAliasError || sanitized.startsWith("venue_discovery_unavailable:")
				? sanitized
				: `venue_discovery_unavailable: ${sanitized}`;
		ctx.wrappedCallback(
			{
				code:
					stableGrpcErrorCode(message) ??
					mapCcxtErrorToGrpcStatus(error) ??
					grpc.status.UNIMPLEMENTED,
				message,
			},
			null,
		);
	}
}
