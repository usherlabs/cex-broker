import { createHash } from "node:crypto";
import { redactStreamPayload } from "../broker-execution-archive/redact";
import type { BrokerArchiveSource } from "../broker-execution-archive/types";
import type {
	MarketCaptureContext,
	RawCapture,
	RawCaptureScope,
} from "./types";

export const MARKET_CAPTURE_SCHEMA_VERSION = "1.0.0" as const;
export const CHECKSUM_ALGORITHM = "sha256-canonical-json-v1" as const;

export const ARCHIVE_SOURCES = ["broker_read", "broker_write"] as const;
export const CAPTURE_FEEDS = [
	"ORDERBOOK",
	"TICKER",
	"TRADES",
	"OHLCV",
] as const;
export const SOURCE_MODES = [
	"broker_live_stream_v1",
	"broker_live_sampling_v1",
	"broker_current_snapshot_v1",
	"broker_bootstrap_fetch_v1",
	"external_ccxt_fallback_v1",
	"external_hummingbot_fallback_v1",
	"legacy_migration_v1",
] as const;
export const CONSTRUCTION_MODES = [
	"sampled_top_n_snapshot",
	"exact_l2_reconstruction",
] as const;
export const GAP_POLICIES = [
	"record_gap",
	"ohlcv_catch_up",
	"fail_fast",
] as const;
export const RAW_CAPTURE_SCOPES = [
	"ccxt_normalized_object",
	"broker_visible_payload",
	"exchange_wire_frame",
] as const;

export type CaptureFeed = (typeof CAPTURE_FEEDS)[number];
export type SourceMode = (typeof SOURCE_MODES)[number];
export type ConstructionMode = (typeof CONSTRUCTION_MODES)[number];
export type GapPolicy = (typeof GAP_POLICIES)[number];

const CHECKSUM_FIELDS = new Set([
	"normalized_row_checksum",
	"raw_checksum",
	"checksum",
]);

/**
 * Renders a finite JavaScript number as a plain decimal. Exponent expansion and
 * negative-zero normalization are part of checksum algorithm v1 and are mirrored
 * by the Python fixture verifier.
 */
export function canonicalDecimal(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error("Canonical numbers must be finite");
	}
	if (Object.is(value, -0)) {
		return "0";
	}
	const rendered = String(value).toLowerCase();
	if (!rendered.includes("e")) {
		return rendered;
	}
	const [coefficient = "0", exponentText = "0"] = rendered.split("e");
	const exponent = Number.parseInt(exponentText, 10);
	const negative = coefficient.startsWith("-");
	const unsigned = negative ? coefficient.slice(1) : coefficient;
	const [integer = "0", fraction = ""] = unsigned.split(".");
	const digits = `${integer}${fraction}`;
	const decimalIndex = integer.length + exponent;
	let result: string;
	if (decimalIndex <= 0) {
		result = `0.${"0".repeat(-decimalIndex)}${digits}`;
	} else if (decimalIndex >= digits.length) {
		result = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
	} else {
		result = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
	}
	return negative ? `-${result}` : result;
}

function serializeCanonical(value: unknown, stack: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return canonicalDecimal(value);
	if (typeof value === "bigint") return value.toString(10);
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw new Error("Canonical timestamps must be valid");
		}
		return value.getTime().toString(10);
	}
	if (Array.isArray(value)) {
		if (stack.has(value)) throw new Error("Canonical values must be acyclic");
		stack.add(value);
		const result = `[${value
			.map((entry) =>
				entry === undefined ? "null" : serializeCanonical(entry, stack),
			)
			.join(",")}]`;
		stack.delete(value);
		return result;
	}
	if (typeof value === "object") {
		if (stack.has(value)) throw new Error("Canonical values must be acyclic");
		stack.add(value);
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		const result = `{${entries
			.map(
				([key, entry]) =>
					`${JSON.stringify(key)}:${serializeCanonical(entry, stack)}`,
			)
			.join(",")}}`;
		stack.delete(value);
		return result;
	}
	throw new Error(`Unsupported canonical value type: ${typeof value}`);
}

export function canonicalSerialize(value: unknown): string {
	return serializeCanonical(value, new Set());
}

