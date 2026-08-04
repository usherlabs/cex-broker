#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createClient } from "@clickhouse/client";
import {
	CHECKSUM_ALGORITHM,
	MARKET_CAPTURE_SCHEMA_VERSION,
} from "../src/helpers/market-data-archive/capture-contract";
import {
	exportCanonicalOrderBookParquet,
	validateCanonicalMarketReplayWindow,
} from "./export-canonical-orderbook-parquet";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const BASELINE_SHA = "7a83de5f29a08f42d81f64a75a83bc9318dce94a";
const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:24.8";
const MANIFEST_SCHEMA = "cex-archive-sidecar/v1";
const READY_TIMEOUT_MS = 120_000;
const STRATEGY_TABLES = [
	"strategy_data.policy_evaluation_events",
	"strategy_data.strategy_policy_snapshots",
	"strategy_data.market_identity",
	"strategy_data.symbol_mapping",
	"strategy_data.inventory_settlement_events",
] as const;

export class SidecarUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SidecarUsageError";
	}
}

type Profile = "native_replay" | "production_compatible";
type UpInvocation = {
	operation: "up";
	runId: string;
	profile: Profile;
	candidateSha: string;
	makerSha: string;
	artifactsDir: string;
};
type ManifestInvocation = {
	operation: "ready" | "verify" | "down";
	manifestPath: string;
	timeoutMs?: number;
};
export type SidecarInvocation = UpInvocation | ManifestInvocation;

export type SidecarManifest = {
	schemaVersion: typeof MANIFEST_SCHEMA;
	runId: string;
	profile: Profile;
	candidateSha: string;
	makerSha: string;
	baselineSha: string;
	artifactsDir: string;
	manifestPath: string;
	statePath: string;
	logPath: string;
	verificationPath: string;
	spoolPath: string;
	containerName: string;
	clickhouseUrl: string;
	forwarderUrl: string;
	forwarderHealthUrl: string;
	deploymentId: string;
	captureBundleId: string;
	createdAt: string;
	clickhouseImage: string;
	supervisorPid: number;
	commands: {
		up: string;
		ready: string;
		verify: string;
		down: string;
	};
};

type SidecarState = {
	ready: boolean;
	stopped?: boolean;
	brokerPort?: number;
	feedsReady?: string[];
	marketCapture?: {
		emittedRows: number;
		feedsObserved: string[];
		sourceWindow: { startTimeMs: number; endTimeMs: number };
	};
	strategy?: {
		source: "maker_replay" | "hb_runtime";
		httpStatus: number;
		spoolDrained: boolean;
	};
	forwarderHealth?: Record<string, unknown>;
	error?: string;
};

const MANIFEST_KEYS = new Set([
	"schemaVersion",
	"runId",
	"profile",
	"candidateSha",
	"makerSha",
	"baselineSha",
	"artifactsDir",
	"manifestPath",
	"statePath",
	"logPath",
	"verificationPath",
	"spoolPath",
	"containerName",
	"clickhouseUrl",
	"forwarderUrl",
	"forwarderHealthUrl",
	"deploymentId",
	"captureBundleId",
	"createdAt",
	"clickhouseImage",
	"supervisorPid",
	"commands",
]);

function flags(args: string[]): Map<string, string> {
	const parsed = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (!name?.startsWith("--") || !value || value.startsWith("--")) {
			throw new SidecarUsageError(`Invalid flag near ${name ?? "end"}`);
		}
		if (parsed.has(name)) throw new SidecarUsageError(`Duplicate flag ${name}`);
		parsed.set(name, value);
	}
	return parsed;
}

function requireOnly(
	parsed: Map<string, string>,
	required: string[],
	optional: string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	for (const name of parsed.keys()) {
		if (!allowed.has(name)) throw new SidecarUsageError(`Unknown flag ${name}`);
	}
	for (const name of required) {
		if (!parsed.get(name)?.trim()) {
			throw new SidecarUsageError(`Missing required flag ${name}`);
		}
	}
}

function validSha(value: string): boolean {
	return /^[0-9a-f]{40}$/i.test(value);
}

