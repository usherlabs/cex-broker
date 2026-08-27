import { sha256Canonical } from "../../src/helpers/market-data-archive/capture-contract";
import { EXTERNAL_BACKFILL_DEPLOYMENT_ID } from "../../src/helpers/market-data-vendor-backfill/contracts";
import { promotionReceiptFromArchiveRow } from "../../src/helpers/market-data-vendor-backfill/promotion";
import { qualificationEventFromArchiveRow } from "../../src/helpers/market-data-vendor-backfill/qualification";
import { archiveSelectionFromArchiveRow } from "../../src/helpers/market-data-vendor-backfill/selection";
import type { ArchiveBatchRequest, ArchiveRow } from "./types";

export const EXTERNAL_BACKFILL_SOURCE = "external_backfill";
export const PROMOTION_TABLE =
	"market_data.cex_order_book_capture_promotions" as const;
export const QUALIFICATION_TABLE =
	"market_data.cex_order_book_capture_qualifications" as const;
export const SELECTION_TABLE =
	"market_data.cex_order_book_archive_selections" as const;
const EVIDENCE_TABLES: ReadonlySet<string> = new Set([
	PROMOTION_TABLE,
	QUALIFICATION_TABLE,
	SELECTION_TABLE,
]);
const CANDIDATE_TABLES: ReadonlySet<string> = new Set([
	"market_data.cex_order_book_levels",
	"market_data.cex_order_book_depth_summary",
]);
const CANDIDATE_CONSTRUCTION_MODES: ReadonlySet<string> = new Set([
	"sampled_top_n_snapshot",
	"policy_neutral_top_n_state_change_tape/v1",
]);
const UINT64_MAX = 18_446_744_073_709_551_615n;
const ENVELOPE_FIELDS = new Set(["source", "deployment_id", "batch_id", "rows"]);
const COMMON_CANDIDATE_FIELDS = [
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
	"source_time_ms",
	"received_time_ms",
	"raw_capture_id",
	"raw_capture_scope",
	"schema_version",
	"checksum_algorithm",
	"raw_checksum",
	"provenance_complete",
	"snapshot_id",
	"construction_mode",
	"gap_policy",
	"depth_limit",
	"sequence",
	"exact_l2_reconstruction_complete",
	"normalized_row_checksum",
] as const;
const LEVEL_FIELDS = new Set([
	...COMMON_CANDIDATE_FIELDS,
	"side",
	"level_index",
	"price",
	"amount",
	"notional",
	"mid_price",
	"spread_from_mid_bps",
]);
const SUMMARY_FIELDS = new Set([
	...COMMON_CANDIDATE_FIELDS,
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
	"bid_depth_by_band",
	"ask_depth_by_band",
]);
const PROMOTION_FIELDS = new Set([
	"source",
	"capture_origin",
	"source_mode",
	"deployment_id",
	"receipt_schema_version",
	"receipt_id",
	"promotion_identity_sha256",
	"request_id",
	"idempotency_key",
	"status",
	"capture_bundle_id",
	"provider",
	"adapter_version",
	"exchange",
	"trading_pair",
	"asset_type",
	"feed",
	"window_start_ms",
	"window_end_ms",
	"depth_limit",
	"construction_mode",
	"schema_version",
	"canonical_schema_sha256",
	"checksum_algorithm",
	"coverage_policy_json",
	"selection_sha256",
	"capability_policy_id",
	"capability_policy_sha256",
	"resource_policy_id",
	"resource_policy_sha256",
	"adapter_policy_id",
	"adapter_policy_sha256",
	"acquisition_policy_id",
	"acquisition_policy_sha256",
	"vendor_semantic_digest",
	"canonical_semantic_digest",
	"prefix_digest",
	"suffix_digest",
	"seam_verified",
	"coverage_verified",
	"dataset_objects_json",
	"receipt_json",
	"verification_time_ms",
]);
const QUALIFICATION_FIELDS = new Set([
	"source",
	"capture_origin",
	"source_mode",
	"deployment_id",
	"qualification_event_id",
	"capture_bundle_id",
	"state",
	"receipt_id",
	"promotion_identity_sha256",
	"window_start_ms",
	"window_end_ms",
	"event_at_ms",
	"reason_code",
	"event_json",
]);
const SELECTION_FIELDS = new Set([
	"source",
	"deployment_id",
	"request_id",
	"idempotency_key",
	"selection_sha256",
	"coverage_class",
	"receipt_ids",
	"request_json",
	"selection_json",
	"resolved_at_ms",
]);

export type ExternalBackfillClassification =
	| "direct"
	| "candidate"
	| "promotion"
	| "qualification"
	| "selection"
	| "invalid_external_source"
	| "invalid_external_mix";

