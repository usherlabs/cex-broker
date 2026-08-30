import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	ARCHIVE_SCHEMA_FILES,
	splitSqlStatements,
} from "../services/archive-forwarder/schema";

const schemaPath = path.join(
	import.meta.dir,
	"..",
	"schema",
	"clickhouse",
	"market_data.sql",
);
const schema = readFileSync(schemaPath, "utf8");
const normalizedSchema = schema.replace(/\s+/g, " ");
const migrationsPath = path.join(
	import.meta.dir,
	"..",
	"schema",
	"clickhouse",
	"migrations",
);

function migration(name: string): string {
	return readFileSync(path.join(migrationsPath, name), "utf8");
}

describe("final ClickHouse live/hot order-book schema", () => {
	test("fresh DDL has the exact v2 arrays and unconditional hot TTLs", () => {
		for (const column of [
			"capture_profile_id String",
			"effective_cadence_ms UInt32",
			"requested_upstream_depth Nullable(UInt16)",
			"observed_bid_count UInt32",
			"observed_ask_count UInt32",
			"observed_farthest_bid Decimal(38, 18)",
			"observed_farthest_ask Decimal(38, 18)",
			"retained_farthest_bid Decimal(38, 18)",
			"retained_farthest_ask Decimal(38, 18)",
			"bid_exhausted UInt8",
			"ask_exhausted UInt8",
			"bid_boundary_price_by_band Array(Decimal(38, 18))",
			"ask_boundary_price_by_band Array(Decimal(38, 18))",
			"bid_status_by_band Array(Enum8('exact' = 1, 'censored' = 2))",
			"ask_status_by_band Array(Enum8('exact' = 1, 'censored' = 2))",
		]) {
			expect(schema).toContain(column);
		}
		expect(
			(
				schema.match(
					/TTL toDateTime\(fromUnixTimestamp64Milli\(source_time_ms\)\) \+ INTERVAL 90 DAY/g,
				) ?? []
			).length,
		).toBe(2);
		expect(schema).not.toContain("DELETE WHERE source != 'external_backfill'");
	});

	test("fresh inventory omits vendor objects, compatibility views, and vendor columns", () => {
		for (const removed of [
			"cex_order_book_capture_promotions",
			"cex_order_book_capture_qualifications",
			"cex_order_book_archive_selections",
			"cex_archive_cluster_identity",
			"cex_order_book_levels_replay_qualified",
			"cex_order_book_depth_summary_replay_qualified",
			"capture_origin",
			"vendor_historical_backfill",
		]) {
			expect(schema).not.toContain(removed);
		}
	});

	test("canonical and conflict views are broker-only and version-closed", () => {
		for (const view of [
			"cex_order_book_levels_canonical",
			"cex_order_book_levels_conflicts",
			"cex_order_book_depth_summary_canonical",
			"cex_order_book_depth_summary_conflicts",
		]) {
			expect(schema).toContain(`CREATE OR REPLACE VIEW market_data.${view}`);
		}
		expect(normalizedSchema).toContain(
			"WHERE source IN ('broker_read', 'broker_write') AND schema_version = '1.0.0'",
		);
		expect(normalizedSchema).toContain(
			"WHERE source IN ('broker_read', 'broker_write') AND schema_version = '2.0.0' AND provenance_complete = 1",
		);
		expect(normalizedSchema).toContain(
			"HAVING uniqExact(normalized_row_checksum) = 1",
		);
		expect(normalizedSchema).toContain(
			"HAVING uniqExact(normalized_row_checksum) > 1",
		);
	});

	test("ordinary startup applies only the fresh/additive schema, never terminal retirement", () => {
		expect(ARCHIVE_SCHEMA_FILES).not.toContain(
			"migrations/retire_cex_order_book_historical_apply.sql" as never,
		);
		for (const statement of splitSqlStatements(schema)) {
			expect(statement).not.toMatch(/\bDROP\s+(?:TABLE|VIEW|COLUMN)\b/i);
			expect(statement).not.toMatch(/\bDELETE\s+WHERE\b/i);
			expect(statement).not.toMatch(/\bMODIFY\s+TTL\b/i);
		}
	});

	test("retirement is separate read-only inventory, destructive apply, and absence verify tooling", () => {
		const inventory = migration(
			"retire_cex_order_book_historical_inventory.sql",
		);
		const apply = migration("retire_cex_order_book_historical_apply.sql");
		const verify = migration("retire_cex_order_book_historical_verify.sql");

		expect(inventory).toMatch(/SELECT[\s\S]+system\.tables/);
		expect(inventory).toContain("system.columns");
		expect(inventory).toContain("system.mutations");
		expect(inventory).not.toMatch(/\b(?:ALTER|DROP|DELETE|TRUNCATE)\b/);

		expect(apply).toContain("DELETE WHERE source = 'external_backfill'");
		expect(apply).toContain("MODIFY TTL");
		expect(apply).toContain("INTERVAL 90 DAY");
		expect(apply).toContain("DROP VIEW IF EXISTS");
		expect(apply).toContain("DROP TABLE IF EXISTS");
		expect(apply).toContain("DROP COLUMN IF EXISTS capture_origin");

		expect(verify).toContain("source = 'external_backfill'");
		expect(verify).toContain("system.mutations");
		expect(verify).toContain("capture_origin");
		expect(verify).toContain("DELETE WHERE");
	});
});
