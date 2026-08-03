import { describe, expect, test } from "bun:test";
import { parseReplayValidationConfig } from "../scripts/validate-canonical-market-replay";

const migrationPath = new URL(
	"../schema/clickhouse/migrations/canonical_market_data_replay_cutover.sql",
	import.meta.url,
);
const replayPath = new URL(
	"../schema/clickhouse/canonical_market_data_replay.sql",
	import.meta.url,
);
const backfillPath = new URL(
	"../scripts/backfill-canonical-market-data.ts",
	import.meta.url,
);

function executableSql(sql: string): string {
	return sql
		.split("\n")
		.map((line) => line.replace(/--.*$/, ""))
		.join("\n");
}

describe("canonical market-data migration contracts", () => {
	test("replay validation config covers explicit strategy pair windows", () => {
		expect(
			parseReplayValidationConfig({
				windows: [
					{
						captureBundleIds: ["bundle-a"],
						exchange: "binance",
						tradingPair: "BTC-USDT",
						startTimeMs: 100,
						endTimeMs: 200,
					},
					{
						captureBundleIds: ["bundle-a", "bundle-b"],
						exchange: "coinbase",
						tradingPair: "ETH-USD",
						startTimeMs: 200,
						endTimeMs: 300,
					},
				],
			}),
		).toHaveLength(2);
		expect(() => parseReplayValidationConfig({ windows: [] })).toThrow(
			"validation window",
		);
		expect(() =>
			parseReplayValidationConfig({
				windows: [
					{
						captureBundleIds: [],
						exchange: "binance",
						tradingPair: "BTC-USDT",
						startTimeMs: 200,
						endTimeMs: 100,
					},
				],
			}),
		).toThrow("Invalid replay validation config");
	});

	test("cutover and rollback preserve both legacy and canonical data", async () => {
		const migration = await Bun.file(migrationPath).text();
		expect(executableSql(migration)).not.toMatch(/\bDROP\b/i);
		expect(migration).toContain("CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE=dual");
		expect(migration).toContain(
			"orderbook_snapshots + canonical levels/summary",
		);
		expect(migration).toContain("candles + cex_ohlcv");
		expect(migration).toContain("market_data.orderbook_snapshots_legacy");
		expect(migration).toContain("market_data.candles_legacy");
		expect(migration).toContain("market_data.candles_closed_legacy");
		expect(migration).toContain("ROLLBACK");
		expect(migration).toContain("rename—not drop");
	});

	test("backfill is bounded, dry-run by default, and writes both legacy families", async () => {
		const backfill = await Bun.file(backfillPath).text();
		expect(backfill).toContain("CEX_BROKER_BACKFILL_START_TIME_MS");
		expect(backfill).toContain("CEX_BROKER_BACKFILL_END_TIME_MS");
		expect(backfill).toContain("CEX_BROKER_CANONICAL_BACKFILL_CONFIRM");
		expect(backfill).toContain('readLegacyRows("orderbook_snapshots"');
		expect(backfill).toContain('readLegacyRows("candles"');
		expect(backfill).toContain("buildLegacyOrderBookBackfillRows");
		expect(backfill).toContain("buildLegacyOhlcvBackfillRow");
	});

	test("replay is windowed and conflict-preflighted before canonical reads", async () => {
		const replay = await Bun.file(replayPath).text();
		expect(replay.indexOf("cex_order_book_levels_conflicts")).toBeLessThan(
			replay.indexOf("cex_order_book_levels_canonical"),
		);
		expect(
			replay.indexOf("cex_order_book_depth_summary_conflicts"),
		).toBeLessThan(replay.indexOf("cex_order_book_depth_summary_canonical"));
		for (const filter of [
			"capture_bundle_ids",
			"exchange",
			"trading_pair",
			"start_time_ms",
			"end_time_ms",
		]) {
			expect(replay).toContain(filter);
		}
	});
});