export function parseSidecarInvocation(args: string[]): SidecarInvocation {
	const [operation, ...rest] = args;
	if (!operation || !["up", "ready", "verify", "down"].includes(operation)) {
		throw new SidecarUsageError("Operation must be up, ready, verify, or down");
	}
	const parsed = flags(rest);
	if (operation === "up") {
		const required = [
			"--run-id",
			"--profile",
			"--candidate-sha",
			"--maker-sha",
			"--artifacts-dir",
		];
		requireOnly(parsed, required);
		const runId = parsed.get("--run-id") as string;
		const profile = parsed.get("--profile") as Profile;
		const candidateSha = parsed.get("--candidate-sha") as string;
		const makerSha = parsed.get("--maker-sha") as string;
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
			throw new SidecarUsageError(
				"run-id must be a bounded path-safe identifier",
			);
		}
		if (profile !== "native_replay" && profile !== "production_compatible") {
			throw new SidecarUsageError("Unsupported sidecar profile");
		}
		if (!validSha(candidateSha) || !validSha(makerSha)) {
			throw new SidecarUsageError(
				"candidate-sha and maker-sha must be full commits",
			);
		}
		return {
			operation,
			runId,
			profile,
			candidateSha: candidateSha.toLowerCase(),
			makerSha: makerSha.toLowerCase(),
			artifactsDir: resolve(parsed.get("--artifacts-dir") as string),
		};
	}
	const optional = operation === "ready" ? ["--timeout-ms"] : [];
	requireOnly(parsed, ["--manifest"], optional);
	let timeoutMs: number | undefined;
	if (operation === "ready") {
		timeoutMs = Number(parsed.get("--timeout-ms") ?? READY_TIMEOUT_MS);
		if (
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs <= 0 ||
			timeoutMs > 300_000
		) {
			throw new SidecarUsageError("timeout-ms must be between 1 and 300000");
		}
	}
	return {
		operation,
		manifestPath: resolve(parsed.get("--manifest") as string),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	};
}

function assertNoSecrets(value: unknown, path = "manifest"): void {
	if (!value || typeof value !== "object") return;
	for (const [key, nested] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (
			/(token|secret|credential|api.?key|environment|(^|_)env($|_))/i.test(key)
		) {
			throw new SidecarUsageError(
				`Secret-bearing manifest field ${path}.${key}`,
			);
		}
		assertNoSecrets(nested, `${path}.${key}`);
	}
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new SidecarUsageError(`Invalid manifest field ${key}`);
	}
	return value;
}

export function validateSidecarManifest(value: unknown): SidecarManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SidecarUsageError("Manifest must be an object");
	}
	assertNoSecrets(value);
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!MANIFEST_KEYS.has(key))
			throw new SidecarUsageError(`Unknown manifest field ${key}`);
	}
	for (const key of MANIFEST_KEYS) {
		if (!(key in record))
			throw new SidecarUsageError(`Missing manifest field ${key}`);
	}
	if (record.schemaVersion !== MANIFEST_SCHEMA)
		throw new SidecarUsageError("Unsupported manifest schema");
	const runId = requiredString(record, "runId");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
		throw new SidecarUsageError("Invalid manifest runId");
	}
	const profile = requiredString(record, "profile");
	if (profile !== "native_replay" && profile !== "production_compatible") {
		throw new SidecarUsageError("Unsupported manifest profile");
	}
	for (const key of ["candidateSha", "makerSha", "baselineSha"]) {
		if (!validSha(requiredString(record, key)))
			throw new SidecarUsageError(`Invalid manifest ${key}`);
	}
	for (const key of [
		"artifactsDir",
		"manifestPath",
		"statePath",
		"logPath",
		"verificationPath",
		"spoolPath",
	]) {
		if (!isAbsolute(requiredString(record, key)))
			throw new SidecarUsageError(`${key} must be absolute`);
	}
	const artifactsDir = requiredString(record, "artifactsDir");
	if (
		resolve(artifactsDir) !== artifactsDir ||
		basename(artifactsDir) !== runId
	) {
		throw new SidecarUsageError("Manifest artifact ownership is invalid");
	}
	const ownedPaths: Record<string, string> = {
		manifestPath: "manifest.json",
		statePath: "state.json",
		logPath: "supervisor.log",
		verificationPath: "verification.json",
		spoolPath: "strategy-spool.sqlite",
	};
	for (const [key, filename] of Object.entries(ownedPaths)) {
		if (requiredString(record, key) !== join(artifactsDir, filename)) {
			throw new SidecarUsageError(`Manifest ${key} is not run-owned`);
		}
	}
	const safeId = runId.replaceAll(/[^A-Za-z0-9_.-]/g, "-").slice(0, 50);
	if (record.containerName !== `cex-sidecar-${safeId}`) {
		throw new SidecarUsageError("Manifest container identity is invalid");
	}
	if (
		record.deploymentId !== `sidecar-${runId}` ||
		record.captureBundleId !== `sidecar-bundle-${runId}`
	) {
		throw new SidecarUsageError("Manifest capture identity is invalid");
	}
	if (
		record.baselineSha !== BASELINE_SHA ||
		record.clickhouseImage !== CLICKHOUSE_IMAGE
	) {
		throw new SidecarUsageError("Manifest pinned runtime identity is invalid");
	}
	for (const [key, expectedPath] of [
		["clickhouseUrl", "/"],
		["forwarderUrl", "/archive"],
		["forwarderHealthUrl", "/health"],
	] as const) {
		const url = new URL(requiredString(record, key));
		if (
			url.protocol !== "http:" ||
			url.hostname !== "127.0.0.1" ||
			!url.port ||
			url.pathname !== expectedPath ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new SidecarUsageError(
				`Manifest ${key} is outside the loopback boundary`,
			);
		}
	}
	if (!Number.isFinite(Date.parse(requiredString(record, "createdAt")))) {
		throw new SidecarUsageError("Manifest creation time is invalid");
	}
	if (
		!Number.isSafeInteger(record.supervisorPid) ||
		Number(record.supervisorPid) <= 0
	) {
		throw new SidecarUsageError("Invalid supervisorPid");
	}
	const commands = record.commands;
	if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
		throw new SidecarUsageError("Invalid manifest commands");
	}
	const commandKeys = Object.keys(commands as object).sort();
	if (commandKeys.join(",") !== "down,ready,up,verify") {
		throw new SidecarUsageError(
			"Manifest commands must use the closed lifecycle surface",
		);
	}
	for (const key of commandKeys)
		requiredString(commands as Record<string, unknown>, key);
	return record as SidecarManifest;
}

