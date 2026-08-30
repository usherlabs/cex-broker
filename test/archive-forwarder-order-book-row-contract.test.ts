import { describe, expect, test } from "bun:test";
import {
	ORDER_BOOK_LEVEL_FIELDS,
	ORDER_BOOK_SUMMARY_V2_FIELDS,
	validateRetainedOrderBookRow,
} from "../services/archive-forwarder/order-book-row-contract";
import { parseArchiveBatchRequest } from "../services/archive-forwarder/router";
import { sha256Canonical } from "../src/helpers/market-data-archive/capture-contract";

const deploymentId = "deploy-live-a";
const source = "broker_read";

function levelRow(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const row = {
		source,
		deployment_id: deploymentId,
		capture_bundle_id: "bundle-a",
		exchange: "binance",
		symbol: "BTC/USDT",
		trading_pair: "BTC-USDT",
		source_symbol: "BTC/USDT",
		asset_type: "spot",
		feed: "ORDERBOOK",
		provider: "ccxt:binance",
		source_mode: "broker_public_feed_v1",
		source_time_ms: 1_900_000_000_000,
		received_time_ms: 1_900_000_000_010,
		raw_capture_id: "raw-a",
		raw_capture_scope: "ccxt_normalized_object",
		schema_version: "1.0.0",
		checksum_algorithm: "sha256",
		raw_checksum: "raw-checksum-a",
		provenance_complete: 1,
		snapshot_id: "snapshot-a",
		construction_mode: "sampled_top_n_snapshot",
		gap_policy: "record_gap",
		depth_limit: 25,
		sequence: null,
		exact_l2_reconstruction_complete: 0,
		side: "bid",
		level_index: 0,
		price: "100.000000000000000000",
		amount: "2.000000000000000000",
		notional: "200.000000000000000000",
		mid_price: "100.500000000000000000",
		spread_from_mid_bps: 49.75124378109453,
		normalized_row_checksum: "",
		...overrides,
	};
	return { ...row, normalized_row_checksum: sha256Canonical(row) };
}

function summaryRow(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const row = {
		source,
		deployment_id: deploymentId,
		capture_bundle_id: "bundle-a",
		exchange: "binance",
		symbol: "BTC/USDT",
		trading_pair: "BTC-USDT",
		source_symbol: "BTC/USDT",
		asset_type: "spot",
		feed: "ORDERBOOK",
		provider: "ccxt:binance",
		source_mode: "broker_public_feed_v1",
		source_time_ms: 1_900_000_000_000,
		received_time_ms: 1_900_000_000_010,
		raw_capture_id: "raw-a",
		raw_capture_scope: "ccxt_normalized_object",
		schema_version: "2.0.0",
		checksum_algorithm: "sha256",
		raw_checksum: "raw-checksum-a",
		provenance_complete: 1,
		snapshot_id: "snapshot-a",
		construction_mode: "sampled_top_n_snapshot",
		gap_policy: "record_gap",
		depth_limit: 25,
		sequence: null,
		exact_l2_reconstruction_complete: 0,
		capture_profile_id: "binance-live-depth-100-v1",
		effective_cadence_ms: 250,
		requested_upstream_depth: 100,
		observed_bid_count: 100,
		observed_ask_count: 100,
		observed_farthest_bid: "90.000000000000000000",
		observed_farthest_ask: "111.000000000000000000",
		retained_farthest_bid: "98.000000000000000000",
		retained_farthest_ask: "103.000000000000000000",
		bid_exhausted: 0,
		ask_exhausted: 0,
		best_bid: "100.000000000000000000",
		best_ask: "101.000000000000000000",
		best_bid_amount: "2.000000000000000000",
		best_ask_amount: "3.000000000000000000",
		mid_price: "100.500000000000000000",
		spread: "1.000000000000000000",
		spread_bps: 99.50248756218906,
		staleness_ms: 10,
		bid_level_count: 25,
		ask_level_count: 25,
		measurement_bands_bps: [10, 25, 50, 100],
		bid_boundary_price_by_band: [
			"100.399500000000000000",
			"100.248750000000000000",
			"99.997500000000000000",
			"99.495000000000000000",
		],
		ask_boundary_price_by_band: [
			"100.600500000000000000",
			"100.751250000000000000",
			"101.002500000000000000",
			"101.505000000000000000",
		],
		bid_depth_by_band: ["0", "0", "2", "4"],
		ask_depth_by_band: ["0", "0", "3", "6"],
		bid_status_by_band: ["exact", "exact", "exact", "exact"],
		ask_status_by_band: ["exact", "exact", "exact", "exact"],
		normalized_row_checksum: "",
		...overrides,
	};
	return { ...row, normalized_row_checksum: sha256Canonical(row) };
}