function omitChecksumFields(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(omitChecksumFields);
	if (value && typeof value === "object" && !(value instanceof Date)) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([key]) => !CHECKSUM_FIELDS.has(key))
				.map(([key, entry]) => [key, omitChecksumFields(entry)]),
		);
	}
	return value;
}

export function sha256Canonical(value: unknown): string {
	return createHash("sha256")
		.update(canonicalSerialize(omitChecksumFields(value)))
		.digest("hex");
}

export function normalizeTimestampMs(value: unknown, field: string): number {
	let timestamp: number;
	if (value instanceof Date) {
		timestamp = value.getTime();
	} else if (typeof value === "number") {
		timestamp = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		timestamp = Number(value.trim());
	} else if (typeof value === "string") {
		timestamp = Date.parse(value);
	} else {
		timestamp = Number.NaN;
	}
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new Error(`${field} must be a non-negative millisecond timestamp`);
	}
	return timestamp;
}

function assertCaptureContext(context: MarketCaptureContext): void {
	if (!(ARCHIVE_SOURCES as readonly string[]).includes(context.source)) {
		throw new Error(`Unsupported archive source: ${context.source}`);
	}
	if (!(CAPTURE_FEEDS as readonly string[]).includes(context.feed)) {
		throw new Error(`Unsupported capture feed: ${context.feed}`);
	}
	if (!(SOURCE_MODES as readonly string[]).includes(context.sourceMode)) {
		throw new Error(`Unsupported source mode: ${context.sourceMode}`);
	}
	for (const [field, value] of [
		["deployment_id", context.deploymentId],
		["capture_bundle_id", context.captureBundleId],
		["exchange", context.exchange],
		["symbol", context.symbol],
		["provider", context.provider],
	] as const) {
		if (!value.trim()) throw new Error(`${field} must not be empty`);
	}
}

export function createRawCapture(
	context: MarketCaptureContext,
	input: {
		payload: unknown;
		eventTimeMs: unknown;
		receivedTimeMs: unknown;
		scope: RawCaptureScope;
	},
): RawCapture {
	assertCaptureContext(context);
	if (!(RAW_CAPTURE_SCOPES as readonly string[]).includes(input.scope)) {
		throw new Error(`Unsupported raw capture scope: ${input.scope}`);
	}
	const eventTimeMs = normalizeTimestampMs(input.eventTimeMs, "event_time_ms");
	const receivedTimeMs = normalizeTimestampMs(
		input.receivedTimeMs,
		"received_time_ms",
	);
	const redactedPayload = redactStreamPayload(input.payload);
	const rawChecksum = sha256Canonical(redactedPayload);
	const rawCaptureId = sha256Canonical({
		capture_bundle_id: context.captureBundleId,
		exchange: context.exchange.trim().toLowerCase(),
		feed: context.feed,
		raw_capture_scope: input.scope,
		raw_payload_sha256: rawChecksum,
		schema_version: context.schemaVersion,
		source_mode: context.sourceMode,
		source_symbol: context.symbol.trim(),
		source_time_ms: eventTimeMs,
	});
	return {
		rawCaptureId,
		rawCaptureScope: input.scope,
		rawChecksum,
		redactedPayload,
		eventTimeMs,
		receivedTimeMs,
		checksumAlgorithm: context.checksumAlgorithm,
	};
}

export function captureCoreFields(
	context: MarketCaptureContext,
	rawCapture: RawCapture,
): Record<string, unknown> {
	assertCaptureContext(context);
	return {
		source: context.source satisfies BrokerArchiveSource,
		deployment_id: context.deploymentId,
		capture_bundle_id: context.captureBundleId,
		exchange: context.exchange.trim().toLowerCase(),
		symbol: context.symbol.trim(),
		trading_pair: context.symbol.trim().replace("/", "-"),
		source_symbol: context.symbol.trim(),
		asset_type: context.assetType,
		feed: context.feed,
		provider: context.provider,
		source_mode: context.sourceMode,
		source_time_ms: rawCapture.eventTimeMs,
		received_time_ms: rawCapture.receivedTimeMs,
		raw_capture_id: rawCapture.rawCaptureId,
		raw_capture_scope: rawCapture.rawCaptureScope,
		schema_version: context.schemaVersion,
		checksum_algorithm: context.checksumAlgorithm,
		raw_checksum: rawCapture.rawChecksum,
		provenance_complete: context.provenanceComplete ? 1 : 0,
	};
}
