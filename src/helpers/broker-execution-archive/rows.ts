import type { OrderExecutionTelemetry } from "../order-telemetry";
import { asRecord } from "../shared/guards";
import { hashMarketMetadata, redactStreamPayload } from "./redact";
import {
	ARCHIVE_SCHEMA_VERSION,
	BROKER_WRITE_SOURCE,
	type BrokerArchiveCommonTags,
	type BrokerArchiveRow,
	FILL_EVENT_KIND,
	type OrderArchiveAction,
	type SubscribeArchiveType,
	type TransferEventKind,
	type TransferLifecycleAction,
} from "./types";

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
		const numeric =
			typeof value === "number"
				? value
				: typeof value === "string" && value.trim()
					? Number(value)
					: Number.NaN;
		if (Number.isFinite(numeric)) {
			return numeric;
		}
	}
	return undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	const ms = firstNumber(value);
	if (ms === undefined) {
		return undefined;
	}
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function compactUndefined(
	record: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}

export function buildCommonArchiveTags(input: {
	deploymentId: string;
	accountSelector?: string;
	exchange: string;
	symbol?: string;
	brokerObservedTimestamp?: string;
}): BrokerArchiveCommonTags {
	return {
		source: BROKER_WRITE_SOURCE,
		deployment_id: input.deploymentId,
		account_selector: input.accountSelector ?? "unknown",
		exchange: input.exchange.trim().toLowerCase() || "unknown",
		symbol: input.symbol?.trim() || "unknown",
		broker_observed_timestamp:
			input.brokerObservedTimestamp ?? new Date().toISOString(),
	};
}

export function buildOrderEventArchiveRow(input: {
	tags: BrokerArchiveCommonTags;
	action: OrderArchiveAction;
	telemetry: OrderExecutionTelemetry;
	eventKind?: "execute_action" | "subscribe_stream";
	subscriptionType?: SubscribeArchiveType;
	marketMetadataHash?: string;
}): BrokerArchiveRow {
	const { tags, telemetry, action } = input;
	return {
		table: "broker_execution.order_events",
		row: compactUndefined({
			...tags,
			event_kind: input.eventKind ?? "execute_action",
			action,
			subscription_type: input.subscriptionType,
			order_id: telemetry.orderId,
			client_order_id: telemetry.clientOrderId,
			idempotency_id: telemetry.idempotencyId,
			maker_action_id: telemetry.makerActionId,
			market_metadata_hash: input.marketMetadataHash,
			status: telemetry.status,
			side: telemetry.side,
			order_type: telemetry.orderType,
			requested_quantity: telemetry.requestedQuantity,
			requested_notional: telemetry.requestedNotional,
			executed_base_quantity: telemetry.executedBaseQuantity,
			executed_quote_quantity: telemetry.executedQuoteQuantity,
			average_execution_price: telemetry.averageExecutionPrice,
			filled_amount: telemetry.filledAmount,
			remaining_amount: telemetry.remainingAmount,
			fee_amount: telemetry.feeAmount,
			fee_currency: telemetry.feeCurrency,
			fee_rate: telemetry.feeRate,
			exchange_timestamp: telemetry.exchangeTimestamp,
			error_type: telemetry.errorType,
			error_message: telemetry.errorMessage,
			payload_json: JSON.stringify(telemetry),
		}),
	};
}

export function buildSubscribeStreamArchiveRow(input: {
	tags: BrokerArchiveCommonTags;
	subscriptionType: SubscribeArchiveType;
	streamPayload: unknown;
	secretLiterals?: readonly string[];
}): BrokerArchiveRow {
	const redactedPayload = redactStreamPayload(
		input.streamPayload,
		input.secretLiterals,
	);
	const record = asRecord(input.streamPayload);
	const info = asRecord(record?.info);
	return {
		table: "broker_execution.order_events",
		row: compactUndefined({
			...input.tags,
			event_kind: "subscribe_stream",
			subscription_type: input.subscriptionType,
			order_id: firstString(
				record?.id,
				record?.orderId,
				record?.i,
				info?.orderId,
				info?.i,
			),
			client_order_id: firstString(
				record?.clientOrderId,
				record?.clientOrderID,
				record?.c,
				info?.clientOrderId,
				info?.c,
			),
			status: firstString(
				record?.status,
				record?.X,
				info?.status,
				info?.X,
			)?.toLowerCase(),
			payload_json: JSON.stringify(redactedPayload),
		}),
	};
}

