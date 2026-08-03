import { describe, expect, test } from "bun:test";

const schemaPath = new URL(
	"../schema/clickhouse/strategy_data.sql",
	import.meta.url,
);

describe("strategy_data schema v2 contract", () => {
	test("fresh tables carry the six shared v2 identity fields", async () => {
		const sql = await Bun.file(schemaPath).text();
		const freshSchema = sql.split("-- Additive migration")[0];
		const columnDefinitions = freshSchema
			.split("\n")
			.map((line) => line.trim().replace(/,$/, ""));
		for (const definition of [
			"producer_id String DEFAULT ''",
			"producer_run_id String DEFAULT ''",
			"stream_name LowCardinality(String) DEFAULT ''",
			"stream_seq UInt64 DEFAULT 0",
			"seq UInt64 DEFAULT 0",
			"archive_event_id String DEFAULT ''",
		]) {
			expect(
				columnDefinitions.filter((line) => line === definition),
			).toHaveLength(5);
		}
	});

	test("applies shared fields additively to all five existing tables", async () => {
		const sql = await Bun.file(schemaPath).text();
		for (const column of [
			"producer_id",
			"producer_run_id",
			"stream_name",
			"stream_seq",
			"seq",
			"archive_event_id",
		]) {
			expect(
				sql.match(new RegExp(`ADD COLUMN IF NOT EXISTS ${column} `, "g")),
			).toHaveLength(5);
		}
	});

	test("includes Maker policy and identity/mapping extension fields", async () => {
		const sql = await Bun.file(schemaPath).text();
		for (const column of [
			"tick_id",
			"policy_revision",
			"decision_stage",
			"decision_outcome",
			"decision_reason",
			"source_clock",
			"action_ids_json",
			"content_hash",
			"revision",
			"active_from_ms",
			"canonical_market_id",
			"connector_id",
			"canonical_exchange",
			"canonical_trading_pair",
			"source_symbol",
			"base_asset",
			"quote_asset",
			"access_policy_id",
		]) {
			expect(sql).toContain(column);
		}
	});

	test("enables non-replicated insert deduplication on every table", async () => {
		const sql = await Bun.file(schemaPath).text();
		expect(
			sql.match(/non_replicated_deduplication_window = 1000000/g),
		).toHaveLength(10);
	});
});
