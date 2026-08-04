import { describe, expect, test } from "bun:test";
import { SUPPORTED_TABLES } from "../services/archive-forwarder/types";
import {
	assertBaselineTableRows,
	auditBaselineHistory,
	BASELINE_COMMIT,
	BASELINE_RUNTIME_PARENT,
	BASELINE_TABLES,
	CANONICAL_BASE_TABLES,
	CANONICAL_VIEWS,
	loadArchiveBaselineFixture,
	validateArchiveBaselineFixture,
} from "./e2e/archive/support/archive-baseline";

describe("archive E2E immutable baseline", () => {
	test("baseline commit changes only canonical OpenSpec artifacts", async () => {
		const audit = await auditBaselineHistory();

		expect(audit.baselineCommit).toBe(BASELINE_COMMIT);
		expect(audit.runtimeParent).toBe(BASELINE_RUNTIME_PARENT);
		expect(audit.changedPaths.length).toBeGreaterThan(0);
		expect(
			audit.changedPaths.every((path) =>
				path.startsWith(
					"openspec/changes/canonical-cex-market-data-replay-archive/",
				),
			),
		).toBe(true);
	});

	test("fixture records every baseline table and immutable provenance", async () => {
		const fixture = await loadArchiveBaselineFixture();

		expect(fixture.fixtureSchemaVersion).toBe("archive-e2e-baseline/v1");
		expect(fixture.baselineCommit).toBe(BASELINE_COMMIT);
		expect(fixture.runtimeEquivalentParent).toBe(BASELINE_RUNTIME_PARENT);
		expect(fixture.tables.map(({ table }) => table)).toEqual(BASELINE_TABLES);
		expect(fixture.sourceHashes).not.toEqual({});
		for (const hash of Object.values(fixture.sourceHashes)) {
			expect(hash).toMatch(/^[a-f0-9]{64}$/);
		}
		for (const table of fixture.tables) {
			expect(table.projection.length).toBeGreaterThan(0);
			expect(table.fieldTypes).not.toEqual({});
			expect(table.comparisonKey.length).toBeGreaterThan(0);
			expect(table.sortOrder.length).toBeGreaterThan(0);
			expect(table.expectedRows.length).toBeGreaterThan(0);
		}
	});

	test("baseline and integrated canonical inventories remain closed", async () => {
		expect(BASELINE_TABLES).toHaveLength(15);
		expect(BASELINE_TABLES).toContain("broker_execution.fill_events");
		expect(BASELINE_TABLES).not.toContain("broker_execution.fills_events");
		expect(CANONICAL_BASE_TABLES).toEqual([
			"market_data.cex_ohlcv",
			"market_data.cex_order_book_levels",
			"market_data.cex_order_book_depth_summary",
		]);
		expect(CANONICAL_VIEWS).toEqual([
			"market_data.cex_ohlcv_closed",
			"market_data.cex_order_book_levels_canonical",
			"market_data.cex_order_book_levels_conflicts",
			"market_data.cex_order_book_depth_summary_canonical",
			"market_data.cex_order_book_depth_summary_conflicts",
		]);
		expect(
			SUPPORTED_TABLES.filter(
				(table) => !(BASELINE_TABLES as readonly string[]).includes(table),
			),
		).toEqual([...CANONICAL_BASE_TABLES, "broker_stream_health.snapshots"]);
		const marketSchema = await Bun.file(
			new URL("../schema/clickhouse/market_data.sql", import.meta.url),
		).text();
		for (const view of CANONICAL_VIEWS) {
			expect(marketSchema).toContain(`CREATE VIEW IF NOT EXISTS ${view}`);
		}
	});

	test("fixture validation rejects weakened table coverage", async () => {
		const fixture = await loadArchiveBaselineFixture();
		const missing = structuredClone(fixture);
		missing.tables.pop();
		expect(() => validateArchiveBaselineFixture(missing)).toThrow(
			"baseline table inventory",
		);

		const weakened = structuredClone(fixture);
		weakened.tables[0]?.projection.pop();
		expect(() => validateArchiveBaselineFixture(weakened)).toThrow(
			"projection",
		);

		const badHash = structuredClone(fixture);
		badHash.sourceHashes[Object.keys(badHash.sourceHashes)[0] ?? "missing"] =
			"not-a-hash";
		expect(() => validateArchiveBaselineFixture(badHash)).toThrow(
			"source hashes",
		);

		const badKey = structuredClone(fixture);
		badKey.tables[0]?.comparisonKey.push("not_projected");
		expect(() => validateArchiveBaselineFixture(badKey)).toThrow(
			"not projected",
		);

		const missingRows = structuredClone(fixture);
		if (missingRows.tables[0]) missingRows.tables[0].expectedRows = [];
		expect(() => validateArchiveBaselineFixture(missingRows)).toThrow(
			"expected rows",
		);
	});

	test("legacy projection comparison rejects missing, changed, and duplicate rows", async () => {
		const fixture = await loadArchiveBaselineFixture();
		const table = fixture.tables[0];
		expect(table).toBeDefined();
		if (!table) return;
		const expected = structuredClone(table.expectedRows);
		expect(() =>
			assertBaselineTableRows(table, [
				{ ...expected[0], additive_canonical_column: "allowed" },
			]),
		).not.toThrow();
		expect(() => assertBaselineTableRows(table, [])).toThrow(
			"missing, changed",
		);
		expect(() =>
			assertBaselineTableRows(table, [
				{ ...expected[0], [table.projection[0] ?? "source"]: "changed" },
			]),
		).toThrow("missing, changed");
		expect(() =>
			assertBaselineTableRows(table, [...expected, ...expected]),
		).toThrow("missing, changed");
	});
});
