import type { ArchiveBatchRequest } from "./types";

const LEVEL_TABLE = "market_data.cex_order_book_levels";
const SUMMARY_TABLE = "market_data.cex_order_book_depth_summary";
const BROKER_SOURCES = new Set(["broker_read", "broker_write"]);
const BAND_STATUSES = new Set(["exact", "censored"]);

const CAPTURE_STRING_FIELDS = [
	"source",
	"deployment_id",
	"capture_bundle_id",
	"exchange",
	"symbol",
	"trading_pair",
	"source_symbol",
	"asset_type",
	"feed",
	"provider",
	"source_mode",
	"raw_capture_id",
	"raw_capture_scope",
	"schema_version",
	"checksum_algorithm",
	"raw_checksum",
] as const;

const SNAPSHOT_STRING_FIELDS = [
	"snapshot_id",
	"construction_mode",
	"gap_policy",
] as const;

export const ORDER_BOOK_LEVEL_FIELDS = [
	...CAPTURE_STRING_FIELDS,
	"source_time_ms",
	"received_time_ms",
	"provenance_complete",
	...SNAPSHOT_STRING_FIELDS,
	"depth_limit",
	"sequence",
	"exact_l2_reconstruction_complete",
	"side",
	"level_index",
	"price",
	"amount",
	"notional",
	"mid_price",
	"spread_from_mid_bps",
	"normalized_row_checksum",
] as const;

export const ORDER_BOOK_SUMMARY_V2_FIELDS = [
	...CAPTURE_STRING_FIELDS,
	"source_time_ms",
	"received_time_ms",
	"provenance_complete",
	...SNAPSHOT_STRING_FIELDS,
	"depth_limit",
	"sequence",
	"exact_l2_reconstruction_complete",
	"capture_profile_id",
	"effective_cadence_ms",
	"requested_upstream_depth",
	"observed_bid_count",
	"observed_ask_count",
	"observed_farthest_bid",
	"observed_farthest_ask",
	"retained_farthest_bid",
	"retained_farthest_ask",
	"bid_exhausted",
	"ask_exhausted",
	"best_bid",
	"best_ask",
	"best_bid_amount",
	"best_ask_amount",
	"mid_price",
	"spread",
	"spread_bps",
	"staleness_ms",
	"bid_level_count",
	"ask_level_count",
	"measurement_bands_bps",
	"bid_boundary_price_by_band",
	"ask_boundary_price_by_band",
	"bid_depth_by_band",
	"ask_depth_by_band",
	"bid_status_by_band",
	"ask_status_by_band",
	"normalized_row_checksum",
] as const;

export type OrderBookRowValidation =
	| { ok: true }
	| { ok: false; error: string };

function hasExactFields(
	row: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const actual = Object.keys(row).sort();
	const wanted = [...expected].sort();
	return (
		actual.length === wanted.length &&
		actual.every((field, index) => field === wanted[index])
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isUInt(value: unknown, max: number): boolean {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= max
	);
}

function isUInt64(value: unknown): boolean {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0;
	}
	if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
	return BigInt(value) <= 18_446_744_073_709_551_615n;
}

function isDecimal(value: unknown, allowZero = false): boolean {
	if (typeof value === "number") {
		return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
	}
	if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) {
		return false;
	}
	const numeric = Number(value);
	return Number.isFinite(numeric) && (allowZero ? numeric >= 0 : numeric > 0);
}

function isFiniteNumber(value: unknown, allowNegative = false): boolean {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		(allowNegative || value >= 0)
	);
}

function isBooleanUInt8(value: unknown): boolean {
	return value === 0 || value === 1;
}

