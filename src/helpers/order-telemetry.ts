import { log } from "./logger";
import type { OtelMetrics } from "./otel";

type JsonRecord = Record<string, unknown>;

export type OrderTelemetryAction = "CreateOrder" | "GetOrderDetails";

export type OrderTelemetryContext = {
	action: OrderTelemetryAction;
	cex: string;
	accountLabel?: string;
	symbol?: string;
	side?: string;
	orderType?: string;
	requestedQuantity?: number;
	requestedNotional?: number;
	clientOrderId?: string;
	idempotencyId?: string;
	makerActionId?: string;
	brokerObservedTimestamp?: string;
};

export type OrderExecutionTelemetry = {
	event: "cex_market_action_execution";
	action: OrderTelemetryAction;
	cex: string;
	accountLabel: string;
	symbol: string;
	side: string;
	orderType: string;
	orderId?: string;
	clientOrderId?: string;
	idempotencyId?: string;
	makerActionId?: string;
	status: string;
	requestedQuantity?: number;
	requestedNotional?: number;
	executedBaseQuantity?: number;
	executedQuoteQuantity?: number;
	averageExecutionPrice?: number;
	filledAmount?: number;
	remainingAmount?: number;
	feeAmount?: number;
	feeCurrency?: string;
	feeRate?: number;
	exchangeTimestamp?: string;
	brokerObservedTimestamp: string;
	errorType?: string;
	errorMessage?: string;
};

type NumericTelemetryKey =
	| "requestedQuantity"
	| "requestedNotional"
	| "executedBaseQuantity"
	| "executedQuoteQuantity"
	| "averageExecutionPrice"
	| "filledAmount"
	| "remainingAmount"
	| "feeAmount"
	| "feeRate";

const NUMERIC_METRICS: Array<[NumericTelemetryKey, string]> = [
	["requestedQuantity", "cex_market_action_requested_quantity"],
	["requestedNotional", "cex_market_action_requested_notional"],
	["executedBaseQuantity", "cex_market_action_executed_base_quantity"],
	["executedQuoteQuantity", "cex_market_action_executed_quote_quantity"],
	["averageExecutionPrice", "cex_market_action_average_execution_price"],
	["filledAmount", "cex_market_action_filled_amount"],
	["remainingAmount", "cex_market_action_remaining_amount"],
	["feeAmount", "cex_market_action_fee_amount"],
	["feeRate", "cex_market_action_fee_rate"],
];

const REDACTED_ERROR_MESSAGE = "redacted_error";

export async function emitOrderExecutionTelemetry(
	otelMetrics: OtelMetrics | undefined,
	context: OrderTelemetryContext,
	order: unknown,
	error?: unknown,
): Promise<OrderExecutionTelemetry | undefined> {
	try {
		const telemetry = buildOrderExecutionTelemetry(context, order, error);
		log.info("CEX market action execution telemetry", telemetry);

		const labels = {
			action: telemetry.action,
			cex: telemetry.cex,
			account: telemetry.accountLabel,
			symbol: telemetry.symbol,
			side: telemetry.side,
			order_type: telemetry.orderType,
			status: telemetry.status,
		};

		await otelMetrics?.recordCounter("cex_market_action_executions_total", 1, {
			...labels,
			result: error ? "error" : "ok",
		});

		for (const [key, metricName] of NUMERIC_METRICS) {
			const value = telemetry[key];
			if (typeof value === "number" && Number.isFinite(value)) {
				await otelMetrics?.recordHistogram(metricName, value, labels);
			}
		}

		return telemetry;
	} catch (telemetryError) {
		try {
			log.error("Failed to emit CEX order telemetry", {
				error: telemetryError,
			});
		} catch {
			// Telemetry must never alter order execution behavior.
		}
		return undefined;
	}
}