// Column shapes below follow the fiet-maker CEX_EXECUTION_ARCHIVE_CONTRACT: shared
// tags + contract columns, all quantities/prices as strings (venue precision
// varies by asset), fill_index/result_index as numbers (UInt32 columns). Two
// deliberate ADDITIVE divergences the consumer contract doesn't yet list:
// transfer_events carries fee_amount/fee_currency (the ccxt withdrawal object
// exposes the fee, which is the dominant small-commit cost), and fill_events.event_kind
// is stamped with the true trade-history-poller source rather than "create_order_fill".

// Preserve venue precision: prefer the raw string the venue returned (usually in
// `info`) over ccxt's parsed number, stringifying a number only as a fallback.
function quantityString(...values: unknown[]): string | undefined {
	return firstString(...values);
}

export type TransferArchiveFields = {
	eventKind: TransferEventKind;
	lifecycleAction: TransferLifecycleAction;
	status?: string;
	amount?: string;
	address?: string;
	network?: string;
	externalId?: string;
	txid?: string;
	resultIndex?: number;
	feeAmount?: string;
	feeCurrency?: string;
	exchangeTimestamp?: string;
	errorSummary?: string;
	payload: unknown;
};

// asset_symbol mirrors the shared `symbol` tag for transfers (the moved asset,
// e.g. "USDC"), per the contract. event_kind/lifecycle_action/external_id are the
// primary read keys; they are always emitted (external_id/status default to "").
export function buildTransferEventArchiveRow(input: {
	tags: BrokerArchiveCommonTags;
	transfer: TransferArchiveFields;
}): BrokerArchiveRow {
	const { tags, transfer } = input;
	return {
		table: "broker_execution.transfer_events",
		row: compactUndefined({
			...tags,
			schema_version: ARCHIVE_SCHEMA_VERSION,
			event_kind: transfer.eventKind,
			lifecycle_action: transfer.lifecycleAction,
			status: transfer.status ?? "",
			asset_symbol: tags.symbol,
			amount: transfer.amount,
			address: transfer.address,
			network: transfer.network,
			external_id: transfer.externalId ?? "",
			txid: transfer.txid,
			result_index: transfer.resultIndex ?? 0,
			// Additive (not in the consumer contract's transfer_events column set).
			fee_amount: transfer.feeAmount,
			fee_currency: transfer.feeCurrency,
			exchange_timestamp: transfer.exchangeTimestamp,
			error_summary: transfer.errorSummary,
			payload_json: JSON.stringify(transfer.payload),
		}),
	};
}

// Normalized fields pulled from a ccxt unified transaction (withdraw/deposit) so
// the withdraw/deposit handlers stay declarative. The full raw object is kept in
// payload_json regardless, so this only needs the columns we index/filter on.
export type NormalizedCcxtTransfer = {
	externalId?: string;
	txid?: string;
	address?: string;
	network?: string;
	amount?: string;
	assetSymbol?: string;
	status?: string;
	feeAmount?: string;
	feeCurrency?: string;
	exchangeTimestamp?: string;
};

export function normalizeCcxtTransactionForArchive(
	transaction: unknown,
): NormalizedCcxtTransfer {
	const record = asRecord(transaction);
	const info = asRecord(record?.info);
	const fee = asRecord(record?.fee);
	return compactUndefined({
		externalId: firstString(record?.id, info?.id, record?.txid, info?.txId),
		txid: firstString(record?.txid, info?.txId, info?.txid, info?.tx_hash),
		address: firstString(record?.address, record?.addressTo, info?.address),
		network: firstString(record?.network, info?.network),
		amount: quantityString(info?.amount, record?.amount),
		assetSymbol: firstString(record?.currency, info?.coin, info?.asset),
		status: firstString(record?.status, info?.status)?.toLowerCase(),
		feeAmount: quantityString(fee?.cost, record?.feeCost),
		feeCurrency: firstString(fee?.currency, record?.feeCurrency),
		exchangeTimestamp: normalizeTimestamp(
			firstValueForTransfer(
				record?.timestamp,
				record?.datetime,
				info?.applyTime,
			),
		),
	}) as NormalizedCcxtTransfer;
}

