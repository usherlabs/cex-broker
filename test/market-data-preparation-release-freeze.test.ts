import { describe, expect, test } from "bun:test";
import { assertFrozenMarketDataPreparationRelease } from "../scripts/market-data-preparation-release-freeze";

describe("market-data preparation release freeze", () => {
	test("accepts one clean identity chain", () => {
		expect(
			assertFrozenMarketDataPreparationRelease({
				packageVersion: "0.2.51",
				reservedVersion: "0.2.51",
				head: "a".repeat(40),
				mergeCommit: "a".repeat(40),
				tagCommit: "a".repeat(40),
				registryGitHead: "a".repeat(40),
				clean: true,
			}),
		).toEqual({ version: "0.2.51", gitHead: "a".repeat(40) });
	});

	test("rejects pre-merge, dirty, version-shifted, and registry-shifted evidence", () => {
		const valid = {
			packageVersion: "0.2.51",
			reservedVersion: "0.2.51",
			head: "a".repeat(40),
			mergeCommit: "a".repeat(40),
			tagCommit: "a".repeat(40),
			registryGitHead: "a".repeat(40),
			clean: true,
		};
		for (const changed of [
			{ clean: false },
			{ reservedVersion: "0.2.52" },
			{ mergeCommit: "b".repeat(40) },
			{ tagCommit: "b".repeat(40) },
			{ registryGitHead: "b".repeat(40) },
		]) {
			expect(() =>
				assertFrozenMarketDataPreparationRelease({ ...valid, ...changed }),
			).toThrow();
		}
	});
});
