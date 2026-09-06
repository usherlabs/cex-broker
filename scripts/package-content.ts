import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	EVIDENCE_SCHEMA_IDS,
	REQUIRED_PACKAGE_PATHS,
	sha256,
	TASK_5_PROTO_SHA256,
} from "./package-contract";

export function advertisedPackagePaths(
	manifest: Record<string, unknown>,
): string[] {
	const paths: string[] = [];
	function collect(value: unknown): void {
		if (typeof value === "string") paths.push(value);
		else if (value && typeof value === "object") {
			for (const child of Object.values(value)) collect(child);
		}
	}
	for (const field of ["main", "module", "types", "bin", "exports"]) {
		collect(manifest[field]);
	}
	return [...new Set(paths)];
}

export function verifyPackageContents(
	root: string,
	expected: {
		gitHead: string;
		version: string;
		sourceSha256: Record<string, string>;
	},
): void {
	assert.match(
		expected.gitHead,
		/^[a-f0-9]{40}$/,
		"Expected release commit is required",
	);
	const packageRoot = realpathSync(root);
	const read = (path: string) => readFileSync(resolve(packageRoot, path));
	const manifest = JSON.parse(read("package.json").toString());
	assert.equal(manifest.name, "@usherlabs/cex-broker");
	assert.equal(manifest.version, expected.version);
	for (const path of [
		...REQUIRED_PACKAGE_PATHS,
		...advertisedPackagePaths(manifest),
	]) {
		const location = realpathSync(resolve(packageRoot, path));
		const local = relative(packageRoot, location);
		assert(
			!isAbsolute(local) && !local.startsWith(".."),
			`Package path escapes root: ${path}`,
		);
		assert(statSync(location).isFile(), `Missing package file: ${path}`);
		assert(read(path).length > 0, `Empty package file: ${path}`);
	}
	const metadata = JSON.parse(read("dist/build-metadata.json").toString());
	assert.equal(metadata.version, expected.version);
	assert.equal(
		metadata.gitHead,
		expected.gitHead,
		"Package release commit mismatch",
	);
	assert.equal(metadata.protoSha256, TASK_5_PROTO_SHA256);
	assert.equal(sha256(read("dist/proto/node.proto")), TASK_5_PROTO_SHA256);
	assert.equal(
		sha256(read("dist/proto/node.descriptor.ts")),
		expected.sourceSha256["src/proto/node.descriptor.ts"],
		"Canonical descriptor bytes changed",
	);
	assert.deepEqual(
		metadata.sourceSha256,
		expected.sourceSha256,
		"Contract source provenance mismatch",
	);
	assert.deepEqual(metadata.evidenceSchemas, EVIDENCE_SCHEMA_IDS);
	const runtime = read("dist/index.js").toString();
	for (const schema of EVIDENCE_SCHEMA_IDS) {
		assert(
			runtime.includes(schema),
			`Runtime is missing evidence schema ${schema}`,
		);
	}
}
