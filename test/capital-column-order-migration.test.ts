import { describe, expect, test } from "bun:test";
import {
	CAPITAL_TABLES,
	buildReorderAlter,
	classifyCapitalOrder,
	loadCapitalCanonical,
	parseCreateTable,
	planColumnMoves,
	splitTopLevelCommas,
} from "../services/archive-forwarder/scripts/capital-column-order-migration";

describe("capital column-order migration pure helpers", () => {
	test("splits top-level commas without touching nested lists and literals", () => {
		expect(
			splitTopLevelCommas(
				"`a` String, `b` Enum8('x' = 1, 'y' = 2), CONSTRAINT c CHECK a IN ('p,q', 'r')",
			),
		).toEqual([
			"`a` String",
			" `b` Enum8('x' = 1, 'y' = 2)",
			" CONSTRAINT c CHECK a IN ('p,q', 'r')",
		]);
		expect(splitTopLevelCommas("`d` String DEFAULT 'a,b(c)'")).toEqual([
			"`d` String DEFAULT 'a,b(c)'",
		]);
	});

	test("parses columns, sorted constraints and tail", () => {
		const parsed = parseCreateTable(
			"CREATE TABLE IF NOT EXISTS d.t (`b` UInt8, `a` String DEFAULT 'x', CONSTRAINT z CHECK b > 0, CONSTRAINT a CHECK length(a) > 0) ENGINE = MergeTree ORDER BY b",
		);
		expect(parsed.columns.map((column) => column.name)).toEqual(["b", "a"]);
		expect(parsed.constraints).toEqual([
			"CONSTRAINT a CHECK length(a) > 0",
			"CONSTRAINT z CHECK b > 0",
		]);
		expect(parsed.tail).toBe("ENGINE = MergeTree ORDER BY b");
	});

	test("canonical capital tables load from the owning fiet.sql", async () => {
		const canonical = await loadCapitalCanonical();
		expect(canonical.size).toBe(2);
		const journal = canonical.get("obligation_journal")!;
		const postings = canonical.get("custody_ledger_postings")!;
		expect(journal.parsed.columns.map((column) => column.name).length).toBe(43);
		expect(postings.parsed.columns.map((column) => column.name).length).toBe(25);
		expect(journal.parsed.columns.map((column) => column.name).slice(0, 11)).toEqual([
			"record_id", "payload_hash", "schema_revision", "obligation_id", "intent_id",
			"lifecycle_state", "queue_class", "reason_code", "conflict_detail",
			"state_version", "open_state_version",
		]);
		const definitions = new Map(
			journal.parsed.columns.map((column) => [column.name, column.definition]),
		);
		expect(definitions.get("queue_class")).toBe(
			"`queue_class` LowCardinality(String) DEFAULT 'INDETERMINATE' CODEC(ZSTD(1))",
		);
		expect(definitions.get("reason_code")).toBe(
			"`reason_code` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))",
		);
		expect(definitions.get("open_state_version")).toBe(
			"`open_state_version` Nullable(UInt64) CODEC(Delta(8), ZSTD(1))",
		);
	});

	test("known old orders differ from canonical in exactly the approved positions", async () => {
		const canonical = await loadCapitalCanonical();
		for (const { table, oldOrder } of CAPITAL_TABLES) {
			const canonicalOrder = canonical.get(table)!.parsed.columns.map((column) => column.name);
			expect(classifyCapitalOrder(canonicalOrder, canonicalOrder, oldOrder)).toBe("current");
			expect(classifyCapitalOrder(oldOrder, canonicalOrder, oldOrder)).toBe("migrate");
			expect(classifyCapitalOrder([...oldOrder].reverse(), canonicalOrder, oldOrder)).toBe("refuse");
		}
		expect(CAPITAL_TABLES[0]!.oldOrder.length).toBe(43);
		expect(CAPITAL_TABLES[1]!.oldOrder.length).toBe(25);
	});

	test("old journal order plans exactly five metadata moves in one ALTER", async () => {
		const canonical = await loadCapitalCanonical();
		const journal = canonical.get("obligation_journal")!;
		const canonicalOrder = journal.parsed.columns.map((column) => column.name);
		const definitions = new Map(
			journal.parsed.columns.map((column) => [column.name, column.definition]),
		);
		const actions = planColumnMoves(CAPITAL_TABLES[0]!.oldOrder, canonicalOrder, definitions);
		expect(actions.map(({ column, after }) => `${column}>${after}`)).toEqual([
			"queue_class>lifecycle_state",
			"reason_code>queue_class",
			"conflict_detail>reason_code",
			"state_version>conflict_detail",
			"open_state_version>state_version",
		]);
		expect(buildReorderAlter("obligation_journal", actions)).toBe(
			"ALTER TABLE fiet_telemetry.obligation_journal " +
				"MODIFY COLUMN `queue_class` LowCardinality(String) DEFAULT 'INDETERMINATE' CODEC(ZSTD(1)) AFTER `lifecycle_state`, " +
				"MODIFY COLUMN `reason_code` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)) AFTER `queue_class`, " +
				"MODIFY COLUMN `conflict_detail` Nullable(String) CODEC(ZSTD(1)) AFTER `reason_code`, " +
				"MODIFY COLUMN `state_version` UInt64 CODEC(Delta(8), ZSTD(1)) AFTER `conflict_detail`, " +
				"MODIFY COLUMN `open_state_version` Nullable(UInt64) CODEC(Delta(8), ZSTD(1)) AFTER `state_version`",
		);
	});

	test("old postings order plans a single move after obligation_id", async () => {
		const canonical = await loadCapitalCanonical();
		const postings = canonical.get("custody_ledger_postings")!;
		const canonicalOrder = postings.parsed.columns.map((column) => column.name);
		const definitions = new Map(
			postings.parsed.columns.map((column) => [column.name, column.definition]),
		);
		const actions = planColumnMoves(CAPITAL_TABLES[1]!.oldOrder, canonicalOrder, definitions);
		expect(actions).toEqual([
			{
				column: "open_state_version",
				definition: "`open_state_version` Nullable(UInt64) CODEC(Delta(8), ZSTD(1))",
				after: "obligation_id",
			},
		]);
		expect(buildReorderAlter("custody_ledger_postings", actions)).toBe(
			"ALTER TABLE fiet_telemetry.custody_ledger_postings " +
				"MODIFY COLUMN `open_state_version` Nullable(UInt64) CODEC(Delta(8), ZSTD(1)) AFTER `obligation_id`",
		);
	});

	test("canonical order plans no ALTER", async () => {
		const canonical = await loadCapitalCanonical();
		for (const { table } of CAPITAL_TABLES) {
			const parsed = canonical.get(table)!;
			const order = parsed.parsed.columns.map((column) => column.name);
			const definitions = new Map(
				parsed.parsed.columns.map((column) => [column.name, column.definition]),
			);
			expect(planColumnMoves(order, order, definitions)).toEqual([]);
			expect(buildReorderAlter(table, [])).toBeNull();
		}
	});
});
