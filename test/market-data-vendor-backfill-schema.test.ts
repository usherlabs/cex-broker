import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SUPPORTED_TABLES } from "../services/archive-forwarder/types";

const schema = readFileSync(
	new URL("../schema/clickhouse/market_data.sql", import.meta.url),
	"utf8",
);
const exporter = readFileSync(
	new URL("../scripts/export-canonical-orderbook-parquet.ts", import.meta.url),
	"utf8",
);

describe("external market-data qualification schema", () => {
	test("declares the append-only promotion inventory", () => {
		expect(SUPPORTED_TABLES).toContain(
			"market_data.cex_order_book_capture_promotions",
		);
		expect(schema).toContain(
			"CREATE TABLE IF NOT EXISTS market_data.cex_order_book_capture_promotions",
		);
		for (const field of [
			"receipt_id",
			"capture_bundle_id",
			"window_start_ms",
			"window_end_ms",
			"depth_limit",
			"construction_mode",
			"canonical_semantic_digest",
			"prefix_digest",
			"suffix_digest",
			"verification_time_ms",
		]) {
			expect(schema).toContain(field);
		}
	});

	test("qualifies external canonical rows only through an exact-scope passing join", () => {
		for (const view of [
			"cex_order_book_levels_replay_qualified",
			"cex_order_book_depth_summary_replay_qualified",
		]) {
			expect(schema).toContain(`CREATE VIEW IF NOT EXISTS market_data.${view}`);
		}
		for (const binding of [
			"capture_bundle_id",
			"exchange",
			"trading_pair",
			"window_start_ms",
			"window_end_ms",
			"depth_limit",
			"construction_mode",
			"schema_version",
		]) {
			expect(schema).toContain(binding);
		}
		expect(schema).toContain("AND status = 'passing'");
		expect(schema).toContain("canonical.source = 'external_backfill'");
		expect(schema).toContain(
			"canonical.source IN ('broker_read', 'broker_write')",
		);
	});

	test("keeps live TTL but exempts external historical evidence", () => {
		const conditionalTtls = schema.match(
			/INTERVAL 90 DAY\s+DELETE WHERE source != 'external_backfill'/g,
		);
		expect(conditionalTtls?.length).toBeGreaterThanOrEqual(2);
	});

	test("the retained exporter selects qualified views and returns promotion identity", () => {
		expect(exporter).toContain(
			"market_data.cex_order_book_levels_replay_qualified",
		);
		expect(exporter).toContain(
			"market_data.cex_order_book_depth_summary_replay_qualified",
		);
		expect(exporter).toContain("promotionReceiptIds");
	});
});
