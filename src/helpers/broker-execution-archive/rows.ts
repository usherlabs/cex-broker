import { createHash } from "node:crypto";
import type { OrderExecutionTelemetry } from "../order-telemetry";
import { asRecord } from "../shared/guards";
import { hashMarketMetadata, redactStreamPayload } from "./redact";
import {
	ACCOUNT_BALANCE_PRECISION_BASIS,
	ACCOUNT_BALANCE_SCOPE,
	ARCHIVE_SCHEMA_VERSION,
	BROKER_WRITE_SOURCE,
	type BrokerArchiveCommonTags,
	type BrokerArchiveRow,
	type BrokerArchiveSource,
	FILL_EVENT_KIND,
	type OrderArchiveAction,
	type SubscribeArchiveType,
	type TransferEventKind,
	type TransferLifecycleAction,
	USER_ASSET_BALANCE_SCOPE,
	USER_ASSET_PRECISION_BASIS,
} from "./types";

type BalanceQuantityMap = Record<string, string>;

export type NormalizedCcxtBalance = {
	exchangeTimestamp?: string;
	reportedAssets: string[];
	assetEntryAssets: string[];
	freeBalances: BalanceQuantityMap;
	usedBalances: BalanceQuantityMap;
	totalBalances: BalanceQuantityMap;
	freeMapPresent: boolean;
	usedMapPresent: boolean;
	totalMapPresent: boolean;
};

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

