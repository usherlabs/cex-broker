import { type Exchange, Precise } from "ccxt";
import {
	CreateOrderPayloadSchema,
	FetchDepositAddressesPayloadSchema,
	WithdrawPayloadSchema,
} from "../schemas/action-payloads";
import type { PolicyConfig } from "../types";
import { parsePayload } from "./grpc/payload";
import {
	type OrderExecutionFailure,
	resolveOrderExecution,
	resolveTravelRuleDecision,
	validateDeposit,
	validateWithdraw,
} from "./index";
import { parseMarketType } from "./market-type";
import {
	buildCreateOrderParams,
	checkTimeInForceRequest,
	isPassiveCreateOrder,
	resolveTimeInForceSupport,
} from "./order-time-in-force";
import { sanitizeErrorDetail } from "./shared/errors";
import { isRecord } from "./shared/guards";
import {
	resolveTransferNetwork,
	type TransferNetworkResolution,
} from "./transfer-network";
import { fetchCurrencyMetadata } from "./treasury-discovery";

/**
 * Dry-run checks for state-changing actions. Each validator applies the same
 * parsing, broker policy and network resolution as the action handler, then
 * the market's or network's advertised limits and precision and the
 * exchange's advertised capabilities. Nothing is placed or withdrawn. Refusals
 * are returned as reasons; a venue that cannot be read throws, because "could
 * not check" is not "would be refused".
 */

export const ACTION_VALIDATION_SCHEMA_VERSION =
	"cex-broker-action-validation/v1";

export type ActionValidationReasonCode =
	| "invalid_request"
	| "time_in_force_invalid"
	| "policy_denied"
	| "travel_rule_denied"
	| "market_unavailable"
	| "market_limit_violated"
	| "network_unavailable"
	| "transfer_limit_violated"
	| "capability_unsupported";

export type ActionValidationReason = {
	code: ActionValidationReasonCode;
	message: string;
	field?: string;
};

export type ActionValidationOutcome =
	| { valid: true; normalized: Record<string, unknown> }
	| { valid: false; reasons: ActionValidationReason[] };

export type ActionValidationInput = {
	policy: PolicyConfig;
	broker: Exchange;
	cex: string;
	symbol: string;
	payload: Record<string, string>;
};

type Adjustment = { field: string; requested: string; normalized: string };

function refuse(reasons: ActionValidationReason[]): ActionValidationOutcome {
	return { valid: false, reasons };
}

function invalidRequest(message: string): ActionValidationOutcome {
	return refuse([{ code: "invalid_request", message }]);
}

function decimalString(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Precise(String(value)).toString();
	}
	if (typeof value === "string" && value.trim() !== "") {
		return value.trim();
	}
	return undefined;
}

function checkRange(
	reasons: ActionValidationReason[],
	code: "market_limit_violated" | "transfer_limit_violated",
	field: string,
	label: string,
	value: string,
	range: unknown,
): void {
	if (!isRecord(range)) {
		return;
	}
	const min = decimalString(range.min);
	const max = decimalString(range.max);
	if (min !== undefined && Precise.stringLt(value, min)) {
		reasons.push({
			code,
			field,
			message: `${label} ${value} is below the minimum ${min}`,
		});
	}
	if (max !== undefined && Precise.stringGt(value, max)) {
		reasons.push({
			code,
			field,
			message: `${label} ${value} exceeds the maximum ${max}`,
		});
	}
}

function capabilityReason(
	broker: Exchange,
	method: string,
): ActionValidationReason {
	return {
		code: "capability_unsupported",
		message: `${broker.id ?? "exchange"} does not advertise ${method}`,
	};
}

const ORDER_FAILURE_CODES: Record<
	OrderExecutionFailure,
	ActionValidationReasonCode
> = {
	policy_market_denied: "policy_denied",
	policy_limit_denied: "policy_denied",
	market_unavailable: "market_unavailable",
	invalid_price: "invalid_request",
};

