import { afterEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	advertisedPackagePaths,
	npmPackFilename,
	verifyPackageContents,
} from "../scripts/package-content";
import {
	CONTRACT_PROTO_SHA256,
	contractSourceHashes,
	EVIDENCE_SCHEMA_IDS,
	REQUIRED_PACKAGE_PATHS,
} from "../scripts/package-contract";

const temporary: string[] = [];
const gitHead = "0123456789abcdef0123456789abcdef01234567";
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const expected = {
	gitHead,
	version: manifest.version,
	sourceSha256: contractSourceHashes(process.cwd()),
};
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "cex-package-content-test-"));
	temporary.push(root);
	for (const path of [
		...REQUIRED_PACKAGE_PATHS,
		...advertisedPackagePaths(manifest),
	]) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), "fixture file\n");
	}
	writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
	writeFileSync(
		join(root, "dist/index.js"),
		JSON.stringify(EVIDENCE_SCHEMA_IDS),
	);
	copyFileSync("src/proto/node.proto", join(root, "dist/proto/node.proto"));
	copyFileSync(
		"src/proto/node.descriptor.ts",
		join(root, "dist/proto/node.descriptor.ts"),
	);
	writeFileSync(
		join(root, "dist/build-metadata.json"),
		JSON.stringify({
			version: expected.version,
			gitHead,
			protoSha256: CONTRACT_PROTO_SHA256,
			evidenceSchemas: EVIDENCE_SCHEMA_IDS,
			sourceSha256: expected.sourceSha256,
		}),
	);
	return root;
}
afterEach(() => {
	for (const path of temporary.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("package content gate", () => {
	test("reads npm 12 package-keyed pack output", () => {
		const filename = "usherlabs-cex-broker-0.3.2.tgz";
		expect(
			npmPackFilename(
				JSON.stringify({ [manifest.name]: { filename } }),
				manifest.name,
			),
		).toBe(filename);
		for (const invalid of [
			[],
			{},
			{ other: { filename } },
			{ [manifest.name]: {} },
			{ [manifest.name]: { filename: "../outside.tgz" } },
			{ [manifest.name]: { filename: "/outside.tgz" } },
		]) {
			expect(() =>
				npmPackFilename(JSON.stringify(invalid), manifest.name),
			).toThrow();
		}
	});

	test("accepts a complete package inventory", () => {
		expect(() => verifyPackageContents(fixture(), expected)).not.toThrow();
	});
	test.each(REQUIRED_PACKAGE_PATHS)("rejects missing %s", (path) => {
		const root = fixture();
		rmSync(join(root, path));
		expect(() => verifyPackageContents(root, expected)).toThrow();
	});
	test("checks new advertised export targets rather than only a fixed inventory", () => {
		const root = fixture();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				...manifest,
				exports: {
					...manifest.exports,
					"./missing": {
						types: "./dist/missing.d.ts",
						import: "./dist/missing.js",
					},
				},
			}),
		);
		expect(() => verifyPackageContents(root, expected)).toThrow();
	});
	test.each([
		"dist/proto/node.proto",
		"dist/proto/node.descriptor.ts",
	])("rejects corrupt %s", (path) => {
		const root = fixture();
		writeFileSync(join(root, path), "corrupt");
		expect(() => verifyPackageContents(root, expected)).toThrow();
	});
	test.each([
		"",
		"invalid",
		"a".repeat(40),
	])("rejects absent, invalid or mismatched release commit: %s", (revision) => {
		const root = fixture();
		const path = join(root, "dist/build-metadata.json");
		const metadata = JSON.parse(readFileSync(path, "utf8"));
		metadata.gitHead = revision;
		writeFileSync(path, JSON.stringify(metadata));
		expect(() => verifyPackageContents(root, expected)).toThrow(
			"commit mismatch",
		);
	});
	test("does not accept an unspecified expected revision", () => {
		expect(() =>
			verifyPackageContents(fixture(), { ...expected, gitHead: "" }),
		).toThrow("Expected release commit");
	});
	test("rejects forged source-equivalence claims", () => {
		const root = fixture();
		const path = join(root, "dist/build-metadata.json");
		const metadata = JSON.parse(readFileSync(path, "utf8"));
		metadata.sourceSha256["src/handlers/execute-action/batch.ts"] = "0".repeat(
			64,
		);
		writeFileSync(path, JSON.stringify(metadata));
		expect(() => verifyPackageContents(root, expected)).toThrow(
			"Contract source provenance mismatch",
		);
	});
	test.each(
		EVIDENCE_SCHEMA_IDS,
	)("rejects absent runtime schema %s", (schema) => {
		const root = fixture();
		writeFileSync(
			join(root, "dist/index.js"),
			JSON.stringify(EVIDENCE_SCHEMA_IDS.filter((id) => id !== schema)),
		);
		expect(() => verifyPackageContents(root, expected)).toThrow(
			"missing evidence schema",
		);
	});
});
