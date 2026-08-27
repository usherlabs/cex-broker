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
import { fileURLToPath, pathToFileURL } from "node:url";
import canonicalize from "canonicalize";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedPackageJson = JSON.parse(
	readFileSync(path.join(root, "package.json"), "utf8"),
);
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

function filesBelow(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const absolute = path.join(directory, entry.name);
		return entry.isDirectory() ? filesBelow(absolute) : [absolute];
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
	if (
		JSON.stringify(Object.keys(packageJson.bin).sort()) !==
		JSON.stringify(
			[
				"cex-broker",
				"market-data-vendor-backfill",
				"cex-canonical-orderbook-export",
			].sort(),
		)
	) {
		throw new Error(
			"package must retain exactly the broker and two preparation bins",
		);
	}
	if (
		packageJson.name !== expectedPackageJson.name ||
		packageJson.version !== expectedPackageJson.version
	) {
		throw new Error(
			`expected package ${expectedPackageJson.name}@${expectedPackageJson.version}, got ${packageJson.name}@${packageJson.version}`,
		);
	}
	const preparationResults = new Map();
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
			result.producer?.package?.version !== packageJson.version ||
			result.producer?.executable_sha256 !== sha256(readFileSync(executable))
		) {
			throw new Error(`${name} extracted result identity is invalid`);
		}
		preparationResults.set(name, result);
	}
	if (
		preparationResults.get("market-data-vendor-backfill")?.producer
			?.product_version !== "market-data-vendor-backfill/v1" ||
		preparationResults.get("cex-canonical-orderbook-export")?.producer
			?.product_version !== "cex-canonical-orderbook-export/v2" ||
		preparationResults.get("market-data-vendor-backfill")?.producer?.package
			?.git_head !==
			preparationResults.get("cex-canonical-orderbook-export")?.producer
				?.package?.git_head
	) {
		throw new Error(
			"preparation producer versions or baked git heads disagree",
		);
	}

	if (
		readdirSync(extracted).includes("node_modules") ||
		packageJson.exports["./market-data-preparation"]?.import !==
			"./dist/market-data-preparation.js"
	) {
		throw new Error("packed preparation product is not standalone/exported");
	}
	const preparationRuntimePath = path.join(
		extracted,
		"dist/market-data-preparation.js",
	);
	const preparationDeclarationPath = path.join(
		extracted,
		"dist/market-data-preparation.d.ts",
	);
	const preparationLibrary = await import(
		pathToFileURL(preparationRuntimePath).href
	);
	if (
		typeof preparationLibrary.runMarketDataSourceTape !== "function" ||
		typeof preparationLibrary.runMarketDataRequiredClockQualification !==
			"function" ||
		preparationLibrary.MARKET_DATA_SOURCE_TAPE_OPERATION_ID !==
			"market-data-source-tape/v1" ||
		preparationLibrary.MARKET_DATA_REQUIRED_CLOCK_QUALIFICATION_OPERATION_ID !==
			"market-data-required-clock-qualification/v1" ||
		!existsSync(preparationDeclarationPath)
	) {
		throw new Error("preparation-library two-operation ABI is incomplete");
	}
	const operationFixtures = JSON.parse(
		readFileSync(
			path.join(
				extracted,
				"dist/market-data-preparation/fixtures/conformance-v3.json",
			),
			"utf8",
		),
	).documents?.library_operations;
	if (!operationFixtures) {
		throw new Error("preparation-library operation fixtures are missing");
	}
	const requiredClockRoot = path.join(
		temporaryRoot,
		"extracted-required-clock-operation",
	);
	const sourceTapeRoot = path.join(
		temporaryRoot,
		"extracted-source-tape-operation",
	);
	mkdirSync(requiredClockRoot, { mode: 0o700 });
	mkdirSync(sourceTapeRoot, { mode: 0o700 });
	const requiredClockCall =
		await preparationLibrary.runMarketDataRequiredClockQualification({
			invocation: operationFixtures.required_clock_qualification,
			attempt_root: requiredClockRoot,
			created_at: "2026-08-26T15:00:00.000Z",
			credential: { api_key: "" },
		});
	const sourceTapeCall = await preparationLibrary.runMarketDataSourceTape({
		invocation: operationFixtures.source_tape,
		attempt_root: sourceTapeRoot,
		created_at: "2026-08-26T15:00:00.000Z",
		credential: { api_key: "" },
		dependencies: {
			forwarder: {
				async submit(batch) {
					return { ok: true, inserted: batch.rows.length };
				},
			},
			archive_query: {
				async query() {
					return [];
				},
			},
			archive: {
				async resolveSelection() {
					throw new Error("unexpected archive selection");
				},
			},
			exporter: {
				async export() {
					throw new Error("unexpected export");
				},
			},
		},
	});
	if (
		requiredClockCall.qualification?.outcome?.reason !==
			"required_clock_credentials_missing" ||
		sourceTapeCall.qualification?.outcome?.reason !==
			"source_tape_credentials_missing" ||
		!existsSync(
			path.join(
				requiredClockRoot,
				operationFixtures.required_clock_qualification.artifacts
					.qualification_record_file_name,
			),
		) ||
		!existsSync(
			path.join(
				sourceTapeRoot,
				operationFixtures.source_tape.artifacts.qualification_record_file_name,
			),
		)
	) {
		throw new Error(
			"clean extracted preparation-library operations did not commit terminal evidence",
		);
	}
	const declaration = readFileSync(preparationDeclarationPath, "utf8");
	const operationDeclarations = [
		"dist/helpers/market-data-preparation/source-tape-operation.d.ts",
		"dist/helpers/market-data-preparation/required-clock-qualification.d.ts",
	].map((relativePath) =>
		readFileSync(path.join(extracted, relativePath), "utf8"),
	);
	for (const [index, symbol] of [
		"runMarketDataSourceTape",
		"runMarketDataRequiredClockQualification",
	].entries()) {
		if (!operationDeclarations[index]?.includes(symbol)) {
			throw new Error(`preparation declaration omits ${symbol}`);
		}
	}
	for (const forbidden of [
		"candidate_role",
		"maker_event_ids",
		"blocked_outcome",
		"scheduler_contract_id",
		"reference-depth-clock-derivation",
	]) {
		if (
			readFileSync(preparationRuntimePath, "utf8").includes(forbidden) ||
			declaration.includes(forbidden) ||
			operationDeclarations.some((source) => source.includes(forbidden))
		) {
			throw new Error(
				`preparation library retains Maker-owned field ${forbidden}`,
			);
		}
	}
	const manifest = JSON.parse(
		readFileSync(
			path.join(extracted, "dist/market-data-preparation/schema-manifest.json"),
			"utf8",
		),
	);
	if (
		manifest.schema_id !==
			"https://schemas.usher.so/market-data-vendor-backfill-schema-manifest/v3" ||
		manifest.artifacts?.length !== 12
	) {
		throw new Error("package does not contain exactly twelve current schemas");
	}
	for (const artifact of manifest.artifacts) {
		const bytes = readFileSync(
			path.join(extracted, "dist/market-data-preparation", artifact.path),
		);
		const document = JSON.parse(bytes.toString("utf8"));
		if (
			document.$id !== artifact.schema_id ||
			sha256(Buffer.from(canonicalize(document))) !== artifact.schema_sha256
		) {
			throw new Error(`schema identity mismatch: ${artifact.path}`);
		}
	}
	if (
		existsSync(path.join(extracted, "dist/market-data-vendor-backfill")) ||
		Object.keys(packageJson.exports).some((name) =>
			name.startsWith("./market-data-vendor-backfill/"),
		)
	) {
		throw new Error("current package retains a legacy preparation asset path");
	}
	for (const file of filesBelow(
		path.join(extracted, "dist/market-data-preparation"),
	)) {
		if (readFileSync(file).includes(Buffer.from("fiet_tee_commit"))) {
			throw new Error(
				`current preparation asset retains Fiet TEE provenance: ${file}`,
			);
		}
	}
	for (const relativePath of [
		"dist/market-data-vendor-backfill.js",
		"dist/market-data-preparation.js",
		"dist/commands/market-data-vendor-backfill.js",
		"dist/commands/cex-canonical-orderbook-export.js",
	]) {
		const source = readFileSync(path.join(extracted, relativePath), "utf8");
		for (const forbidden of [
			"fiet_tee_commit",
			"market-data-vendor-backfill-result/v1",
			"market-data-vendor-backfill-capabilities/v1",
			"market-data-vendor-backfill-capabilities/v2",
			"market-data-vendor-backfill-resources/v1",
		]) {
			if (source.includes(forbidden)) {
				throw new Error(
					`${relativePath} retains legacy runtime identity ${forbidden}`,
				);
			}
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
			`https://registry.npmjs.org/@usherlabs/cex-broker/-/cex-broker-${packageJson.version}.tgz`,
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
