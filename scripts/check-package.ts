import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packageConsumerEnvironment } from "./lib/package/consumer-environment.mjs";
import {
	advertisedPackagePaths,
	npmPackFilename,
	verifyPackageContents,
} from "./lib/package/content";
import { contractSourceHashes, sha256 } from "./lib/package/contract";
import { verifyReleaseRevision } from "./lib/package/provenance";

const { values } = parseArgs({
	options: {
		tarball: { type: "string" },
		"expected-git-head": { type: "string" },
		output: { type: "string" },
	},
});
const root = process.cwd();
function run(command: [string, ...string[]], cwd = root): string {
	const result = spawnSync(command[0], command.slice(1), {
		cwd,
		env: packageConsumerEnvironment(process.env),
		encoding: "utf8",
		timeout: 180_000,
		maxBuffer: 10 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`${command[0]} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
		);
	return result.stdout.trim();
}
const gitHead = run(["git", "rev-parse", "HEAD"]);
const expectedGitHead = values["expected-git-head"] ?? gitHead;
verifyReleaseRevision({
	expectedGitHead,
	repositoryGitHead: gitHead,
	repositoryStatus: run(["git", "status", "--porcelain"]),
});
const output = values.output
	? resolve(values.output)
	: mkdtempSync(join(tmpdir(), "cex-broker-package-"));
assert(
	!output.startsWith(`${root}/`) && output !== root,
	"Package verification output must be outside the repository",
);
mkdirSync(output, { recursive: true });
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const sourceSha256 = contractSourceHashes(root);
let tarball: string;
if (values.tarball) tarball = resolve(values.tarball);
else {
	const filename = npmPackFilename(
		run([
			"npm",
			"pack",
			"--ignore-scripts",
			"--json",
			"--pack-destination",
			output,
		]),
		manifest.name,
	);
	tarball = join(output, filename);
}
const consumer = mkdtempSync(join(output, "consumer-"));
writeFileSync(
	join(consumer, "package.json"),
	JSON.stringify({
		name: "cex-broker-package-consumer",
		private: true,
		type: "module",
	}),
);
run(
	[
		"npm",
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--package-lock=false",
		tarball,
		"typescript@5.9.3",
		"@types/node@24",
	],
	consumer,
);
const installed = join(consumer, "node_modules/@usherlabs/cex-broker");
verifyPackageContents(installed, {
	gitHead: expectedGitHead,
	version: manifest.version,
	sourceSha256,
});
for (const file of ["consumer.mts", "runtime.mjs"]) {
	copyFileSync(
		join(root, "test/fixtures/package-consumer", file),
		join(consumer, file),
	);
}
const documentationExamples = Array.from(
	readFileSync(join(root, "docs/typed-package.md"), "utf8").matchAll(
		/```ts\n([\s\S]*?)\n```/g,
	),
	(match) => match[1],
);
assert(
	documentationExamples.length > 0,
	"Typed package documentation example is required",
);
writeFileSync(
	join(consumer, "documentation.mts"),
	documentationExamples.join("\n"),
);
const compiler = join(consumer, "node_modules/typescript/bin/tsc");
const publicDeclarations = advertisedPackagePaths(manifest)
	.filter((path) => path.endsWith(".d.ts"))
	.map((path) => join(installed, path));
const config = {
	compilerOptions: {
		target: "ES2022",
		module: "NodeNext",
		moduleResolution: "NodeNext",
		strict: true,
		skipLibCheck: false,
		outDir: "compiled",
		types: ["node"],
	},
	include: ["consumer.mts", "documentation.mts", ...publicDeclarations],
};
// Every public type export is checked, including future exports not imported by the fixture.
writeFileSync(join(consumer, "tsconfig.public.json"), JSON.stringify(config));
run(["node", compiler, "-p", "tsconfig.public.json"], consumer);
run(
	[
		"node",
		compiler,
		"-p",
		"tsconfig.public.json",
		"--module",
		"ESNext",
		"--moduleResolution",
		"bundler",
		"--noEmit",
	],
	consumer,
);
writeFileSync(
	join(consumer, "tsconfig.internal-bundler.json"),
	JSON.stringify({
		...config,
		compilerOptions: {
			...config.compilerOptions,
			module: "ESNext",
			moduleResolution: "bundler",
			noEmit: true,
		},
		include: [
			"consumer.mts",
			"documentation.mts",
			"node_modules/@usherlabs/cex-broker/dist/**/*.d.ts",
		],
	}),
);
run(["node", compiler, "-p", "tsconfig.internal-bundler.json"], consumer);
const wire = join(consumer, "evidence.json");
console.log(run(["node", "runtime.mjs", wire], consumer));
console.log(run(["node", "compiled/consumer.mjs", wire], consumer));
const bytes = readFileSync(tarball);
const files = readdirSync(installed, { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) =>
		join(entry.parentPath, entry.name).slice(installed.length + 1),
	)
	.sort();
const evidence = {
	status: "candidate_verified_not_published",
	version: manifest.version,
	gitHead: expectedGitHead,
	tarball,
	integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	tarballSha256: createHash("sha256").update(bytes).digest("hex"),
	files,
	inventorySha256: sha256(JSON.stringify(files)),
	sourceProof: {
		gitHead: expectedGitHead,
		sourceSha256,
	},
	metadata: JSON.parse(
		readFileSync(join(installed, "dist/build-metadata.json"), "utf8"),
	),
	checks: [
		"package-paths",
		"approved-revision-and-source-hashes",
		"strict-public-nodenext",
		"strict-public-bundler",
		"strict-internal-bundler",
		"packed-rpc",
		"typed-evidence-decoding",
		"typed-documentation-example",
	],
	consumer,
	installedPackage: installed,
};
writeFileSync(
	join(output, "package-evidence.json"),
	`${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
	`Package verification passed: ${join(output, "package-evidence.json")}`,
);