export function buildOrderExecutionTelemetry(
	context: OrderTelemetryContext,
	order: unknown,
	error?: unknown,
): OrderExecutionTelemetry {
	const record = asRecord(order);
	const info = asRecord(record?.info);
	const fees = getFees(record, info);
	const fee = summarizeFees(fees);
	const executedBaseQuantity =
		firstNumber(record?.filled, info?.executedQty, info?.cumExecQty) ??
		computeFilledFromAmount(record);
	const executedQuoteQuantity = firstNumber(
		record?.cost,
		info?.cummulativeQuoteQty,
		info?.cumQuote,
		info?.cumExecValue,
	);
	const averageExecutionPrice =
		firstNumber(record?.average, info?.avgPrice) ??
		computeAveragePrice(executedBaseQuantity, executedQuoteQuantity);
	const exchangeTimestamp = normalizeTimestamp(
		firstValue(
			record?.timestamp,
			info?.time,
			info?.transactTime,
			record?.datetime,
		),
	);
	const status =
		firstString(record?.status, info?.status) ?? (error ? "failed" : "unknown");
	const errorRecord = error instanceof Error ? error : undefined;

	return compactUndefined({
		event: "cex_market_action_execution",
		action: context.action,
		cex: context.cex.trim().toLowerCase() || "unknown",
		accountLabel: context.accountLabel ?? "unknown",
		symbol:
			firstString(record?.symbol, info?.symbol, context.symbol) ?? "unknown",
		side: firstString(record?.side, info?.side, context.side) ?? "unknown",
		orderType:
			firstString(record?.type, info?.type, context.orderType) ?? "unknown",
		orderId: firstString(record?.id, info?.orderId, info?.orderID),
		clientOrderId: firstString(
			context.clientOrderId,
			record?.clientOrderId,
			record?.clientOrderID,
			record?.clientOid,
			info?.clientOrderId,
			info?.clientOrderID,
			info?.clientOid,
		),
		idempotencyId: context.idempotencyId,
		makerActionId: context.makerActionId,
		status: status.toLowerCase(),
		requestedQuantity: context.requestedQuantity ?? firstNumber(record?.amount),
		requestedNotional: context.requestedNotional,
		executedBaseQuantity,
		executedQuoteQuantity,
		averageExecutionPrice,
		filledAmount: firstNumber(record?.filled, info?.executedQty),
		remainingAmount: firstNumber(record?.remaining, info?.remainingQty),
		feeAmount: fee.amount,
		feeCurrency: fee.currency,
		feeRate: fee.rate,
		exchangeTimestamp,
		brokerObservedTimestamp:
			context.brokerObservedTimestamp ?? new Date().toISOString(),
		errorType: errorRecord?.name,
		errorMessage: errorRecord ? REDACTED_ERROR_MESSAGE : undefined,
	}) as OrderExecutionTelemetry;
}

export function extractOrderTelemetryIds(
	params: Record<string, string | number> | undefined,
): Pick<
	OrderTelemetryContext,
	"clientOrderId" | "idempotencyId" | "makerActionId"
> {
	const record = params ?? {};
	return {
		clientOrderId: firstString(
			record.clientOrderId,
			record.clientOrderID,
			record.newClientOrderId,
			record.clientOid,
		),
		idempotencyId: firstString(
			record.idempotencyId,
			record.idempotencyID,
			record.idempotencyKey,
			record.requestId,
			record.requestID,
		),
		makerActionId: firstString(
			record.makerActionId,
			record.maker_action_id,
			record.actionId,
			record.action_id,
		),
	};
}

function asRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function firstValue(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined && value !== null);
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			return String(value);
		}
	}
	return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		const numberValue =
			typeof value === "number"
				? value
				: typeof value === "string" && value.trim()
					? Number(value)
					: Number.NaN;
		if (Number.isFinite(numberValue)) {
			return numberValue;
		}
	}
	return undefined;
}

function computeFilledFromAmount(
	record: JsonRecord | undefined,
): number | undefined {
	const amount = firstNumber(record?.amount);
	const remaining = firstNumber(record?.remaining);
	if (amount === undefined || remaining === undefined) {
		return undefined;
	}
	return amount - remaining;
}

function computeAveragePrice(
	executedBaseQuantity: number | undefined,
	executedQuoteQuantity: number | undefined,
): number | undefined {
	if (
		executedBaseQuantity === undefined ||
		executedQuoteQuantity === undefined ||
		executedBaseQuantity === 0
	) {
		return undefined;
	}
	return executedQuoteQuantity / executedBaseQuantity;
}

function normalizeTimestamp(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	const timestamp = firstNumber(value);
	if (timestamp === undefined) {
		return undefined;
	}
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function getFees(record: JsonRecord | undefined, info: JsonRecord | undefined) {
	const fees: unknown[] = [];
	if (record?.fee) fees.push(record.fee);
	if (Array.isArray(record?.fees)) fees.push(...record.fees);
	if (Array.isArray(record?.trades)) {
		for (const trade of record.trades) {
			const tradeRecord = asRecord(trade);
			if (tradeRecord?.fee) fees.push(tradeRecord.fee);
			if (Array.isArray(tradeRecord?.fees)) fees.push(...tradeRecord.fees);
		}
	}
	if (Array.isArray(info?.fills)) {
		for (const fill of info.fills) {
			const fillRecord = asRecord(fill);
			const commission = firstNumber(fillRecord?.commission);
			if (commission !== undefined) {
				fees.push({
					cost: commission,
					currency: firstString(fillRecord?.commissionAsset),
				});
			}
		}
	}
	return fees;
}

function summarizeFees(fees: unknown[]) {
	let amount = 0;
	let amountFound = false;
	let currency: string | undefined;
	let rate: number | undefined;

	for (const rawFee of fees) {
		const fee = asRecord(rawFee);
		if (!fee) continue;
		const cost = firstNumber(fee.cost, fee.amount);
		if (cost !== undefined) {
			amount += cost;
			amountFound = true;
		}
		currency ??= firstString(fee.currency);
		rate ??= firstNumber(fee.rate);
	}

	return {
		amount: amountFound ? amount : undefined,
		currency,
		rate,
	};
}

function compactUndefined(record: JsonRecord): JsonRecord {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}