function rawRows(value: unknown): unknown[] {
	if (!value || typeof value !== "object") return [];
	const rows = (value as { rows?: unknown }).rows;
	return Array.isArray(rows) ? rows : [];
}

function tableOf(entry: unknown): unknown {
	return entry && typeof entry === "object"
		? (entry as { table?: unknown }).table
		: undefined;
}

export function classifyExternalBackfillBatch(
	value: unknown,
): ExternalBackfillClassification {
	const rows = rawRows(value);
	const source =
		value && typeof value === "object"
			? (value as { source?: unknown }).source
			: undefined;
	const hasEvidence = rows.some((entry) =>
		EVIDENCE_TABLES.has(String(tableOf(entry))),
	);
	if (source !== EXTERNAL_BACKFILL_SOURCE) {
		return hasEvidence ? "invalid_external_source" : "direct";
	}
	if (rows.length === 0) return "invalid_external_mix";
	for (const [table, classification] of [
		[PROMOTION_TABLE, "promotion"],
		[QUALIFICATION_TABLE, "qualification"],
		[SELECTION_TABLE, "selection"],
	] as const) {
		if (rows.every((entry) => tableOf(entry) === table)) {
			return rows.length === 1 ? classification : "invalid_external_mix";
		}
	}
	const candidateOnly = rows.every((entry) =>
		CANDIDATE_TABLES.has(String(tableOf(entry))),
	);
	return candidateOnly ? "candidate" : "invalid_external_mix";
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function sha256(value: unknown): boolean {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exactFields(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): boolean {
	return Object.keys(value).every((field) => allowed.has(field));
}

function safeUnsigned(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonnegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validSequence(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (safeUnsigned(value)) return true;
	return (
		typeof value === "string" &&
		/^\d+$/.test(value) &&
		BigInt(value) <= UINT64_MAX
	);
}

function numericArray(value: unknown, integers = false): value is number[] {
	return (
		Array.isArray(value) &&
		value.every((entry) =>
			integers ? safeUnsigned(entry) : nonnegativeFinite(entry),
		)
	);
}

function validCommonCandidate(
	row: Record<string, unknown>,
	source: string,
	deploymentId: string,
): boolean {
	return (
		row.source === source &&
		row.deployment_id === deploymentId &&
		sha256(row.capture_bundle_id) &&
		nonEmpty(row.exchange) &&
		nonEmpty(row.symbol) &&
		nonEmpty(row.trading_pair) &&
		nonEmpty(row.source_symbol) &&
		["spot", "swap", "future"].includes(String(row.asset_type)) &&
		row.feed === "ORDERBOOK" &&
		row.provider === "cryptohftdata" &&
		row.source_mode === "vendor_historical_backfill_v1" &&
		safeUnsigned(row.source_time_ms) &&
		safeUnsigned(row.received_time_ms) &&
		Number(row.received_time_ms) >= Number(row.source_time_ms) &&
		sha256(row.raw_capture_id) &&
		row.raw_capture_scope === "vendor_normalized_dataset_file" &&
		nonEmpty(row.schema_version) &&
		row.checksum_algorithm === "sha256-canonical-json-v1" &&
		sha256(row.raw_checksum) &&
		row.provenance_complete === 1 &&
		sha256(row.snapshot_id) &&
		CANDIDATE_CONSTRUCTION_MODES.has(String(row.construction_mode)) &&
		row.gap_policy === "record_gap" &&
		safeUnsigned(row.depth_limit) &&
		Number(row.depth_limit) > 0 &&
		Number(row.depth_limit) <= 500 &&
		validSequence(row.sequence) &&
		row.exact_l2_reconstruction_complete === 0 &&
		sha256(row.normalized_row_checksum) &&
		row.normalized_row_checksum === sha256Canonical(row)
	);
}

function validLevelRow(row: Record<string, unknown>): boolean {
	return (
		exactFields(row, LEVEL_FIELDS) &&
		(row.side === "bid" || row.side === "ask") &&
		safeUnsigned(row.level_index) &&
		Number(row.level_index) < Number(row.depth_limit) &&
		positiveFinite(row.price) &&
		positiveFinite(row.amount) &&
		positiveFinite(row.notional) &&
		positiveFinite(row.mid_price) &&
		nonnegativeFinite(row.spread_from_mid_bps)
	);
}

function validSummaryRow(row: Record<string, unknown>): boolean {
	if (
		!exactFields(row, SUMMARY_FIELDS) ||
		!positiveFinite(row.best_bid) ||
		!positiveFinite(row.best_ask) ||
		row.best_bid >= row.best_ask ||
		!positiveFinite(row.best_bid_amount) ||
		!positiveFinite(row.best_ask_amount) ||
		!positiveFinite(row.mid_price) ||
		!positiveFinite(row.spread) ||
		!positiveFinite(row.spread_bps) ||
		!safeUnsigned(row.staleness_ms) ||
		Number(row.staleness_ms) !==
			Number(row.received_time_ms) - Number(row.source_time_ms) ||
		!safeUnsigned(row.bid_level_count) ||
		!safeUnsigned(row.ask_level_count) ||
		Number(row.bid_level_count) < 1 ||
		Number(row.ask_level_count) < 1 ||
		Number(row.bid_level_count) > Number(row.depth_limit) ||
		Number(row.ask_level_count) > Number(row.depth_limit) ||
		!numericArray(row.measurement_bands_bps, true) ||
		!numericArray(row.bid_depth_by_band) ||
		!numericArray(row.ask_depth_by_band)
	) {
		return false;
	}
	return (
		row.measurement_bands_bps.length === row.bid_depth_by_band.length &&
		row.measurement_bands_bps.length === row.ask_depth_by_band.length &&
		row.measurement_bands_bps.every(
			(band, index) =>
				band > 0 &&
				(index === 0 || band > (row.measurement_bands_bps[index - 1] ?? 0)),
		)
	);
}

function validCandidateRow(
	entry: ArchiveRow,
	source: string,
	deploymentId: string,
): boolean {
	const row = entry.row;
	return (
		CANDIDATE_TABLES.has(entry.table) &&
		validCommonCandidate(row, source, deploymentId) &&
		(entry.table === "market_data.cex_order_book_levels"
			? validLevelRow(row)
			: validSummaryRow(row))
	);
}

export function validateExternalBackfillBatch(
	value: unknown,
): { ok: true } | { ok: false; error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, error: "Malformed external backfill envelope" };
	}
	const envelope = value as Partial<ArchiveBatchRequest>;
	if (
		envelope.source !== EXTERNAL_BACKFILL_SOURCE ||
		envelope.deployment_id !== EXTERNAL_BACKFILL_DEPLOYMENT_ID ||
		!sha256(envelope.batch_id) ||
		!exactFields(value as Record<string, unknown>, ENVELOPE_FIELDS) ||
		!Array.isArray(envelope.rows)
	) {
		return { ok: false, error: "Invalid external backfill envelope identity" };
	}
	const classification = classifyExternalBackfillBatch(value);
	if (classification === "candidate") {
		return envelope.rows.every((entry) =>
			validCandidateRow(
				entry,
				envelope.source as string,
				envelope.deployment_id as string,
			),
		)
			? { ok: true }
			: { ok: false, error: "Invalid external backfill candidate provenance" };
	}
	if (classification === "promotion") {
		const entry = envelope.rows[0];
		if (!entry || entry.table !== PROMOTION_TABLE) {
			return { ok: false, error: "Invalid external backfill promotion table" };
		}
		if (
			entry.row.source !== envelope.source ||
			entry.row.deployment_id !== envelope.deployment_id ||
			!exactFields(entry.row, PROMOTION_FIELDS)
		) {
			return { ok: false, error: "Promotion identity does not match envelope" };
		}
		try {
			const receipt = promotionReceiptFromArchiveRow(entry.row);
			if (!("schema_id" in receipt)) {
				return { ok: false, error: "Provisional receipt cannot qualify final-v1 data" };
			}
			return { ok: true };
		} catch {
			return { ok: false, error: "Invalid passing promotion receipt" };
		}
	}
	if (classification === "qualification") {
		const entry = envelope.rows[0];
		if (
			!entry ||
			entry.table !== QUALIFICATION_TABLE ||
			entry.row.source !== envelope.source ||
			entry.row.deployment_id !== envelope.deployment_id ||
			!exactFields(entry.row, QUALIFICATION_FIELDS)
		) {
			return { ok: false, error: "Invalid qualification event identity" };
		}
		try {
			qualificationEventFromArchiveRow(entry.row);
			return { ok: true };
		} catch {
			return { ok: false, error: "Invalid qualification event" };
		}
	}
	if (classification === "selection") {
		const entry = envelope.rows[0];
		if (
			!entry ||
			entry.table !== SELECTION_TABLE ||
			entry.row.source !== envelope.source ||
			entry.row.deployment_id !== envelope.deployment_id ||
			!exactFields(entry.row, SELECTION_FIELDS)
		) {
			return { ok: false, error: "Invalid archive selection identity" };
		}
		try {
			archiveSelectionFromArchiveRow(entry.row);
			return { ok: true };
		} catch {
			return { ok: false, error: "Invalid archive selection" };
		}
	}
	return { ok: false, error: "Invalid external backfill source or table mix" };
}