async function run(
	program: string,
	args: string[],
	allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([program, ...args], {
		cwd: REPOSITORY_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0 && !allowFailure) {
		throw new Error(
			`${program} ${args.join(" ")} failed (${code}): ${stderr.trim()}`,
		);
	}
	return { code, stdout, stderr };
}

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Unable to allocate a sidecar port"));
				return;
			}
			server.close((error) =>
				error ? reject(error) : resolvePort(address.port),
			);
		});
	});
}

function internalSecret(runId: string): string {
	return createHash("sha256")
		.update(`cex-sidecar-test-only\0${runId}`)
		.digest("hex");
}

async function readManifest(path: string): Promise<SidecarManifest> {
	return validateSidecarManifest(JSON.parse(await readFile(path, "utf8")));
}

async function readState(manifest: SidecarManifest): Promise<SidecarState> {
	return JSON.parse(await readFile(manifest.statePath, "utf8")) as SidecarState;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitReady(
	manifest: SidecarManifest,
	timeoutMs: number,
): Promise<SidecarState> {
	const deadline = Date.now() + timeoutMs;
	let diagnostic = "state not written";
	while (Date.now() < deadline) {
		if (!processAlive(manifest.supervisorPid))
			throw new Error("Sidecar supervisor exited before readiness");
		try {
			const state = await readState(manifest);
			if (state.error) throw new Error(state.error);
			const healthResponse = await fetch(manifest.forwarderHealthUrl);
			const health = (await healthResponse.json()) as Record<string, unknown>;
			const spool = health.spool as Record<string, unknown> | undefined;
			if (
				state.ready &&
				state.brokerPort &&
				state.feedsReady?.length === 4 &&
				healthResponse.ok &&
				health.clickhouse === true &&
				health.durableAdmission === true &&
				spool?.healthy === true
			)
				return state;
			diagnostic = JSON.stringify({ state, health });
		} catch (error) {
			diagnostic = error instanceof Error ? error.message : String(error);
		}
		await Bun.sleep(250);
	}
	await writeFile(
		join(manifest.artifactsDir, "readiness-failure.json"),
		`${JSON.stringify({ ready: false, diagnostic }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	throw new Error(`Sidecar readiness timed out: ${diagnostic}`);
}

async function currentCommit(): Promise<string> {
	return (await run("git", ["rev-parse", "HEAD"])).stdout.trim().toLowerCase();
}

async function assertCleanCandidate(): Promise<void> {
	const status = await run("git", [
		"status",
		"--porcelain",
		"--untracked-files=all",
	]);
	if (status.stdout.trim()) {
		throw new SidecarUsageError(
			"sidecar evidence requires a clean CEX candidate checkout",
		);
	}
}

async function up(invocation: UpInvocation): Promise<SidecarManifest> {
	await assertCleanCandidate();
	if ((await currentCommit()) !== invocation.candidateSha) {
		throw new SidecarUsageError(
			"candidate-sha must equal the checked-out CEX commit",
		);
	}
	const artifactsDir = join(invocation.artifactsDir, invocation.runId);
	const manifestPath = join(artifactsDir, "manifest.json");
	try {
		await access(artifactsDir);
		throw new SidecarUsageError(
			`Run directory already exists: ${artifactsDir}`,
		);
	} catch (error) {
		if (error instanceof SidecarUsageError) throw error;
	}
	await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
	const safeId = invocation.runId
		.replaceAll(/[^A-Za-z0-9_.-]/g, "-")
		.slice(0, 50);
	const containerName = `cex-sidecar-${safeId}`;
	const forwarderPort = await freePort();
	let containerStarted = false;
	let supervisorPid: number | undefined;
	try {
		await run("docker", [
			"run",
			"-d",
			"--name",
			containerName,
			"-e",
			"CLICKHOUSE_USER=default",
			"-e",
			`CLICKHOUSE_PASSWORD=${internalSecret(invocation.runId)}`,
			"-p",
			"127.0.0.1::8123",
			CLICKHOUSE_IMAGE,
		]);
		containerStarted = true;
		const portOutput = await run("docker", ["port", containerName, "8123/tcp"]);
		const port = portOutput.stdout.match(/:(\d+)\s*$/m)?.[1];
		if (!port) throw new Error("Unable to resolve sidecar ClickHouse port");
		const logPath = join(artifactsDir, "supervisor.log");
		const logFd = openSync(logPath, "a", 0o600);
		const child = spawn(
			process.execPath,
			[
				"run",
				"scripts/archive-sidecar-supervisor.ts",
				"--manifest",
				manifestPath,
			],
			{
				cwd: REPOSITORY_ROOT,
				detached: true,
				stdio: ["ignore", logFd, logFd],
				env: {
					...process.env,
					ARCHIVE_SIDECAR_INTERNAL_SECRET: internalSecret(invocation.runId),
				},
			},
		);
		closeSync(logFd);
		if (!child.pid) throw new Error("Unable to start sidecar supervisor");
		supervisorPid = child.pid;
		child.unref();
		const manifest: SidecarManifest = {
			schemaVersion: MANIFEST_SCHEMA,
			runId: invocation.runId,
			profile: invocation.profile,
			candidateSha: invocation.candidateSha,
			makerSha: invocation.makerSha,
			baselineSha: BASELINE_SHA,
			artifactsDir,
			manifestPath,
			statePath: join(artifactsDir, "state.json"),
			logPath,
			verificationPath: join(artifactsDir, "verification.json"),
			spoolPath: join(artifactsDir, "strategy-spool.sqlite"),
			containerName,
			clickhouseUrl: `http://127.0.0.1:${port}`,
			forwarderUrl: `http://127.0.0.1:${forwarderPort}/archive`,
			forwarderHealthUrl: `http://127.0.0.1:${forwarderPort}/health`,
			deploymentId: `sidecar-${invocation.runId}`,
			captureBundleId: `sidecar-bundle-${invocation.runId}`,
			createdAt: new Date().toISOString(),
			clickhouseImage: CLICKHOUSE_IMAGE,
			supervisorPid: child.pid,
			commands: {
				up: "bun run archive:sidecar -- up",
				ready: "bun run archive:sidecar -- ready --manifest <path>",
				verify: "bun run archive:sidecar -- verify --manifest <path>",
				down: "bun run archive:sidecar -- down --manifest <path>",
			},
		};
		validateSidecarManifest(manifest);
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
			mode: 0o600,
		});
		await waitReady(manifest, READY_TIMEOUT_MS);
		return manifest;
	} catch (error) {
		if (supervisorPid && processAlive(supervisorPid)) {
			process.kill(supervisorPid, "SIGTERM");
		}
		if (containerStarted)
			await run("docker", ["rm", "-f", containerName], true);
		throw error;
	}
}