// Venues report a moment as either an ISO-8601 string or an epoch-ms number
// (Binance sends `insertTime` as an integer). The archive's DateTime64 columns
// are fed ISO-8601 UTC strings — the forwarder configures ClickHouse for exactly
// that form — so an epoch-ms integer must be converted, never passed through: it
// would be read as *seconds* and land the row tens of thousands of years ahead.
export function normalizeTimestamp(value: unknown): string | undefined {
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

// CCXT has already normalized the venue value to a JavaScript number. Expanding
// exponent notation makes storage stable but cannot recover venue-raw precision.
function decimalString(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	if (Object.is(value, -0)) {
		return "0";
	}
	const rendered = String(value).toLowerCase();
	if (!rendered.includes("e")) {
		return rendered;
	}
	const [coefficient = "", rawExponent = "0"] = rendered.split("e");
	const exponent = Number.parseInt(rawExponent, 10);
	const negative = coefficient.startsWith("-");
	const unsigned = negative ? coefficient.slice(1) : coefficient;
	const [integer = "0", fraction = ""] = unsigned.split(".");
	const digits = `${integer}${fraction}`;
	const decimalIndex = integer.length + exponent;
	let expanded: string;
	if (decimalIndex <= 0) {
		expanded = `0.${"0".repeat(-decimalIndex)}${digits}`;
	} else if (decimalIndex >= digits.length) {
		expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
	} else {
		expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
	}
	return negative ? `-${expanded}` : expanded;
}

function normalizedBalanceMap(value: unknown): BalanceQuantityMap {
	const record = asRecord(value);
	if (!record) {
		return {};
	}
	const entries: Array<[string, string]> = [];
	for (const [rawAsset, quantity] of Object.entries(record)) {
		const asset = rawAsset.trim();
		const normalized = decimalString(quantity);
		if (asset && normalized !== undefined) {
			entries.push([asset, normalized]);
		}
	}
	return Object.fromEntries(
		entries.sort(([left], [right]) => left.localeCompare(right)),
	);
}

function sortedBalanceMap(map: BalanceQuantityMap): BalanceQuantityMap {
	return Object.fromEntries(
		Object.entries(map).sort(([left], [right]) => left.localeCompare(right)),
	);
}

const BALANCE_METADATA_KEYS = new Set([
	"info",
	"timestamp",
	"datetime",
	"free",
	"used",
	"total",
	"debt",
]);

export function normalizeCcxtBalanceForArchive(
	balance: unknown,
): NormalizedCcxtBalance {
	const record = asRecord(balance) ?? {};
	const aggregateRecords = {
		free: asRecord(record.free),
		used: asRecord(record.used),
		total: asRecord(record.total),
	};
	const maps = {
		free: normalizedBalanceMap(record.free),
		used: normalizedBalanceMap(record.used),
		total: normalizedBalanceMap(record.total),
	};
	const assetEntryAssets = new Set<string>();

	for (const [rawAsset, value] of Object.entries(record)) {
		if (BALANCE_METADATA_KEYS.has(rawAsset)) {
			continue;
		}
		const asset = rawAsset.trim();
		const assetEntry = asRecord(value);
		if (
			!asset ||
			!assetEntry ||
			!("free" in assetEntry || "used" in assetEntry || "total" in assetEntry)
		) {
			continue;
		}
		assetEntryAssets.add(asset);
		for (const field of ["free", "used", "total"] as const) {
			const normalized = decimalString(assetEntry[field]);
			if (normalized !== undefined && maps[field][asset] === undefined) {
				maps[field][asset] = normalized;
			}
		}
	}

	const reportedAssets = new Set(assetEntryAssets);
	for (const aggregateRecord of Object.values(aggregateRecords)) {
		for (const rawAsset of Object.keys(aggregateRecord ?? {})) {
			const asset = rawAsset.trim();
			if (asset) {
				reportedAssets.add(asset);
			}
		}
	}
	for (const map of Object.values(maps)) {
		for (const asset of Object.keys(map)) {
			reportedAssets.add(asset);
		}
	}

	return {
		exchangeTimestamp: normalizeTimestamp(record.timestamp ?? record.datetime),
		reportedAssets: [...reportedAssets].sort(),
		assetEntryAssets: [...assetEntryAssets].sort(),
		freeBalances: sortedBalanceMap(maps.free),
		usedBalances: sortedBalanceMap(maps.used),
		totalBalances: sortedBalanceMap(maps.total),
		freeMapPresent: aggregateRecords.free !== undefined,
		usedMapPresent: aggregateRecords.used !== undefined,
		totalMapPresent: aggregateRecords.total !== undefined,
	};
}

export function buildAccountBalanceSnapshotRow(input: {
	tags: BrokerArchiveCommonTags;
	balance: NormalizedCcxtBalance;
}): BrokerArchiveRow {
	const { tags, balance } = input;
	const observationId = createHash("sha256")
		.update(
			JSON.stringify({
				deployment_id: tags.deployment_id,
				exchange: tags.exchange,
				account_selector: tags.account_selector,
				balance_scope: ACCOUNT_BALANCE_SCOPE,
				broker_observed_timestamp: tags.broker_observed_timestamp,
				balance,
			}),
		)
		.digest("hex");

	return {
		table: "broker_account.balance_snapshots",
		row: compactUndefined({
			broker_observed_timestamp: tags.broker_observed_timestamp,
			exchange_timestamp: balance.exchangeTimestamp,
			source: tags.source,
			deployment_id: tags.deployment_id,
			schema_version: ARCHIVE_SCHEMA_VERSION,
			exchange: tags.exchange,
			account_selector: tags.account_selector,
			balance_scope: ACCOUNT_BALANCE_SCOPE,
			observation_id: observationId,
			reported_assets: balance.reportedAssets,
			asset_entry_assets: balance.assetEntryAssets,
			free_balances: balance.freeBalances,
			used_balances: balance.usedBalances,
			total_balances: balance.totalBalances,
			aggregate_free_map_present: Number(balance.freeMapPresent),
			aggregate_used_map_present: Number(balance.usedMapPresent),
			aggregate_total_map_present: Number(balance.totalMapPresent),
			precision_basis: ACCOUNT_BALANCE_PRECISION_BASIS,
		}),
	};
}

// -----------------------------------------------------------------------------
// Binance user-asset snapshot (sapi getUserAsset)
// -----------------------------------------------------------------------------

export type NormalizedUserAssets = {
	reportedAssets: string[];
	incompleteAssets: string[];
	freeBalances: BalanceQuantityMap;
	lockedBalances: BalanceQuantityMap;
	freezeBalances: BalanceQuantityMap;
	withdrawingBalances: BalanceQuantityMap;
};

const USER_ASSET_BUCKETS = {
	freeBalances: "free",
	lockedBalances: "locked",
	freezeBalances: "freeze",
	withdrawingBalances: "withdrawing",
} as const;

// The venue sends decimal strings. Keep them verbatim (only trimmed) so the
// stored quantity is venue-raw, and reject anything non-numeric rather than
// coercing it — a NaN written as "0" would silently erase owned funds.
function userAssetQuantity(value: unknown): string | undefined {
	if (typeof value === "number") {
		return decimalString(value);
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed || !Number.isFinite(Number(trimmed))) {
		return undefined;
	}
	return trimmed;
}

/**
 * Normalizes a `POST /sapi/v3/asset/getUserAsset` response into one coherent
 * snapshot.
 *
 * Fails closed on a response shape we cannot account for: a non-array body or a
 * duplicate/unkeyed asset entry would each drop owned quantity on the floor, and
 * an under-counted NAV is worse than an absent one. Per-bucket uncertainty is
 * narrower and is reported rather than thrown: the asset is listed in
 * `incompleteAssets` and its key is left out of the bucket map, so a reader sees
 * "unknown", never an implicit zero.
 */
export function normalizeBinanceUserAssetsForArchive(
	response: unknown,
): NormalizedUserAssets {
	if (!Array.isArray(response)) {
		throw new Error(
			"binance_user_asset_malformed_response: getUserAsset did not return an array",
		);
	}

	const reportedAssets: string[] = [];
	const incompleteAssets: string[] = [];
	const maps: Record<keyof typeof USER_ASSET_BUCKETS, BalanceQuantityMap> = {
		freeBalances: {},
		lockedBalances: {},
		freezeBalances: {},
		withdrawingBalances: {},
	};

	for (const entry of response) {
		const record = asRecord(entry);
		const asset =
			typeof record?.asset === "string" ? record.asset.trim() : undefined;
		if (!record || !asset) {
			throw new Error(
				"binance_user_asset_malformed_response: getUserAsset entry has no asset key",
			);
		}
		if (reportedAssets.includes(asset)) {
			throw new Error(
				`binance_user_asset_malformed_response: getUserAsset returned duplicate entries for ${asset}`,
			);
		}
		reportedAssets.push(asset);

		let complete = true;
		for (const [field, venueKey] of Object.entries(USER_ASSET_BUCKETS) as Array<
			[keyof typeof USER_ASSET_BUCKETS, string]
		>) {
			const quantity = userAssetQuantity(record[venueKey]);
			if (quantity === undefined) {
				complete = false;
				continue;
			}
			maps[field][asset] = quantity;
		}
		if (!complete) {
			incompleteAssets.push(asset);
		}
	}

	return {
		reportedAssets: reportedAssets.sort(),
		incompleteAssets: incompleteAssets.sort(),
		freeBalances: sortedBalanceMap(maps.freeBalances),
		lockedBalances: sortedBalanceMap(maps.lockedBalances),
		freezeBalances: sortedBalanceMap(maps.freezeBalances),
		withdrawingBalances: sortedBalanceMap(maps.withdrawingBalances),
	};
}

export function buildUserAssetSnapshotRow(input: {
	tags: BrokerArchiveCommonTags;
	userAssets: NormalizedUserAssets;
}): BrokerArchiveRow {
	const { tags, userAssets } = input;
	const observationId = createHash("sha256")
		.update(
			JSON.stringify({
				deployment_id: tags.deployment_id,
				exchange: tags.exchange,
				account_selector: tags.account_selector,
				balance_scope: USER_ASSET_BALANCE_SCOPE,
				broker_observed_timestamp: tags.broker_observed_timestamp,
				userAssets,
			}),
		)
		.digest("hex");

	return {
		table: "broker_account.user_asset_snapshots",
		row: {
			broker_observed_timestamp: tags.broker_observed_timestamp,
			source: tags.source,
			deployment_id: tags.deployment_id,
			schema_version: ARCHIVE_SCHEMA_VERSION,
			exchange: tags.exchange,
			account_selector: tags.account_selector,
			balance_scope: USER_ASSET_BALANCE_SCOPE,
			observation_id: observationId,
			reported_assets: userAssets.reportedAssets,
			incomplete_assets: userAssets.incompleteAssets,
			free_balances: userAssets.freeBalances,
			locked_balances: userAssets.lockedBalances,
			freeze_balances: userAssets.freezeBalances,
			withdrawing_balances: userAssets.withdrawingBalances,
			precision_basis: USER_ASSET_PRECISION_BASIS,
		},
	};
}

function compactUndefined(
	record: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}

export function buildCommonArchiveTags(input: {
	source?: BrokerArchiveSource;
	deploymentId: string;
	accountSelector?: string;
	exchange: string;
	symbol?: string;
	brokerObservedTimestamp?: string;
}): BrokerArchiveCommonTags {
	return {
		source: input.source ?? BROKER_WRITE_SOURCE,
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
	errorDetail?: string;
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
			order_author: telemetry.orderAuthor ?? "",
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
			error_message: input.errorDetail ?? telemetry.errorMessage,
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
// varies by asset), fill_index/result_index as numbers (UInt32 columns). Three
// deliberate ADDITIVE divergences the consumer contract doesn't yet list:
// order_events carries order_author as a caller-declared primary read key;
// transfer_events carries client_withdrawal_id plus fee_amount/fee_currency (the
// ccxt withdrawal object exposes the fee, which is the dominant small-commit
// cost); and fill_events.event_kind is stamped with the true trade-history-poller
// source rather than "create_order_fill".

// Preserve venue precision: prefer the raw string the venue returned (usually in
// `info`) over ccxt's parsed number, stringifying a number only as a fallback.
function quantityString(...values: unknown[]): string | undefined {
	return firstString(...values);
}

// Binance's implicit internal-transfer methods return raw SAPI responses, not
// ccxt unified transactions, and use a different id key for universal transfers.
export function extractBinanceInternalTransferId(
	response: unknown,
): string | undefined {
	const record = asRecord(response);
	return firstString(record?.txnId, record?.tranId);
}

export type TransferArchiveFields = {
	eventKind: TransferEventKind;
	lifecycleAction: TransferLifecycleAction;
	status?: string;
	assetSymbol?: string;
	amount?: string;
	address?: string;
	network?: string;
	externalId?: string;
	clientWithdrawalId?: string;
	txid?: string;
	resultIndex?: number;
	feeAmount?: string;
	feeCurrency?: string;
	exchangeTimestamp?: string;
	errorSummary?: string;
	payload: unknown;
};

// asset_symbol defaults to the shared `symbol` tag for transfer producers whose
// movement is symbol-scoped. Account-scoped producers supply it independently.
// event_kind/lifecycle_action and the two withdrawal identities are primary read
// keys; they are always emitted (external_id/client_withdrawal_id/status default
// to "").
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
			asset_symbol: transfer.assetSymbol ?? tags.symbol,
			amount: transfer.amount,
			address: transfer.address,
			network: transfer.network,
			external_id: transfer.externalId ?? "",
			client_withdrawal_id: transfer.clientWithdrawalId ?? "",
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
	clientWithdrawalId?: string;
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
		// The caller's withdrawal id, echoed back by the venue on withdrawal
		// history records. Without it an observation carries only the venue id and
		// a submission only the client id, so the two halves of one movement have
		// no shared key and the lifecycle cannot be joined (amounts differ by the
		// withdrawal fee, so they are not a fallback).
		clientWithdrawalId: firstString(info?.withdrawOrderId),
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
