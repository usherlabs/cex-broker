import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(
	path.join(os.tmpdir(), "cex-preparation-package-audit-"),
);
const builtins = new Set(
	builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`]),
);

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function runNode(executable, args) {
	return spawnSync(process.execPath, [executable, ...args], {
		encoding: "utf8",
		env: { PATH: process.env.PATH },
	});
}

try {
	const packOutput = execFileSync(
		"npm",
		["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
		{ cwd: root, encoding: "utf8", env: { ...process.env, HUSKY: "0" } },
	);
	const packJsonStart = packOutput.search(/\[\s*\{\s*"id"/u);
	if (packJsonStart < 0)
		throw new Error("npm pack did not return JSON metadata");
	const pack = JSON.parse(packOutput.slice(packJsonStart));
	const tarballPath = path.join(temporaryRoot, pack[0].filename);
	execFileSync("tar", ["-xzf", tarballPath, "-C", temporaryRoot]);
	const extracted = path.join(temporaryRoot, "package");
	const packageJson = JSON.parse(
		readFileSync(path.join(extracted, "package.json"), "utf8"),
	);
	if (packageJson.version !== "0.2.47") {
		throw new Error(`expected package 0.2.47, got ${packageJson.version}`);
	}
	for (const [name, relativePath] of Object.entries({
		"market-data-vendor-backfill":
			"dist/commands/market-data-vendor-backfill.js",
		"cex-canonical-orderbook-export":
			"dist/commands/cex-canonical-orderbook-export.js",
	})) {
		if (packageJson.bin[name] !== relativePath) {
			throw new Error(`${name} bin path is not closed`);
		}
		const executable = path.join(extracted, relativePath);
		if ((statSync(executable).mode & 0o777) !== 0o755) {
			throw new Error(`${name} is not mode 0755`);
		}
		const source = readFileSync(executable, "utf8");
		if (!source.startsWith("#!/usr/bin/env node\n")) {
			throw new Error(`${name} has no Node shebang`);
		}
		const bareImports = [
			...source.matchAll(/(?:from\s+|import\s*\()["']([^./][^"']*)["']/g),
		]
			.map((match) => match[1])
			.filter((specifier) => !builtins.has(specifier));
		if (bareImports.length > 0) {
			throw new Error(
				`${name} retains runtime package imports: ${bareImports.join(", ")}`,
			);
		}

		const attemptRoot = path.join(temporaryRoot, `${name}-attempt`);
		mkdirSync(attemptRoot, { mode: 0o700 });
		const requestPath = path.join(attemptRoot, "request.json");
		const resultPath = path.join(attemptRoot, "result.json");
		writeFileSync(requestPath, "{invalid-json\n", { mode: 0o600 });
		const execution = runNode(executable, [
			"run",
			"--request",
			requestPath,
			"--result",
			resultPath,
		]);
		if (execution.status !== 0) {
			throw new Error(
				`${name} extracted execution failed: ${execution.stderr.trim()}`,
			);
		}
		const result = JSON.parse(readFileSync(resultPath, "utf8"));
		if (
			result.outcome?.status !== "request_invalid" ||
			result.producer?.package?.version !== "0.2.47" ||
			result.producer?.executable_sha256 !== sha256(readFileSync(executable))
		) {
			throw new Error(`${name} extracted result identity is invalid`);
		}
	}

	if (
		readdirSync(extracted).includes("node_modules") ||
		packageJson.exports["./market-data-preparation"]?.import !==
			"./dist/market-data-preparation.js"
	) {
		throw new Error("packed preparation product is not standalone/exported");
	}
	const frozenV1Pins = new Map([
		[
			"dist/market-data-vendor-backfill/schema-manifest.json",
			"7ea3cca721e03df41d9c651cad69eebc3d83dd801bc214854c8c93edca2d41ae",
		],
		[
			"dist/market-data-vendor-backfill/schemas/result.schema.json",
			"16230047a5fce2dd88a6f9e9ac9c8ac82e3111fefac6ea7243e8e1c43f2676b1",
		],
		[
			"dist/market-data-vendor-backfill/fixtures/conformance-v1.json",
			"54b08b52464e1be6fffa4ebb9edf50ddf65a07ee2ae43dd7ec05eb16fe27ea80",
		],
	]);
	for (const [relativePath, expected] of frozenV1Pins) {
		if (sha256(readFileSync(path.join(extracted, relativePath))) !== expected) {
			throw new Error(`v1 package asset drifted: ${relativePath}`);
		}
	}
	const evidencePath = path.join(temporaryRoot, "candidate-evidence.json");
	execFileSync(
		process.execPath,
		[
			path.join(
				root,
				"scripts/generate-market-data-preparation-release-evidence.mjs",
			),
			"--tarball",
			tarballPath,
			"--out",
			evidencePath,
		],
		{ stdio: "pipe" },
	);
	const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
	if (
		evidence.status !== "candidate_unpublished" ||
		evidence.registry !== null ||
		evidence.package.candidate_tarball_sha256 !==
			sha256(readFileSync(tarballPath))
	) {
		throw new Error("candidate release evidence fabricated registry identity");
	}
	const invalidRegistryEvidencePath = path.join(
		temporaryRoot,
		"invalid-registry-evidence.json",
	);
	const invalidRegistryPinPath = path.join(
		temporaryRoot,
		"invalid-registry-pin.json",
	);
	const invalidRegistryAttempt = spawnSync(
		process.execPath,
		[
			path.join(
				root,
				"scripts/generate-market-data-preparation-release-evidence.mjs",
			),
			"--tarball",
			tarballPath,
			"--out",
			invalidRegistryEvidencePath,
			"--registry-url",
			"https://registry.npmjs.org/@usherlabs/cex-broker/-/cex-broker-0.2.47.tgz",
			"--registry-integrity",
			"sha512-YQ==",
			"--npm-git-head",
			"a".repeat(40),
			"--pin-out",
			invalidRegistryPinPath,
		],
		{ encoding: "utf8" },
	);
	if (
		invalidRegistryAttempt.status === 0 ||
		existsSync(invalidRegistryEvidencePath) ||
		existsSync(invalidRegistryPinPath)
	) {
		throw new Error(
			"mismatched registry integrity did not fail closed before output",
		);
	}
	console.log(
		JSON.stringify({
			status: "passed",
			package: `${packageJson.name}@${packageJson.version}`,
			tarball_sha256: sha256(readFileSync(tarballPath)),
		}),
	);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