/**
 * Applies venue precision through CCXT, which is what CCXT's createOrder does
 * before sending. A market without the precision field is left unchanged.
 */
function toVenuePrecision(
	broker: Exchange,
	symbol: string,
	field: "amount" | "price",
	requested: string,
	precision: unknown,
	reasons: ActionValidationReason[],
	adjustments: Adjustment[],
): string | undefined {
	if (precision === undefined || precision === null) {
		return requested;
	}
	try {
		const normalized =
			(field === "amount"
				? broker.amountToPrecision(symbol, requested)
				: broker.priceToPrecision(symbol, requested)) ?? requested;
		if (!Precise.stringEq(normalized, requested)) {
			adjustments.push({ field, requested, normalized });
		}
		return normalized;
	} catch (error) {
		reasons.push({
			code: "market_limit_violated",
			field,
			message: sanitizeErrorDetail(error),
		});
		return undefined;
	}
}

export async function validateCreateOrderAction(
	input: ActionValidationInput,
): Promise<ActionValidationOutcome> {
	const { policy, broker, cex } = input;
	const parsed = parsePayload(CreateOrderPayloadSchema, input.payload);
	if (!parsed.success) {
		return invalidRequest(parsed.message);
	}
	const order = parsed.data;
	if (order.orderIntent === "passive_only" && order.orderType !== "limit") {
		return invalidRequest(
			"ValidationError: passive_only order intent requires a limit order",
		);
	}
	const timeInForceError = checkTimeInForceRequest(order);
	if (timeInForceError !== undefined) {
		return refuse([
			{
				code: "time_in_force_invalid",
				field: "timeInForce",
				message: timeInForceError,
			},
		]);
	}

	const reasons: ActionValidationReason[] = [];
	if (broker.has?.createOrder !== true) {
		reasons.push(capabilityReason(broker, "createOrder"));
	}
	const resolution = await resolveOrderExecution(
		policy,
		broker,
		cex,
		order.fromToken,
		order.toToken,
		order.amount,
		order.price,
		order.marketType,
		order.amountBase,
	);
	if (!resolution.valid || !resolution.symbol || !resolution.side) {
		reasons.push({
			code: ORDER_FAILURE_CODES[resolution.failure ?? "policy_market_denied"],
			message:
				resolution.error ??
				"Order rejected by policy: market or limits not satisfied",
		});
		return refuse(reasons);
	}
	const symbol = resolution.symbol;
	const market = broker.market(symbol) as unknown as Record<string, unknown>;
	if (market.active === false) {
		reasons.push({
			code: "market_unavailable",
			message: `Market ${symbol} is not active`,
		});
	}
	if (order.timeInForce !== undefined) {
		const support = resolveTimeInForceSupport(
			broker,
			symbol,
			order.timeInForce,
		);
		if (!support.supported) {
			reasons.push({
				code: "capability_unsupported",
				field: "timeInForce",
				message: support.message,
			});
		}
	}

	const precision = isRecord(market.precision) ? market.precision : {};
	const limits = isRecord(market.limits) ? market.limits : {};
	const adjustments: Adjustment[] = [];
	const requestedAmount = decimalString(resolution.amountBase);
	const requestedPrice = decimalString(order.price);
	if (requestedAmount === undefined || requestedPrice === undefined) {
		reasons.push({
			code: "invalid_request",
			message: "Order amount and price must be decimal values",
		});
		return refuse(reasons);
	}
	const isLimit = order.orderType === "limit";
	const amount = toVenuePrecision(
		broker,
		symbol,
		"amount",
		requestedAmount,
		precision.amount,
		reasons,
		adjustments,
	);
	const price = isLimit
		? toVenuePrecision(
				broker,
				symbol,
				"price",
				requestedPrice,
				precision.price,
				reasons,
				adjustments,
			)
		: requestedPrice;
	if (amount !== undefined) {
		checkRange(
			reasons,
			"market_limit_violated",
			"amount",
			"Amount",
			amount,
			limits.amount,
		);
	}
	if (isLimit && price !== undefined) {
		checkRange(
			reasons,
			"market_limit_violated",
			"price",
			"Price",
			price,
			limits.price,
		);
	}
	const cost =
		amount === undefined || price === undefined
			? undefined
			: Precise.stringMul(amount, price);
	if (cost !== undefined) {
		checkRange(
			reasons,
			"market_limit_violated",
			"cost",
			isLimit ? "Notional" : "Notional at the reference price",
			cost,
			limits.cost,
		);
	}
	if (reasons.length > 0 || amount === undefined || price === undefined) {
		return refuse(reasons);
	}

	return {
		valid: true,
		normalized: {
			symbol,
			marketType: parseMarketType(order.marketType),
			side: resolution.side,
			orderType: order.orderType,
			amount,
			...(isLimit ? { price } : { referencePrice: price }),
			...(order.timeInForce !== undefined && {
				timeInForce: order.timeInForce,
			}),
			postOnly: isPassiveCreateOrder(order),
			...(order.clientOrderId !== undefined && {
				clientOrderId: order.clientOrderId,
			}),
			params: buildCreateOrderParams(order),
			adjustments,
		},
	};
}

