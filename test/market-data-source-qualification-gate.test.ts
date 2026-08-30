import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runTwoPairSourceQualificationGate,
	type TwoPairSourceQualificationRun,
} from "../scripts/market-data-source-qualification-gate";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

function passed(pair: "ARB-USDC" | "ARB-USDT"): TwoPairSourceQualificationRun {
	return {
		pair,
		status: "passed",
		manifest_file_name: `${pair.toLowerCase()}-tape-manifest.json`,
		manifest_sha256: pair === "ARB-USDC" ? "a".repeat(64) : "b".repeat(64),
		artifact_sha256s: ["c".repeat(64), "d".repeat(64)],
		partial_evidence_sha256s: [],
	};
}

describe("two-pair source qualification gate", () => {
	test("commits one success manifest only after both pairs pass", async () => {
		const root = await mkdtemp(join(tmpdir(), "cex-two-pair-gate-"));
		roots.push(root);
		await writeFile(join(root, "qualification-verdict.json"), "stale\n");
		const result = await runTwoPairSourceQualificationGate({
			outputDirectory: root,
			createdAt: "2026-08-26T12:00:00.000Z",
			runPair: async (pair) => passed(pair),
		});
		expect(result.status).toBe("passed");
		expect(
			JSON.parse(
				await readFile(join(root, "qualification-success.json"), "utf8"),
			),
		).toMatchObject({
			status: "passed",
			pairs: [{ pair: "ARB-USDC" }, { pair: "ARB-USDT" }],
		});
		await expect(
			readFile(join(root, "qualification-verdict.json"), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("commits a durable failure verdict with retained hashes and no success manifest", async () => {
		const root = await mkdtemp(join(tmpdir(), "cex-two-pair-gate-"));
		roots.push(root);
		const result = await runTwoPairSourceQualificationGate({
			outputDirectory: root,
			createdAt: "2026-08-26T12:00:00.000Z",
			runPair: async (pair) =>
				pair === "ARB-USDC"
					? passed(pair)
					: {
							pair,
							status: "failed",
							reason: "provider_object_inventory_incomplete",
							artifact_sha256s: [],
							partial_evidence_sha256s: ["e".repeat(64), "f".repeat(64)],
						},
		});
		expect(result).toMatchObject({
			status: "failed",
			failed_pair: "ARB-USDT",
			reason: "provider_object_inventory_incomplete",
			retained_partial_evidence_sha256s: [
				"a".repeat(64),
				"c".repeat(64),
				"d".repeat(64),
				"e".repeat(64),
				"f".repeat(64),
			],
		});
		expect(
			JSON.parse(
				await readFile(join(root, "qualification-verdict.json"), "utf8"),
			),
		).toEqual(result);
		await expect(
			readFile(join(root, "qualification-success.json"), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
