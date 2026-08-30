import { describe, expect, test } from "bun:test";
import { buildLegacyOrderBookMigrationRows } from "../src/helpers/market-data-archive/legacy-migration";

describe("legacy order-book migration boundary", () => {
	test("emits bounded incomplete-provenance schema-v1 levels and no summary", () => {
		const rows = buildLegacyOrderBookMigrationRows({
			deployment_id: "legacy-migration-test",
			exchange: "binance",
			asset_type: "spot",
			symbol: "BTC/USDT",
			event_time_ms: 1_900_000_000_000,
			received_time_ms: 1_900_000_000_010,
			depth_limit: 2,
			bids_price: [100, 99, 98],
			bids_size: [1, 2, 3],
			asks_price: [101, 102, 103],
			asks_size: [4, 5, 6],
		});
		expect(rows).toHaveLength(4);
		expect(
			rows.every(({ table }) => table === "market_data.cex_order_book_levels"),
		).toBe(true);
		expect(rows.map(({ row }) => row.side)).toEqual([
			"bid",
			"bid",
			"ask",
			"ask",
		]);
		for (const { row } of rows) {
			expect(row.schema_version).toBe("1.0.0");
			expect(row.source_mode).toBe("legacy_migration_v1");
			expect(row.provenance_complete).toBe(0);
			expect(row.capture_bundle_id).toBeNull();
			expect(row.raw_capture_id).toBeNull();
			expect(row.raw_checksum).toBeNull();
		}
	});
});