type TransferNetworkCheck =
	| { resolved: true; network: TransferNetworkResolution }
	| { resolved: false; reason: ActionValidationReason };

async function checkTransferNetwork(
	broker: Exchange,
	asset: string,
	alias: string,
): Promise<TransferNetworkCheck> {
	try {
		return {
			resolved: true,
			network: await resolveTransferNetwork(broker, asset, alias),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("network_alias_unresolved:")) {
			return {
				resolved: false,
				reason: { code: "network_unavailable", field: "chain", message },
			};
		}
		throw error;
	}
}

/**
 * Reads the discovered currency and network records. Returns undefined when
 * the exchange does not publish them; network checks are then skipped, exactly
 * as the action itself proceeds with the operator's network alias.
 */
async function discoveredNetworkRecords(
	broker: Exchange,
	asset: string,
	network: TransferNetworkResolution,
): Promise<
	| {
			currency: Record<string, unknown>;
			network: Record<string, unknown> | undefined;
	  }
	| undefined
> {
	if (network.networkKey === null) {
		return undefined;
	}
	const currency = await fetchCurrencyMetadata(broker, asset);
	if (!isRecord(currency)) {
		return undefined;
	}
	const networks = isRecord(currency.networks) ? currency.networks : {};
	const record = networks[network.networkKey];
	return { currency, network: isRecord(record) ? record : undefined };
}

function networkSummary(network: TransferNetworkResolution) {
	return {
		operatorAlias: network.operatorAlias,
		brokerNetworkId: network.brokerNetworkId,
		exchangeNetworkId: network.exchangeNetworkId,
	};
}