function validateCommon(
	row: Record<string, unknown>,
	envelopeSource: string,
	envelopeDeploymentId: string,
	schemaVersion: "1.0.0" | "2.0.0",
): string | undefined {
	for (const field of CAPTURE_STRING_FIELDS) {
		if (!isNonEmptyString(row[field])) return `${field} must be non-empty`;
	}
	for (const field of SNAPSHOT_STRING_FIELDS) {
		if (!isNonEmptyString(row[field])) return `${field} must be non-empty`;
	}
	if (!isNonEmptyString(row.normalized_row_checksum)) {
		return "normalized_row_checksum must be non-empty";
	}
	if (!BROKER_SOURCES.has(String(row.source)) || row.source !== envelopeSource) {
		return "source must match the broker archive envelope";
	}
	if (row.deployment_id !== envelopeDeploymentId) {
		return "deployment_id must match the archive envelope";
	}
	if (row.feed !== "ORDERBOOK") return "feed must be ORDERBOOK";
	if (row.schema_version !== schemaVersion) {
		return `schema_version must be ${schemaVersion}`;
	}
	if (!isUInt64(row.source_time_ms) || !isUInt64(row.received_time_ms)) {
		return "source and received timestamps must be UInt64";
	}
	if (BigInt(row.received_time_ms as number | string) < BigInt(row.source_time_ms as number | string)) {
		return "received_time_ms must not precede source_time_ms";
	}
	if (!isUInt(row.depth_limit, 500) || Number(row.depth_limit) < 1) {
		return "depth_limit must be in 1..500";
	}
	if (!(row.sequence === null || isUInt64(row.sequence))) {
		return "sequence must be null or UInt64";
	}
	if (!isBooleanUInt8(row.provenance_complete)) {
		return "provenance_complete must be UInt8 boolean";
	}
	if (!isBooleanUInt8(row.exact_l2_reconstruction_complete)) {
		return "exact_l2_reconstruction_complete must be UInt8 boolean";
	}
	return undefined;
}

function validateLevel(
	row: Record<string, unknown>,
	envelopeSource: string,
	envelopeDeploymentId: string,
): OrderBookRowValidation {
	if (!hasExactFields(row, ORDER_BOOK_LEVEL_FIELDS)) {
		return { ok: false, error: "level row fields do not match schema v1" };
	}
	const commonError = validateCommon(
		row,
		envelopeSource,
		envelopeDeploymentId,
		"1.0.0",
	);
	if (commonError) return { ok: false, error: commonError };
	if (row.provenance_complete !== 1) {
		return { ok: false, error: "live level provenance must be complete" };
	}
	if (row.side !== "bid" && row.side !== "ask") {
		return { ok: false, error: "side must be bid or ask" };
	}
	if (!isUInt(row.level_index, 499) || Number(row.level_index) >= Number(row.depth_limit)) {
		return { ok: false, error: "level_index must be within depth_limit" };
	}
	for (const field of ["price", "amount", "notional", "mid_price"] as const) {
		if (!isDecimal(row[field])) {
			return { ok: false, error: `${field} must be a positive decimal` };
		}
	}
	if (!isFiniteNumber(row.spread_from_mid_bps)) {
		return { ok: false, error: "spread_from_mid_bps must be non-negative" };
	}
	return { ok: true };
}

function validateDecimalArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.every((entry) => isDecimal(entry, true));
}