function firstValueForTransfer(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined && value !== null);
}

export type FillArchiveFields = {
	orderId?: string;
	clientOrderId?: string;
	fillId?: string;
	fillIndex?: number;
	side?: string;
	orderType?: string;
	price?: string;
	baseQuantity?: string;
	quoteQuantity?: string;
	feeAmount?: string;
	feeCurrency?: string;
	feeRate?: string;
	exchangeTimestamp?: string;
	payload: unknown;
};

// Contract read keys are (symbol, account_selector, broker_observed_timestamp,
// exchange, order_id, fill_index). order_id/fill_index are always present.
export function buildFillEventArchiveRow(input: {
	tags: BrokerArchiveCommonTags;
	fill: FillArchiveFields;
}): BrokerArchiveRow {
	const { tags, fill } = input;
	return {
		table: "broker_execution.fill_events",
		row: compactUndefined({
			...tags,
			schema_version: ARCHIVE_SCHEMA_VERSION,
			event_kind: FILL_EVENT_KIND,
			order_id: fill.orderId ?? "",
			client_order_id: fill.clientOrderId,
			fill_id: fill.fillId,
			fill_index: fill.fillIndex ?? 0,
			side: fill.side,
			order_type: fill.orderType,
			price: fill.price,
			base_quantity: fill.baseQuantity,
			quote_quantity: fill.quoteQuantity,
			fee_amount: fill.feeAmount,
			fee_currency: fill.feeCurrency,
			fee_rate: fill.feeRate,
			exchange_timestamp: fill.exchangeTimestamp,
			payload_json: JSON.stringify(fill.payload),
		}),
	};
}

// Maps one ccxt unified trade (fetchMyTrades element) to fill archive fields.
// fillIndex is assigned by the poller (batch position); left undefined here.
export function normalizeCcxtTradeForArchive(
	trade: unknown,
): FillArchiveFields {
	const record = asRecord(trade);
	const info = asRecord(record?.info);
	const fee = asRecord(record?.fee);
	return {
		orderId: firstString(record?.order, info?.orderId, info?.orderID),
		clientOrderId: firstString(
			record?.clientOrderId,
			info?.clientOrderId,
			info?.origClientOrderId,
		),
		fillId: firstString(record?.id, info?.id, info?.tradeId),
		side: firstString(record?.side, info?.side)?.toLowerCase(),
		orderType: firstString(record?.type, info?.type)?.toLowerCase(),
		price: quantityString(info?.price, record?.price),
		baseQuantity: quantityString(info?.qty, record?.amount),
		quoteQuantity: quantityString(info?.quoteQty, record?.cost),
		feeAmount: quantityString(fee?.cost, info?.commission),
		feeCurrency: firstString(fee?.currency, info?.commissionAsset),
		feeRate: quantityString(fee?.rate),
		exchangeTimestamp: normalizeTimestamp(
			firstValueForTransfer(record?.timestamp, record?.datetime, info?.time),
		),
		payload: trade,
	};
}

export function buildMarketMetadataSnapshotRow(input: {
	tags: BrokerArchiveCommonTags;
	clientOrderId?: string;
	orderId?: string;
	makerActionId?: string;
	idempotencyId?: string;
	marketSnapshot: unknown;
}): BrokerArchiveRow {
	const redactedSnapshot = redactStreamPayload(input.marketSnapshot);
	const metadataHash = hashMarketMetadata(redactedSnapshot);
	return {
		table: "broker_execution.market_metadata_snapshots",
		row: compactUndefined({
			...input.tags,
			client_order_id: input.clientOrderId,
			order_id: input.orderId,
			maker_action_id: input.makerActionId,
			idempotency_id: input.idempotencyId,
			market_metadata_hash: metadataHash,
			snapshot_json: JSON.stringify(redactedSnapshot),
		}),
	};
}
