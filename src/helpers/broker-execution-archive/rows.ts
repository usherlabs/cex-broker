import type { OrderExecutionTelemetry } from "../order-telemetry";
import { asRecord } from "../shared/guards";
import { hashMarketMetadata, redactStreamPayload } from "./redact";
import {
	BROKER_WRITE_SOURCE,
	type BrokerArchiveCommonTags,
	type BrokerArchiveRow,
	type OrderArchiveAction,
	type SubscribeArchiveType,
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
				info?.orderId,
				info?.i,
			),
			client_order_id: firstString(
				record?.clientOrderId,
				record?.clientOrderID,
				info?.clientOrderId,
				info?.c,
			),
			status: firstString(record?.status, info?.status, info?.X)?.toLowerCase(),
			payload_json: JSON.stringify(redactedPayload),
		}),
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
