import { canonicalDecimal } from "./capture-contract";

export const ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELDS = [
	["source", "String", false],
	["deployment_id", "String", false],
	["capture_bundle_id", "String", false],
	["exchange", "String", false],
	["symbol", "String", false],
	["trading_pair", "String", false],
	["source_symbol", "String", false],
	["asset_type", "String", false],
	["feed", "String", false],
	["provider", "String", false],
	["source_mode", "String", false],
	["source_time_ms", "UInt64", false],
	["received_time_ms", "UInt64", false],
	["raw_capture_id", "String", false],
	["raw_capture_scope", "String", false],
	["schema_version", "String", false],
	["checksum_algorithm", "String", false],
	["raw_checksum", "String", false],
	["provenance_complete", "UInt8", false],
	["snapshot_id", "String", false],
	["construction_mode", "String", false],
	["gap_policy", "String", false],
	["depth_limit", "UInt16", false],
	["sequence", "UInt64", true],
	["exact_l2_reconstruction_complete", "UInt8", false],
	["capture_profile_id", "String", false],
	["effective_cadence_ms", "UInt32", false],
	["requested_upstream_depth", "UInt16", true],
	["observed_bid_count", "UInt32", false],
	["observed_ask_count", "UInt32", false],
	["observed_farthest_bid", "Decimal(38,18)", false],
	["observed_farthest_ask", "Decimal(38,18)", false],
	["retained_farthest_bid", "Decimal(38,18)", false],
	["retained_farthest_ask", "Decimal(38,18)", false],
	["bid_exhausted", "UInt8", false],
	["ask_exhausted", "UInt8", false],
	["best_bid", "Decimal(38,18)", false],
	["best_ask", "Decimal(38,18)", false],
	["best_bid_amount", "Decimal(38,18)", false],
	["best_ask_amount", "Decimal(38,18)", false],
	["mid_price", "Decimal(38,18)", false],
	["spread", "Decimal(38,18)", false],
	["spread_bps", "Float64", false],
	["staleness_ms", "UInt64", false],
	["bid_level_count", "UInt16", false],
	["ask_level_count", "UInt16", false],
	["measurement_bands_bps", "Array(UInt32)", false],
	["bid_boundary_price_by_band", "Array(Decimal(38,18))", false],
	["ask_boundary_price_by_band", "Array(Decimal(38,18))", false],
	["bid_depth_by_band", "Array(Decimal(38,18))", false],
	["ask_depth_by_band", "Array(Decimal(38,18))", false],
	["bid_status_by_band", "Array(Enum8('exact'=1,'censored'=2))", false],
	["ask_status_by_band", "Array(Enum8('exact'=1,'censored'=2))", false],
	["normalized_row_checksum", "String", false],
] as const;

export const ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELD_NAMES =
	ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELDS.map(([name]) => name);

const DECIMAL_38_18_FIELDS = new Set([
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
]);

const DECIMAL_38_18_ARRAY_FIELDS = new Set([
	"bid_boundary_price_by_band",
	"ask_boundary_price_by_band",
	"bid_depth_by_band",
	"ask_depth_by_band",
]);

/** Renders the value exactly as the canonical typed fixture represents Decimal(38,18). */
export function canonicalDecimal38(value: number | string): string {
	const rendered =
		typeof value === "number" ? canonicalDecimal(value) : value.trim();
	const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(rendered);
	if (!match) {
		throw new Error(`Invalid Decimal(38,18) value: ${rendered}`);
	}
	const sign = match[1] === "-" ? "-" : "";
	const integer = (match[2] ?? "0").replace(/^0+(?=\d)/, "");
	const fraction = match[3] ?? "";
	if (fraction.length > 18) {
		throw new Error(`Decimal(38,18) value exceeds scale 18: ${rendered}`);
	}
	if (integer.length + 18 > 38) {
		throw new Error(`Decimal(38,18) value exceeds precision 38: ${rendered}`);
	}
	const normalizedSign =
		/^0+$/.test(integer) && /^0*$/.test(fraction) ? "" : sign;
	return `${normalizedSign}${integer}.${fraction.padEnd(18, "0")}`;
}

/**
 * Produces the downstream-copyable, driver-independent supported-view shape.
 * Decimal columns are fixed-scale strings; integers, floats, enums and arrays
 * retain their typed JSON representation and field order is normative.
 */
export function projectOrderBookSummaryV2SupportedView(
	row: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELDS.map(([field]) => {
			const value = row[field];
			if (DECIMAL_38_18_FIELDS.has(field)) {
				if (typeof value !== "number" && typeof value !== "string") {
					throw new Error(`${field} must be a decimal`);
				}
				return [field, canonicalDecimal38(value)];
			}
			if (DECIMAL_38_18_ARRAY_FIELDS.has(field)) {
				if (!Array.isArray(value)) {
					throw new Error(`${field} must be a decimal array`);
				}
				return [
					field,
					value.map((entry) => {
						if (typeof entry !== "number" && typeof entry !== "string") {
							throw new Error(`${field} must contain decimals`);
						}
						return canonicalDecimal38(entry);
					}),
				];
			}
			return [field, value ?? null];
		}),
	);
}