export async function validateWithdrawAction(
	input: ActionValidationInput,
): Promise<ActionValidationOutcome> {
	const { policy, broker, cex, symbol } = input;
	if (!symbol.trim()) {
		return invalidRequest("ValidationError: Symbol required");
	}
	const parsed = parsePayload(WithdrawPayloadSchema, input.payload);
	if (!parsed.success) {
		return invalidRequest(parsed.message);
	}
	const withdrawal = parsed.data;
	const reasons: ActionValidationReason[] = [];
	if (broker.has?.withdraw !== true) {
		reasons.push(capabilityReason(broker, "withdraw"));
	}
	const networkCheck = await checkTransferNetwork(
		broker,
		symbol,
		withdrawal.chain,
	);
	if (!networkCheck.resolved) {
		reasons.push(networkCheck.reason);
		return refuse(reasons);
	}
	const network = networkCheck.network;
	const policyCheck = validateWithdraw(
		policy,
		cex,
		network.brokerNetworkId,
		withdrawal.recipientAddress,
		withdrawal.amount,
		symbol,
	);
	if (!policyCheck.valid) {
		reasons.push({
			code: "policy_denied",
			message: `policy_withdrawal_denied: ${policyCheck.error}`,
		});
	}
	const travelRule = resolveTravelRuleDecision(
		policy,
		cex,
		withdrawal.recipientAddress,
	);
	if (travelRule.mode === "denied") {
		reasons.push({
			code: "travel_rule_denied",
			message: `travel_rule_denied: ${travelRule.error}`,
		});
	}

	const amount = new Precise(String(withdrawal.amount)).toString();
	let fee: string | undefined;
	const records = await discoveredNetworkRecords(broker, symbol, network);
	if (records !== undefined) {
		const networkRecord = records.network ?? {};
		if (
			records.currency.withdraw === false ||
			networkRecord.withdraw === false ||
			networkRecord.active === false
		) {
			reasons.push({
				code: "network_unavailable",
				field: "chain",
				message: `Withdrawals of ${symbol} on ${network.operatorAlias} are disabled`,
			});
		}
		const networkLimits = isRecord(networkRecord.limits)
			? networkRecord.limits
			: {};
		checkRange(
			reasons,
			"transfer_limit_violated",
			"amount",
			"Withdrawal amount",
			amount,
			networkLimits.withdraw,
		);
		fee = decimalString(networkRecord.fee);
	}
	if (reasons.length > 0) {
		return refuse(reasons);
	}
	return {
		valid: true,
		normalized: {
			asset: symbol,
			amount,
			recipientAddress: withdrawal.recipientAddress,
			network: networkSummary(network),
			travelRuleMode: travelRule.mode,
			...(fee !== undefined && { fee }),
			params: { ...withdrawal.params, network: network.exchangeNetworkId },
		},
	};
}

export async function validateDepositAddressAction(
	input: ActionValidationInput,
): Promise<ActionValidationOutcome> {
	const { policy, broker, cex, symbol } = input;
	if (!symbol.trim()) {
		return invalidRequest("ValidationError: Symbol required");
	}
	const parsed = parsePayload(
		FetchDepositAddressesPayloadSchema,
		input.payload,
	);
	if (!parsed.success) {
		return invalidRequest(parsed.message);
	}
	const request = parsed.data;
	const reasons: ActionValidationReason[] = [];
	const method =
		broker.has?.fetchDepositAddress === true
			? "fetchDepositAddress"
			: broker.has?.fetchDepositAddressesByNetwork === true
				? "fetchDepositAddressesByNetwork"
				: undefined;
	if (method === undefined) {
		reasons.push(
			capabilityReason(
				broker,
				"fetchDepositAddress or fetchDepositAddressesByNetwork",
			),
		);
	}
	const networkCheck = await checkTransferNetwork(
		broker,
		symbol,
		request.chain,
	);
	if (!networkCheck.resolved) {
		reasons.push(networkCheck.reason);
		return refuse(reasons);
	}
	const network = networkCheck.network;
	const policyCheck = validateDeposit(
		policy,
		cex,
		network.brokerNetworkId,
		symbol,
	);
	if (!policyCheck.valid) {
		reasons.push({
			code: "policy_denied",
			message: `policy_deposit_denied: ${policyCheck.error}`,
		});
	}
	const records = await discoveredNetworkRecords(broker, symbol, network);
	if (records !== undefined) {
		const networkRecord = records.network ?? {};
		if (
			records.currency.deposit === false ||
			networkRecord.deposit === false ||
			networkRecord.active === false
		) {
			reasons.push({
				code: "network_unavailable",
				field: "chain",
				message: `Deposits of ${symbol} on ${network.operatorAlias} are disabled`,
			});
		}
	}
	if (reasons.length > 0 || method === undefined) {
		return refuse(reasons);
	}
	return {
		valid: true,
		normalized: {
			asset: symbol,
			network: networkSummary(network),
			method,
			params: { network: network.exchangeNetworkId, ...request.params },
		},
	};
}