function validateSummary(
	row: Record<string, unknown>,
	envelopeSource: string,
	envelopeDeploymentId: string,
): OrderBookRowValidation {
	if (!hasExactFields(row, ORDER_BOOK_SUMMARY_V2_FIELDS)) {
		return { ok: false, error: "summary row fields do not match schema v2" };
	}
	const commonError = validateCommon(
		row,
		envelopeSource,
		envelopeDeploymentId,
		"2.0.0",
	);
	if (commonError) return { ok: false, error: commonError };
	if (row.provenance_complete !== 1) {
		return { ok: false, error: "summary v2 provenance must be complete" };
	}
	if (!isNonEmptyString(row.capture_profile_id)) {
		return { ok: false, error: "capture_profile_id must be non-empty" };
	}
	if (!isUInt(row.effective_cadence_ms, 4_294_967_295) || row.effective_cadence_ms === 0) {
		return { ok: false, error: "effective_cadence_ms must be positive UInt32" };
	}
	if (
		!(row.requested_upstream_depth === null ||
			(isUInt(row.requested_upstream_depth, 500) && row.requested_upstream_depth !== 0))
	) {
		return { ok: false, error: "requested_upstream_depth must be null or in 1..500" };
	}
	for (const field of ["observed_bid_count", "observed_ask_count"] as const) {
		if (!isUInt(row[field], 4_294_967_295) || row[field] === 0) {
			return { ok: false, error: `${field} must be positive UInt32` };
		}
	}
	for (const field of ["bid_level_count", "ask_level_count"] as const) {
		if (!isUInt(row[field], 65_535) || row[field] === 0) {
			return { ok: false, error: `${field} must be positive UInt16` };
		}
	}
	if (
		Number(row.bid_level_count) > Number(row.observed_bid_count) ||
		Number(row.ask_level_count) > Number(row.observed_ask_count) ||
		Number(row.bid_level_count) > Number(row.depth_limit) ||
		Number(row.ask_level_count) > Number(row.depth_limit)
	) {
		return { ok: false, error: "retained counts exceed observed counts or depth_limit" };
	}
	for (const field of [
		"observed_farthest_bid",
		"observed_farthest_ask",
		"retained_farthest_bid",
		"retained_farthest_ask",
		"best_bid",
		"best_ask",
		"best_bid_amount",
		"best_ask_amount",
		"mid_price",
		"spread",
	] as const) {
		if (!isDecimal(row[field])) {
			return { ok: false, error: `${field} must be a positive decimal` };
		}
	}
	if (Number(row.best_bid) >= Number(row.best_ask)) {
		return { ok: false, error: "summary book must not be crossed or locked" };
	}
	if (!isFiniteNumber(row.spread_bps) || !isUInt64(row.staleness_ms)) {
		return { ok: false, error: "spread_bps and staleness_ms have invalid types" };
	}
	if (!isBooleanUInt8(row.bid_exhausted) || !isBooleanUInt8(row.ask_exhausted)) {
		return { ok: false, error: "exhaustion flags must be UInt8 booleans" };
	}
	const bands = row.measurement_bands_bps;
	if (
		!Array.isArray(bands) ||
		bands.length === 0 ||
		!bands.every((band) => isUInt(band, 4_294_967_295) && band !== 0) ||
		!bands.every((band, index) => index === 0 || Number(band) > Number(bands[index - 1]))
	) {
		return { ok: false, error: "measurement bands must be positive ascending unique UInt32 values" };
	}
	const alignedArrays = [
		row.bid_boundary_price_by_band,
		row.ask_boundary_price_by_band,
		row.bid_depth_by_band,
		row.ask_depth_by_band,
		row.bid_status_by_band,
		row.ask_status_by_band,
	];
	if (alignedArrays.some((value) => !Array.isArray(value) || value.length !== bands.length)) {
		return { ok: false, error: "summary band arrays must be aligned" };
	}
	for (const field of [
		"bid_boundary_price_by_band",
		"ask_boundary_price_by_band",
		"bid_depth_by_band",
		"ask_depth_by_band",
	] as const) {
		if (!validateDecimalArray(row[field])) {
			return { ok: false, error: `${field} must contain non-negative decimals` };
		}
	}
	for (const field of ["bid_status_by_band", "ask_status_by_band"] as const) {
		if (!(row[field] as unknown[]).every((status) => BAND_STATUSES.has(String(status)))) {
			return { ok: false, error: `${field} contains an invalid status` };
		}
	}
	return { ok: true };
}

export function validateRetainedOrderBookRow(
	entry: ArchiveBatchRequest["rows"][number],
	envelopeSource: string,
	envelopeDeploymentId: string,
): OrderBookRowValidation {
	if (entry.table === LEVEL_TABLE) {
		return validateLevel(entry.row, envelopeSource, envelopeDeploymentId);
	}
	if (entry.table === SUMMARY_TABLE) {
		return validateSummary(entry.row, envelopeSource, envelopeDeploymentId);
	}
	return { ok: true };
}
