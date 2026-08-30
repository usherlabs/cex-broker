import { describe, expect, test } from "bun:test";
import { parseArchiveBatchRequest } from "../services/archive-forwarder/router";
import {
	canonicalSerialize,
	sha256Canonical,
} from "../src/helpers/market-data-archive/capture-contract";

function rawEntry(
	metadataOverrides: Record<string, unknown> = {},
	rowOverrides: Record<string, unknown> = {},
) {
	const metadata = {
		capture_profile_id: "binance:l2-diff:500",
		effective_cadence_ms: 1_000,
		requested_upstream_depth: 500,
		archive_depth_limit: 25,
		observed_bid_count: 100,
		observed_ask_count: 100,
		observed_farthest_bid: "99.000000000000000000",
		observed_farthest_ask: "101.000000000000000000",
		bid_exhausted: false,
		ask_exhausted: false,
		retained_bid_count: 25,
		retained_ask_count: 25,
		measurement_bands_bps: [10, 25, 50, 100],
		...metadataOverrides,
	};
	const withoutChecksum = {
		source: "broker_read",
		deployment_id: "market-reader-eu-1",
		capture_bundle_id: "bundle-a",
		exchange: "binance",
		symbol: "BTC/USDT",
		trading_pair: "BTC-USDT",
		source_symbol: "BTC/USDT",
		asset_type: "spot",
		stream_type: "ORDERBOOK",
		feed: "ORDERBOOK",
		provider: "ccxt:binance",
		source_mode: "broker_live_sampling_v1",
		source_time_ms: 1_700_000_000_000,
		received_time_ms: 1_700_000_000_001,
		raw_capture_id: "a".repeat(64),
		raw_capture_scope: "ccxt_normalized_object",
		schema_version: "1.0.0",
		checksum_algorithm: "sha256-canonical-json-v1",
		raw_checksum: "b".repeat(64),
		provenance_complete: 1,
		account_selector: undefined,
		broker_observed_timestamp: "2026-08-30T00:00:00.000Z",
		event_time_ms: 1_700_000_000_000,
		payload_encoding: "orderbook_metadata_only_v1",
		payload_json: canonicalSerialize(metadata),
		...rowOverrides,
	};
	const row = Object.fromEntries(
		Object.entries(withoutChecksum).filter(([, value]) => value !== undefined),
	);
	const withChecksum = {
		...row,
		normalized_row_checksum: sha256Canonical(row),
	};
	return {
		table: "market_data.cex_stream_events",
		row:
			typeof rowOverrides.normalized_row_checksum === "string"
				? {
						...withChecksum,
						normalized_row_checksum: rowOverrides.normalized_row_checksum,
					}
				: withChecksum,
	};
}

function parse(entry: ReturnType<typeof rawEntry>) {
	return parseArchiveBatchRequest({
		source: "broker_read",
		deployment_id: "market-reader-eu-1",
		rows: [entry],
	});
}

describe("ORDERBOOK metadata-only raw admission", () => {
	test("accepts the exact canonical 13-key projection", () => {
		const parsed = parse(rawEntry());
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.rejectedRowCount).toBe(0);
	});

	test.each([
		["full body", { bids: [[100, 1]] }, {}],
		["extra key", { extra: true }, {}],
		["missing key", {}, { payload_json: "{}" }],
		["wrong encoding", {}, { payload_encoding: "canonical_json_v1" }],
		["forged checksum", {}, { normalized_row_checksum: "c".repeat(64) }],
	])("rejects %s", (_name, metadata, row) => {
		const parsed = parse(
			rawEntry(
				metadata as Record<string, unknown>,
				row as Record<string, unknown>,
			),
		);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.rejectedRowCount).toBe(1);
	});
});
