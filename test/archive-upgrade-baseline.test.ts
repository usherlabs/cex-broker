import { describe, expect, test } from "bun:test";
import {
	DEVELOP_BASELINE_COMMIT,
	DEVELOP_BASELINE_VERSION,
	loadUpgradeBaseline,
	validateUpgradeBaseline,
} from "../scripts/archive-upgrade-baseline";

describe("develop archive-upgrade baseline", () => {
	test("pins develop 0.2.38 with complete hashed DDL and deterministic rows", async () => {
		const fixture = await loadUpgradeBaseline();
		expect(fixture.baseline.branch).toBe("develop");
		expect(fixture.baseline.commit).toBe(DEVELOP_BASELINE_COMMIT);
		expect(fixture.baseline.packageVersion).toBe(DEVELOP_BASELINE_VERSION);
		expect(fixture.tables).toHaveLength(15);
		expect(fixture.schemaFiles).toHaveLength(4);
		expect(fixture.migrationWindow).toEqual({
			startTimeMs: 2_000_000_000_000,
			endTimeMs: 2_000_000_040_001,
		});
		expect(fixture.expected).toMatchObject({
			legacyOrderBooks: 1,
			legacyCandles: 1,
			canonicalRows: 6,
		});
		await expect(validateUpgradeBaseline(fixture)).resolves.toBeUndefined();
	});

	test("rejects an implicit expectation or artifact hash update", async () => {
		const fixture = structuredClone(await loadUpgradeBaseline());
		const firstRow = fixture.tables[0]?.expectedRows[0];
		if (!firstRow)
			throw new Error("baseline test fixture is unexpectedly empty");
		firstRow.source = "changed";
		await expect(validateUpgradeBaseline(fixture)).rejects.toThrow(
			"fixture content hash",
		);
	});
});