function validation(table: string, row: Record<string, unknown>) {
	return validateRetainedOrderBookRow({ table, row }, source, deploymentId);
}

describe("retained live order-book row contract", () => {
	test("accepts only exact broker schema-v1 levels and complete schema-v2 summaries", () => {
		expect(Object.keys(levelRow())).toHaveLength(
			ORDER_BOOK_LEVEL_FIELDS.length,
		);
		expect(Object.keys(summaryRow())).toHaveLength(
			ORDER_BOOK_SUMMARY_V2_FIELDS.length,
		);
		expect(validation("market_data.cex_order_book_levels", levelRow())).toEqual(
			{
				ok: true,
			},
		);
		expect(
			validation("market_data.cex_order_book_depth_summary", summaryRow()),
		).toEqual({ ok: true });
	});

	test("rejects summary v1, incomplete provenance, defaults, malformed arrays, and strategy provenance", () => {
		for (const row of [
			summaryRow({ schema_version: "1.0.0" }),
			summaryRow({ provenance_complete: 0 }),
			summaryRow({ capture_profile_id: "" }),
			summaryRow({ effective_cadence_ms: 0 }),
			summaryRow({
				bid_status_by_band: ["exact", "unknown", "exact", "exact"],
			}),
			summaryRow({ ask_depth_by_band: ["1"] }),
			summaryRow({ observed_bid_count: 0 }),
			summaryRow({ producer_id: "maker" }),
		]) {
			expect(
				validation("market_data.cex_order_book_depth_summary", row).ok,
			).toBe(false);
		}
	});

	test("rejects mislabeled levels and envelope identity disagreement", () => {
		for (const row of [
			levelRow({ schema_version: "2.0.0" }),
			levelRow({ provenance_complete: 0 }),
			levelRow({ side: "buy" }),
			levelRow({ level_index: 25 }),
			levelRow({ deployment_id: "other-deployment" }),
			levelRow({ source: "external_backfill" }),
		]) {
			expect(validation("market_data.cex_order_book_levels", row).ok).toBe(
				false,
			);
		}
	});

	test("rejects the whole parsed batch before insertion when any retained row is invalid", () => {
		const parsed = parseArchiveBatchRequest({
			source,
			deployment_id: deploymentId,
			rows: [
				{ table: "market_data.cex_order_book_levels", row: levelRow() },
				{
					table: "market_data.cex_order_book_depth_summary",
					row: summaryRow({ schema_version: "1.0.0" }),
				},
			],
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.rejectedRowCount).toBe(1);
		expect(parsed.rejectedRowsByTable).toEqual({
			"market_data.cex_order_book_depth_summary": 1,
		});
	});

	test("same-key checksum conflicts are rejected only after both rows pass v2 validation", () => {
		const parsed = parseArchiveBatchRequest({
			source,
			deployment_id: deploymentId,
			rows: [
				{
					table: "market_data.cex_order_book_depth_summary",
					row: summaryRow({ bid_depth_by_band: ["0", "0", "2", "4"] }),
				},
				{
					table: "market_data.cex_order_book_depth_summary",
					row: summaryRow({ bid_depth_by_band: ["0", "0", "2", "5"] }),
				},
			],
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.batch.rows).toHaveLength(0);
		expect(parsed.checksumConflictsByTable).toEqual({
			"market_data.cex_order_book_depth_summary": 2,
		});
	});
});