async function queryCount(
	client: ReturnType<typeof createClient>,
	table: string,
	where: string,
): Promise<number> {
	const result = await client.query({
		query: `SELECT count() AS rows FROM ${table} WHERE ${where}`,
		format: "JSONEachRow",
	});
	const rows = (await result.json()) as Array<{ rows: string }>;
	return Number(rows[0]?.rows ?? 0);
}

async function sha256File(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function verify(
	manifest: SidecarManifest,
): Promise<Record<string, unknown>> {
	const state = await waitReady(manifest, READY_TIMEOUT_MS);
	const client = createClient({
		url: manifest.clickhouseUrl,
		username: "default",
		password: internalSecret(manifest.runId),
	});
	let result: Record<string, unknown>;
	try {
		const marketTables = [
			"market_data.cex_stream_events",
			"market_data.cex_ticker_events",
			"market_data.cex_trades",
			"market_data.cex_ohlcv",
			"market_data.cex_order_book_levels",
			"market_data.cex_order_book_depth_summary",
		];
		const marketCounts: Record<string, number> = {};
		for (const table of marketTables) {
			marketCounts[table] = await queryCount(
				client,
				table,
				`deployment_id = '${manifest.deploymentId}' AND capture_bundle_id = '${manifest.captureBundleId}'`,
			);
			if (marketCounts[table] === 0)
				throw new Error(`Missing sidecar market rows in ${table}`);
		}
		const expectedSource =
			manifest.profile === "native_replay" ? "maker_replay" : "hb_runtime";
		const strategyCounts: Record<string, number> = {};
		for (const table of STRATEGY_TABLES) {
			strategyCounts[table] = await queryCount(
				client,
				table,
				`deployment_id = '${manifest.deploymentId}' AND source = '${expectedSource}' AND schema_version = '2' AND producer_run_id = '${manifest.runId}' AND stream_seq > 0 AND seq > 0`,
			);
			if (strategyCounts[table] === 0)
				throw new Error(`Missing v2 ${expectedSource} rows in ${table}`);
		}
		if (
			manifest.profile === "native_replay" &&
			(state.strategy?.httpStatus !== 200 ||
				state.strategy.spoolDrained !== true)
		) {
			throw new Error(
				"Native replay did not use synchronous out-of-spool delivery",
			);
		}
		if (
			manifest.profile === "production_compatible" &&
			(state.strategy?.httpStatus !== 202 ||
				state.strategy.spoolDrained !== true)
		) {
			throw new Error(
				"Production-compatible strategy evidence lacks durable admission and drainage",
			);
		}
		const exportArtifacts: Record<string, unknown> = {};
		if (manifest.profile === "native_replay") {
			if (!state.marketCapture?.sourceWindow)
				throw new Error("Native replay window is absent");
			const exportDirectory = join(
				manifest.artifactsDir,
				"fiet-907-reference-export",
			);
			const replayWindow = {
				clickhouseUrl: manifest.clickhouseUrl,
				username: "default",
				password: internalSecret(manifest.runId),
				captureBundleIds: [manifest.captureBundleId],
				exchange: "binance",
				tradingPair: "BTC-USDT",
				...state.marketCapture.sourceWindow,
			};
			const replayCoverage =
				await validateCanonicalMarketReplayWindow(replayWindow);
			const exported = await exportCanonicalOrderBookParquet({
				...replayWindow,
				outputDirectory: exportDirectory,
			});
			if (exported.levelRows === 0 || exported.summaryRows === 0)
				throw new Error("FIET-907 reference export is empty");
			exportArtifacts.levels = {
				path: exported.levelsPath,
				rows: exported.levelRows,
				sha256: await sha256File(exported.levelsPath),
			};
			exportArtifacts.summary = {
				path: exported.summaryPath,
				rows: exported.summaryRows,
				sha256: await sha256File(exported.summaryPath),
			};
			exportArtifacts.coverage = replayCoverage;
		}
		const versionResult = await client.query({
			query: "SELECT version() AS version",
			format: "JSONEachRow",
		});
		const versionRows = (await versionResult.json()) as Array<{
			version: string;
		}>;
		const python = await run("python3", ["--version"]);
		const verificationInputStatePath = join(
			manifest.artifactsDir,
			"verification-input-state.json",
		);
		await writeFile(
			verificationInputStatePath,
			`${JSON.stringify(state, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const evidenceArtifactHashes = {
			manifest: {
				path: manifest.manifestPath,
				sha256: await sha256File(manifest.manifestPath),
			},
			verificationInputState: {
				path: verificationInputStatePath,
				sha256: await sha256File(verificationInputStatePath),
			},
		};
		result = {
			schemaVersion: "cex-archive-sidecar-verification/v1",
			status: "passed",
			runId: manifest.runId,
			profile: manifest.profile,
			commits: {
				baseline: manifest.baselineSha,
				candidate: manifest.candidateSha,
				maker: manifest.makerSha,
			},
			identities: {
				deploymentId: manifest.deploymentId,
				captureBundleId: manifest.captureBundleId,
			},
			versions: {
				clickhouse: versionRows[0]?.version,
				bun: Bun.version,
				python: (python.stdout || python.stderr).trim(),
				marketSchema: MARKET_CAPTURE_SCHEMA_VERSION,
				checksum: CHECKSUM_ALGORITHM,
				strategySchema: "2",
			},
			paths: {
				strategy:
					expectedSource === "hb_runtime"
						? "durable_spool_202"
						: "synchronous_direct_200",
				parquetOwnership: "FIET-907-compatible direct ClickHouse exporter",
			},
			outcomes: {
				readiness: true,
				migration: "not_applicable_sidecar_latest_schema",
				spool: state.forwarderHealth?.spool,
				marketCounts,
				strategyCounts,
				exportArtifacts,
			},
			artifactHashes: evidenceArtifactHashes,
			commands: manifest.commands,
		};
	} catch (error) {
		result = {
			schemaVersion: "cex-archive-sidecar-verification/v1",
			status: "failed",
			runId: manifest.runId,
			profile: manifest.profile,
			commits: {
				baseline: manifest.baselineSha,
				candidate: manifest.candidateSha,
				maker: manifest.makerSha,
			},
			error: error instanceof Error ? error.message : String(error),
		};
		await writeFile(
			manifest.verificationPath,
			`${JSON.stringify(result, null, 2)}\n`,
			{ mode: 0o600 },
		);
		throw error;
	} finally {
		await client.close();
	}
	await writeFile(
		manifest.verificationPath,
		`${JSON.stringify(result, null, 2)}\n`,
		{ mode: 0o600 },
	);
	return result;
}

async function down(manifest: SidecarManifest): Promise<void> {
	if (processAlive(manifest.supervisorPid)) {
		process.kill(manifest.supervisorPid, "SIGTERM");
		const deadline = Date.now() + 15_000;
		while (processAlive(manifest.supervisorPid) && Date.now() < deadline)
			await Bun.sleep(100);
		if (processAlive(manifest.supervisorPid))
			process.kill(manifest.supervisorPid, "SIGKILL");
	}
	if (!manifest.containerName.startsWith("cex-sidecar-"))
		throw new SidecarUsageError("Refusing to remove an unowned container");
	await run("docker", ["rm", "-f", manifest.containerName], true);
	for (const path of [
		manifest.spoolPath,
		`${manifest.spoolPath}-wal`,
		`${manifest.spoolPath}-shm`,
	]) {
		await rm(path, { force: true });
	}
}

async function main(): Promise<void> {
	const invocation = parseSidecarInvocation(process.argv.slice(2));
	if (invocation.operation === "up") {
		const manifest = await up(invocation);
		console.info(manifest.manifestPath);
		return;
	}
	const manifest = await readManifest(invocation.manifestPath);
	if (resolve(manifest.manifestPath) !== resolve(invocation.manifestPath))
		throw new SidecarUsageError("Manifest path identity mismatch");
	if (invocation.operation === "ready") {
		await waitReady(manifest, invocation.timeoutMs ?? READY_TIMEOUT_MS);
		console.info(
			JSON.stringify({ ready: true, manifest: manifest.manifestPath }),
		);
		return;
	}
	if (invocation.operation === "verify") {
		console.info(JSON.stringify(await verify(manifest)));
		return;
	}
	await down(manifest);
	console.info(
		JSON.stringify({ stopped: true, manifest: manifest.manifestPath }),
	);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(error instanceof SidecarUsageError ? 2 : 1);
	}
}
