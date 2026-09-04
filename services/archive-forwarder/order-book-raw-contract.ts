import { canonicalSerialize, sha256Canonical } from "../../src/helpers/market-data-archive/capture-contract";
import {
	MAX_ORDERBOOK_MEASUREMENT_BAND_BPS,
	MAX_ORDERBOOK_MEASUREMENT_BANDS,
} from "../../src/helpers/market-data-archive/orderbook-depth";
import type { ArchiveBatchRequest } from "./types";

const RAW_TABLE = "market_data.cex_stream_events";
const METADATA_KEYS = [
	"capture_profile_id",
	"effective_cadence_ms",
	"requested_upstream_depth",
	"archive_depth_limit",
	"observed_bid_count",
	"observed_ask_count",
	"observed_farthest_bid",
	"observed_farthest_ask",
	"bid_exhausted",
	"ask_exhausted",
	"retained_bid_count",
	"retained_ask_count",
	"measurement_bands_bps",
] as const;

export type OrderBookRawValidation =
	| { ok: true }
	| { ok: false; error: string };

function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
	return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
}

function positiveDecimalString(value: unknown): boolean {
	return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0;
}

export function validateOrderBookRawRow(
	entry: ArchiveBatchRequest["rows"][number],
	envelopeSource: string,
	envelopeDeploymentId: string,
): OrderBookRawValidation {
	if (entry.table !== RAW_TABLE || entry.row.feed !== "ORDERBOOK") return { ok: true };
	const row = entry.row;
	if (
		row.source !== envelopeSource ||
		row.deployment_id !== envelopeDeploymentId ||
		(row.source !== "broker_read" && row.source !== "broker_write")
	) {
		return { ok: false, error: "ORDERBOOK raw identity must match the broker envelope" };
	}
	if (
		row.schema_version !== "1.0.0" ||
		row.provenance_complete !== 1 ||
		row.payload_encoding !== "orderbook_metadata_only_v1" ||
		typeof row.payload_json !== "string"
	) {
		return { ok: false, error: "ORDERBOOK raw row must use metadata-only schema v1" };
	}
	let metadata: Record<string, unknown>;
	try {
		metadata = JSON.parse(row.payload_json) as Record<string, unknown>;
	} catch {
		return { ok: false, error: "ORDERBOOK metadata JSON is invalid" };
	}
	if (
		Object.keys(metadata).sort().join("\0") !== [...METADATA_KEYS].sort().join("\0") ||
		canonicalSerialize(metadata) !== row.payload_json
	) {
		return { ok: false, error: "ORDERBOOK metadata keys or canonical encoding are invalid" };
	}
	if (
		typeof metadata.capture_profile_id !== "string" ||
		!metadata.capture_profile_id.trim() ||
		!positiveInteger(metadata.effective_cadence_ms, 4_294_967_295) ||
		!(metadata.requested_upstream_depth === null || positiveInteger(metadata.requested_upstream_depth, 500)) ||
		!positiveInteger(metadata.archive_depth_limit, 500) ||
		!positiveInteger(metadata.observed_bid_count) ||
		!positiveInteger(metadata.observed_ask_count) ||
		!positiveDecimalString(metadata.observed_farthest_bid) ||
		!positiveDecimalString(metadata.observed_farthest_ask) ||
		typeof metadata.bid_exhausted !== "boolean" ||
		typeof metadata.ask_exhausted !== "boolean" ||
		!positiveInteger(metadata.retained_bid_count, 500) ||
		!positiveInteger(metadata.retained_ask_count, 500) ||
		Number(metadata.retained_bid_count) > Number(metadata.archive_depth_limit) ||
		Number(metadata.retained_ask_count) > Number(metadata.archive_depth_limit) ||
		Number(metadata.retained_bid_count) > Number(metadata.observed_bid_count) ||
		Number(metadata.retained_ask_count) > Number(metadata.observed_ask_count) ||
		!Array.isArray(metadata.measurement_bands_bps) ||
		metadata.measurement_bands_bps.length === 0 ||
		metadata.measurement_bands_bps.length > MAX_ORDERBOOK_MEASUREMENT_BANDS ||
		!metadata.measurement_bands_bps.every((band, index, bands) =>
			positiveInteger(band, MAX_ORDERBOOK_MEASUREMENT_BAND_BPS) &&
			(index === 0 || Number(band) > Number(bands[index - 1])),
		)
	) {
		return { ok: false, error: "ORDERBOOK metadata values are invalid" };
	}
	if (
		typeof row.normalized_row_checksum !== "string" ||
		!/^[a-f0-9]{64}$/.test(row.normalized_row_checksum) ||
		row.normalized_row_checksum !== sha256Canonical(row)
	) {
		return { ok: false, error: "ORDERBOOK raw normalized checksum is invalid" };
	}
	return { ok: true };
}
