import { describe, expect, test } from "bun:test";
import {
	parseMigrationSummary,
	validateMigrationSummary,
} from "../scripts/archive-upgrade-acceptance";

describe("archive upgrade A/B acceptance contract", () => {
	test("requires confirmed migration with the exact non-zero fixture window", () => {
		const summary = parseMigrationSummary(
			'noise\n{"window":{"start_time_ms":10,"end_time_ms":20},"legacy_order_books":1,"legacy_candles":1,"canonical_rows":6,"mode":"write"}\n',
		);
		expect(() =>
			validateMigrationSummary(summary, {
				window: { startTimeMs: 10, endTimeMs: 20 },
				legacyOrderBooks: 1,
				legacyCandles: 1,
				canonicalRows: 6,
			}),
		).not.toThrow();
	});

	test.each([
		{ mode: "dry_run" },
		{ legacy_order_books: 0 },
		{ legacy_candles: 0 },
		{ canonical_rows: 0 },
		{ window: { start_time_ms: 10, end_time_ms: 21 } },
	])("rejects incomplete migration evidence %#", (override) => {
		const summary = {
			window: { start_time_ms: 10, end_time_ms: 20 },
			legacy_order_books: 1,
			legacy_candles: 1,
			canonical_rows: 6,
			mode: "write",
			...override,
		};
		expect(() =>
			validateMigrationSummary(summary, {
				window: { startTimeMs: 10, endTimeMs: 20 },
				legacyOrderBooks: 1,
				legacyCandles: 1,
				canonicalRows: 6,
			}),
		).toThrow();
	});
});
