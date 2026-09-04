#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createClient } from "@clickhouse/client";
import {
	CHECKSUM_ALGORITHM,
	MARKET_CAPTURE_SCHEMA_VERSION,
} from "../src/helpers/market-data-archive/capture-contract";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:24.8";
const MANIFEST_SCHEMA = "cex-archive-sidecar/v2";
const MAKER_RESULT_SCHEMA = "fiet-maker-cex-sidecar-conformance/v2";
const VERIFICATION_SCHEMA = "cex-archive-sidecar-verification/v2";
const PROOF_C_SCHEMA = "cex-maker-sidecar-proof-c/v2";
const READY_TIMEOUT_MS = 120_000;
const VERIFICATION_TIMEOUT_MS = 120_000;
const MAX_RESULT_DURATION_MS = 300_000;
const MAX_STRATEGY_ROWS = 1_000;
const SHARED_WIRE_FIXTURE = {
	schemaVersion: "fiet-maker-cex-shared-wire/v2",
	id: "production-compatible-layer12-archive-emitter",
	sha256: "5c9fd679a5a05ebce5f5158f4cc376360f24a34d9a07edeee43e94e564db3ee7",
} as const;
const STRATEGY_TABLES = [
	"strategy_data.policy_evaluation_events",
	"strategy_data.strategy_policy_snapshots",
	"strategy_data.market_identity",
	"strategy_data.symbol_mapping",
	"strategy_data.inventory_settlement_events",
] as const;

type StrategyTable = (typeof STRATEGY_TABLES)[number];
type Profile = "production_compatible";

export class SidecarUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SidecarUsageError";
	}
}

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
	artifactsDir: string;
	manifestPath: string;
	statePath: string;
	logPath: string;
	verificationPath: string;
	spoolPath: string;
	producerAccessPath: string;
	makerResultPath: string;
	containerName: string;
	clickhouseUrl: string;
	forwarderUrl: string;
	forwarderHealthUrl: string;
	brokerUrl: string;
	deploymentId: string;
	captureBundleId: string;
	createdAt: string;
	clickhouseImage: string;
	evidenceBounds: {
		readyTimeoutMs: typeof READY_TIMEOUT_MS;
		verificationTimeoutMs: typeof VERIFICATION_TIMEOUT_MS;
		maxStrategyRows: typeof MAX_STRATEGY_ROWS;
	};
	sharedWireFixture: typeof SHARED_WIRE_FIXTURE;
	strategyExpectation: {
		source: "hb_runtime";
		producerId: string;
		producerRunId: string;
		tableRows: Record<StrategyTable, 1>;
	};
	supervisorPid: number;
	commands: {
		up: string;
		ready: string;
		verify: string;
		down: string;
	};
};

type BrokerObservations = {
	collectorSubscriptionCalls: Record<string, number>;
	totalSubscriptionCalls: Record<string, number>;
	externalSubscriptionCalls: Record<string, number>;
	physicalWorkers: Record<string, number>;
	physicalFrames: Record<string, number>;
	archiveDecisions: Record<string, number>;
	orderBookSnapshotCalls: number;
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
	forwarderHealth?: Record<string, unknown>;
	brokerObservations?: BrokerObservations;
	error?: string;
};

export type MakerSidecarResult = {
	schemaVersion: typeof MAKER_RESULT_SCHEMA;
	status: "passed";
	runId: string;
	profile: Profile;
	makerSha: string;
	candidateSha: string;
	deploymentId: string;
	captureBundleId: string;
	source: "hb_runtime";
	producerId: string;
	producerRunId: string;
	startedAt: string;
	completedAt: string;
	delivery: {
		httpStatus: 202;
		batchId: string;
		acceptedRows: number;
		spoolQueuedBefore: number;
		spoolQueuedAfter: 0;
	};
	tableRows: Record<
		StrategyTable,
		{ count: number; archiveEventIds: string[] }
	>;
	profileEvidence: {
		brokerBoundaryObserved: true;
		brokerObservation: {
			schemaVersion: "fiet-hummingbot-external-sidecar-broker/v2";
			status: "passed";
			boundary: "external_sidecar_broker";
			layer12Boundary: "layer12_live_reference_depth";
			currentSnapshotObserved: true;
			liveSubscriptionObserved: true;
		};
		makerCheckout: {
			branch: "develop";
			clean: true;
			sha: string;
			originDevelopSha: string;
			sharedWireFixture: typeof SHARED_WIRE_FIXTURE;
			wireContractTests: { exitCode: 0 };
		};
	};
	artifactHashes: {
		sharedWireTest: { sha256: string };
	};
};

const MANIFEST_KEYS = new Set([
	"schemaVersion",
	"runId",
	"profile",
	"candidateSha",
	"makerSha",
	"artifactsDir",
	"manifestPath",
	"statePath",
	"logPath",
	"verificationPath",
	"spoolPath",
	"producerAccessPath",
	"makerResultPath",
	"containerName",
	"clickhouseUrl",
	"forwarderUrl",
	"forwarderHealthUrl",
	"brokerUrl",
	"deploymentId",
	"captureBundleId",
	"createdAt",
	"clickhouseImage",
	"evidenceBounds",
	"sharedWireFixture",
	"strategyExpectation",
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

function validBoundedId(value: unknown, maxLength = 200): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
	);
}

export function parseSidecarInvocation(args: string[]): SidecarInvocation {
	const [operation, ...rest] = args;
	if (
		operation !== "up" &&
		operation !== "ready" &&
		operation !== "verify" &&
		operation !== "down"
	) {
		throw new SidecarUsageError("Operation must be up, ready, verify, or down");
	}
	const parsed = flags(rest);
	if (operation === "up") {
		requireOnly(parsed, [
			"--run-id",
			"--profile",
			"--candidate-sha",
			"--maker-sha",
			"--artifacts-dir",
		]);
		const runId = parsed.get("--run-id") as string;
		const profile = parsed.get("--profile");
		const candidateSha = parsed.get("--candidate-sha") as string;
		const makerSha = parsed.get("--maker-sha") as string;
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
			throw new SidecarUsageError(
				"run-id must be a bounded path-safe identifier",
			);
		}
		if (profile !== "production_compatible") {
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
			/(token|secret|credential|api.?key|password|environment|(^|_)env($|_))/i.test(
				key,
			)
		) {
			throw new SidecarUsageError(`Secret-bearing field ${path}.${key}`);
		}
		assertNoSecrets(nested, `${path}.${key}`);
	}
}

function requiredString(
	record: Record<string, unknown>,
	key: string,
	label = "manifest",
): string {
	const value = record[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new SidecarUsageError(`Invalid ${label} field ${key}`);
	}
	return value;
}

function exactObjectKeys(
	value: unknown,
	expected: readonly string[],
	label: string,
): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SidecarUsageError(`${label} must be an object`);
	}
	if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
		throw new SidecarUsageError(
			`${label} uses an unknown or incomplete field set`,
		);
	}
	return true;
}

function validateSharedWireFixture(value: unknown, label: string): void {
	exactObjectKeys(value, ["schemaVersion", "id", "sha256"], label);
	const fixture = value as Record<string, unknown>;
	if (
		fixture.schemaVersion !== SHARED_WIRE_FIXTURE.schemaVersion ||
		fixture.id !== SHARED_WIRE_FIXTURE.id ||
		fixture.sha256 !== SHARED_WIRE_FIXTURE.sha256
	) {
		throw new SidecarUsageError(`${label} identity is unsupported`);
	}
}

export function validateSidecarManifest(value: unknown): SidecarManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SidecarUsageError("Manifest must be an object");
	}
	assertNoSecrets(value);
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!MANIFEST_KEYS.has(key)) {
			throw new SidecarUsageError(`Unknown manifest field ${key}`);
		}
	}
	for (const key of MANIFEST_KEYS) {
		if (!(key in record)) {
			throw new SidecarUsageError(`Missing manifest field ${key}`);
		}
	}
	if (record.schemaVersion !== MANIFEST_SCHEMA) {
		throw new SidecarUsageError("Unsupported manifest schema");
	}
	const runId = requiredString(record, "runId");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
		throw new SidecarUsageError("Invalid manifest runId");
	}
	if (record.profile !== "production_compatible") {
		throw new SidecarUsageError("Unsupported manifest profile");
	}
	for (const key of ["candidateSha", "makerSha"]) {
		if (!validSha(requiredString(record, key))) {
			throw new SidecarUsageError(`Invalid manifest ${key}`);
		}
	}
	for (const key of [
		"artifactsDir",
		"manifestPath",
		"statePath",
		"logPath",
		"verificationPath",
		"spoolPath",
		"producerAccessPath",
		"makerResultPath",
	]) {
		if (!isAbsolute(requiredString(record, key))) {
			throw new SidecarUsageError(`${key} must be absolute`);
		}
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
		producerAccessPath: "producer-access.json",
		makerResultPath: "maker-result.json",
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
	if (record.clickhouseImage !== CLICKHOUSE_IMAGE) {
		throw new SidecarUsageError("Manifest pinned runtime identity is invalid");
	}
	if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(requiredString(record, "brokerUrl"))) {
		throw new SidecarUsageError("Manifest brokerUrl is invalid");
	}
	const [brokerHost, brokerPort] = requiredString(record, "brokerUrl").split(
		":",
	);
	if (
		brokerHost !== "127.0.0.1" ||
		Number(brokerPort) <= 0 ||
		Number(brokerPort) > 65_535
	) {
		throw new SidecarUsageError(
			"Manifest brokerUrl is outside the loopback boundary",
		);
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
	exactObjectKeys(
		record.evidenceBounds,
		["readyTimeoutMs", "verificationTimeoutMs", "maxStrategyRows"],
		"Manifest evidenceBounds",
	);
	const evidenceBounds = record.evidenceBounds as Record<string, unknown>;
	if (
		evidenceBounds.readyTimeoutMs !== READY_TIMEOUT_MS ||
		evidenceBounds.verificationTimeoutMs !== VERIFICATION_TIMEOUT_MS ||
		evidenceBounds.maxStrategyRows !== MAX_STRATEGY_ROWS
	) {
		throw new SidecarUsageError("Manifest evidence bounds are invalid");
	}
	validateSharedWireFixture(
		record.sharedWireFixture,
		"Manifest sharedWireFixture",
	);
	exactObjectKeys(
		record.strategyExpectation,
		["source", "producerId", "producerRunId", "tableRows"],
		"Manifest strategyExpectation",
	);
	const strategyExpectation = record.strategyExpectation as Record<
		string,
		unknown
	>;
	if (
		strategyExpectation.source !== "hb_runtime" ||
		strategyExpectation.producerId !==
			`hb_runtime:sidecar-${runId}:cex-sidecar-conformance` ||
		strategyExpectation.producerRunId !== runId
	) {
		throw new SidecarUsageError(
			"Manifest strategy producer identity is invalid",
		);
	}
	exactObjectKeys(
		strategyExpectation.tableRows,
		STRATEGY_TABLES,
		"Manifest strategyExpectation.tableRows",
	);
	if (
		STRATEGY_TABLES.some(
			(table) =>
				(strategyExpectation.tableRows as Record<string, unknown>)[table] !== 1,
		)
	) {
		throw new SidecarUsageError("Manifest strategy row counts are invalid");
	}
	if (
		!Number.isSafeInteger(record.supervisorPid) ||
		Number(record.supervisorPid) <= 0
	) {
		throw new SidecarUsageError("Invalid supervisorPid");
	}
	exactObjectKeys(
		record.commands,
		["up", "ready", "verify", "down"],
		"Manifest commands",
	);
	for (const key of ["up", "ready", "verify", "down"]) {
		requiredString(record.commands as Record<string, unknown>, key, "command");
	}
	return record as SidecarManifest;
}

function parseTimestamp(value: unknown, label: string): number {
	if (typeof value !== "string") {
		throw new SidecarUsageError(`${label} is invalid`);
	}
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed))
		throw new SidecarUsageError(`${label} is invalid`);
	return parsed;
}

export async function validateMakerSidecarResult(
	value: unknown,
): Promise<MakerSidecarResult> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SidecarUsageError("Maker result must be an object");
	}
	assertNoSecrets(value, "makerResult");
	const result = value as Record<string, unknown>;
	const expectedKeys = [
		"artifactHashes",
		"candidateSha",
		"captureBundleId",
		"completedAt",
		"delivery",
		"deploymentId",
		"makerSha",
		"producerId",
		"producerRunId",
		"profile",
		"profileEvidence",
		"runId",
		"schemaVersion",
		"source",
		"startedAt",
		"status",
		"tableRows",
	];
	exactObjectKeys(result, expectedKeys, "Maker result");
	if (
		result.schemaVersion !== MAKER_RESULT_SCHEMA ||
		result.status !== "passed"
	) {
		throw new SidecarUsageError(
			"Maker result did not pass the supported schema",
		);
	}
	if (result.profile !== "production_compatible") {
		throw new SidecarUsageError("Maker result profile is unsupported");
	}
	for (const key of ["makerSha", "candidateSha"]) {
		if (!validSha(requiredString(result, key, "Maker result"))) {
			throw new SidecarUsageError(`Maker result ${key} is invalid`);
		}
	}
	const runId = requiredString(result, "runId", "Maker result");
	const deploymentId = requiredString(result, "deploymentId", "Maker result");
	if (result.captureBundleId !== `sidecar-bundle-${runId}`) {
		throw new SidecarUsageError("Maker result capture identity is invalid");
	}
	const producerId = requiredString(result, "producerId", "Maker result");
	if (
		result.source !== "hb_runtime" ||
		result.producerRunId !== runId ||
		producerId !== `hb_runtime:${deploymentId}:cex-sidecar-conformance`
	) {
		throw new SidecarUsageError(
			"Maker result provenance is not the exact external producer",
		);
	}
	const startedAt = parseTimestamp(result.startedAt, "Maker result startedAt");
	const completedAt = parseTimestamp(
		result.completedAt,
		"Maker result completedAt",
	);
	if (
		completedAt < startedAt ||
		completedAt - startedAt > MAX_RESULT_DURATION_MS
	) {
		throw new SidecarUsageError(
			"Maker result timestamps exceed the bounded run",
		);
	}
	exactObjectKeys(
		result.delivery,
		[
			"httpStatus",
			"batchId",
			"acceptedRows",
			"spoolQueuedBefore",
			"spoolQueuedAfter",
		],
		"Maker result delivery",
	);
	const delivery = result.delivery as Record<string, unknown>;
	if (
		delivery.httpStatus !== 202 ||
		!validBoundedId(delivery.batchId) ||
		delivery.batchId !== result.runId ||
		!Number.isSafeInteger(delivery.acceptedRows) ||
		Number(delivery.acceptedRows) < STRATEGY_TABLES.length ||
		Number(delivery.acceptedRows) > MAX_STRATEGY_ROWS ||
		!Number.isSafeInteger(delivery.spoolQueuedBefore) ||
		Number(delivery.spoolQueuedBefore) < 0 ||
		delivery.spoolQueuedAfter !== 0
	) {
		throw new SidecarUsageError("Maker result delivery evidence is invalid");
	}
	exactObjectKeys(result.tableRows, STRATEGY_TABLES, "Maker result tableRows");
	const tableRows = result.tableRows as Record<string, unknown>;
	let totalRows = 0;
	for (const table of STRATEGY_TABLES) {
		exactObjectKeys(
			tableRows[table],
			["count", "archiveEventIds"],
			`Maker result tableRows.${table}`,
		);
		const evidence = tableRows[table] as Record<string, unknown>;
		if (
			!Number.isSafeInteger(evidence.count) ||
			Number(evidence.count) < 1 ||
			!Array.isArray(evidence.archiveEventIds) ||
			evidence.archiveEventIds.length !== Number(evidence.count) ||
			new Set(evidence.archiveEventIds).size !==
				evidence.archiveEventIds.length ||
			evidence.archiveEventIds.some((id) => !validBoundedId(id))
		) {
			throw new SidecarUsageError(
				`Maker result tableRows.${table} row identity is invalid`,
			);
		}
		totalRows += Number(evidence.count);
	}
	if (totalRows !== delivery.acceptedRows) {
		throw new SidecarUsageError(
			"Maker result accepted row count does not match the exact five tables",
		);
	}
	exactObjectKeys(
		result.profileEvidence,
		["brokerBoundaryObserved", "brokerObservation", "makerCheckout"],
		"Maker result profileEvidence",
	);
	const profileEvidence = result.profileEvidence as Record<string, unknown>;
	if (profileEvidence.brokerBoundaryObserved !== true) {
		throw new SidecarUsageError(
			"Maker result lacks the Layer12 broker boundary",
		);
	}
	exactObjectKeys(
		profileEvidence.brokerObservation,
		[
			"schemaVersion",
			"status",
			"boundary",
			"layer12Boundary",
			"currentSnapshotObserved",
			"liveSubscriptionObserved",
		],
		"Maker result brokerObservation",
	);
	const brokerObservation = profileEvidence.brokerObservation as Record<
		string,
		unknown
	>;
	if (
		brokerObservation.schemaVersion !==
			"fiet-hummingbot-external-sidecar-broker/v2" ||
		brokerObservation.status !== "passed" ||
		brokerObservation.boundary !== "external_sidecar_broker" ||
		brokerObservation.layer12Boundary !== "layer12_live_reference_depth" ||
		brokerObservation.currentSnapshotObserved !== true ||
		brokerObservation.liveSubscriptionObserved !== true
	) {
		throw new SidecarUsageError(
			"Maker result lacks the real current/live Layer12 broker path",
		);
	}
	exactObjectKeys(
		profileEvidence.makerCheckout,
		[
			"branch",
			"clean",
			"sha",
			"originDevelopSha",
			"sharedWireFixture",
			"wireContractTests",
		],
		"Maker result makerCheckout",
	);
	const makerCheckout = profileEvidence.makerCheckout as Record<
		string,
		unknown
	>;
	exactObjectKeys(
		makerCheckout.wireContractTests,
		["exitCode"],
		"Maker result wireContractTests",
	);
	if (
		makerCheckout.branch !== "develop" ||
		makerCheckout.clean !== true ||
		makerCheckout.sha !== result.makerSha ||
		makerCheckout.originDevelopSha !== result.makerSha ||
		(makerCheckout.wireContractTests as Record<string, unknown>).exitCode !== 0
	) {
		throw new SidecarUsageError(
			"Maker result lacks a clean resolved develop checkout and passing wire test",
		);
	}
	validateSharedWireFixture(
		makerCheckout.sharedWireFixture,
		"Maker result sharedWireFixture",
	);
	exactObjectKeys(
		result.artifactHashes,
		["sharedWireTest"],
		"Maker result artifactHashes",
	);
	const artifactHashes = result.artifactHashes as Record<string, unknown>;
	exactObjectKeys(
		artifactHashes.sharedWireTest,
		["sha256"],
		"Maker result artifactHashes.sharedWireTest",
	);
	if (
		(artifactHashes.sharedWireTest as Record<string, unknown>).sha256 !==
		SHARED_WIRE_FIXTURE.sha256
	) {
		throw new SidecarUsageError(
			"Maker result shared-wire test artifact hash is invalid",
		);
	}
	return result as MakerSidecarResult;
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

async function readLoopbackHealth(
	manifest: SidecarManifest,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
	const url = new URL(manifest.forwarderHealthUrl);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/health" ||
		!url.port
	) {
		throw new SidecarUsageError("Forwarder health URL is outside loopback");
	}
	return new Promise((resolveHealth, reject) => {
		const healthRequest = request(
			{
				host: "127.0.0.1",
				port: Number(url.port),
				path: "/health",
				method: "GET",
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.once("error", reject);
				response.once("end", () => {
					try {
						resolveHealth({
							statusCode: response.statusCode ?? 0,
							body: JSON.parse(
								Buffer.concat(chunks).toString("utf8"),
							) as Record<string, unknown>,
						});
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		healthRequest.once("error", reject);
		healthRequest.end();
	});
}

async function waitReady(
	manifest: SidecarManifest,
	timeoutMs: number,
): Promise<SidecarState> {
	const deadline = Date.now() + timeoutMs;
	let diagnostic = "state not written";
	while (Date.now() < deadline) {
		if (!processAlive(manifest.supervisorPid)) {
			throw new Error("Sidecar supervisor exited before readiness");
		}
		try {
			const state = await readState(manifest);
			if (state.error) throw new Error(state.error);
			const healthResponse = await readLoopbackHealth(manifest);
			const health = healthResponse.body;
			const spool = health.spool as Record<string, unknown> | undefined;
			if (
				state.ready &&
				state.brokerPort &&
				state.feedsReady?.length === 4 &&
				healthResponse.statusCode >= 200 &&
				healthResponse.statusCode < 300 &&
				health.clickhouse === true &&
				health.durableAdmission === true &&
				spool?.healthy === true
			) {
				return state;
			}
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
	const brokerPort = await freePort();
	const ephemeralPaths = {
		spoolPath: join(artifactsDir, "strategy-spool.sqlite"),
		producerAccessPath: join(artifactsDir, "producer-access.json"),
	};
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
			artifactsDir,
			manifestPath,
			statePath: join(artifactsDir, "state.json"),
			logPath,
			verificationPath: join(artifactsDir, "verification.json"),
			spoolPath: ephemeralPaths.spoolPath,
			producerAccessPath: ephemeralPaths.producerAccessPath,
			makerResultPath: join(artifactsDir, "maker-result.json"),
			containerName,
			clickhouseUrl: `http://127.0.0.1:${port}`,
			forwarderUrl: `http://127.0.0.1:${forwarderPort}/archive`,
			forwarderHealthUrl: `http://127.0.0.1:${forwarderPort}/health`,
			brokerUrl: `127.0.0.1:${brokerPort}`,
			deploymentId: `sidecar-${invocation.runId}`,
			captureBundleId: `sidecar-bundle-${invocation.runId}`,
			createdAt: new Date().toISOString(),
			clickhouseImage: CLICKHOUSE_IMAGE,
			evidenceBounds: {
				readyTimeoutMs: READY_TIMEOUT_MS,
				verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
				maxStrategyRows: MAX_STRATEGY_ROWS,
			},
			sharedWireFixture: SHARED_WIRE_FIXTURE,
			strategyExpectation: {
				source: "hb_runtime",
				producerId: `hb_runtime:sidecar-${invocation.runId}:cex-sidecar-conformance`,
				producerRunId: invocation.runId,
				tableRows: Object.fromEntries(
					STRATEGY_TABLES.map((table) => [table, 1]),
				) as Record<StrategyTable, 1>,
			},
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
		await writeFile(
			manifest.producerAccessPath,
			`${JSON.stringify(
				{
					schemaVersion: "cex-archive-sidecar-producer-access/v2",
					forwarderUrl: manifest.forwarderUrl,
					brokerUrl: manifest.brokerUrl,
					deploymentId: manifest.deploymentId,
					captureBundleId: manifest.captureBundleId,
					bearer: internalSecret(invocation.runId),
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
		await waitReady(manifest, READY_TIMEOUT_MS);
		return manifest;
	} catch (error) {
		if (supervisorPid && processAlive(supervisorPid)) {
			process.kill(supervisorPid, "SIGTERM");
		}
		if (containerStarted) {
			await run("docker", ["rm", "-f", containerName], true);
		}
		await removeSidecarEphemeralFiles(ephemeralPaths);
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

async function queryArchiveEventIds(
	client: ReturnType<typeof createClient>,
	table: string,
	where: string,
): Promise<string[]> {
	const result = await client.query({
		query: `SELECT archive_event_id FROM ${table} WHERE ${where} ORDER BY archive_event_id LIMIT ${MAX_STRATEGY_ROWS + 1}`,
		format: "JSONEachRow",
	});
	const rows = (await result.json()) as Array<{ archive_event_id: string }>;
	return rows.map(({ archive_event_id }) => archive_event_id);
}

async function sha256File(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

function sqlString(value: string): string {
	return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function orderBookObservation(state: SidecarState): {
	collectorSubscriptions: number;
	makerSubscriptions: number;
	totalSubscriptions: number;
	physicalWorkers: number;
	physicalFrames: number;
	archiveDecisions: number;
	currentSnapshotCalls: number;
} {
	return {
		collectorSubscriptions: Number(
			state.brokerObservations?.collectorSubscriptionCalls.ORDERBOOK ?? 0,
		),
		makerSubscriptions: Number(
			state.brokerObservations?.externalSubscriptionCalls.ORDERBOOK ?? 0,
		),
		totalSubscriptions: Number(
			state.brokerObservations?.totalSubscriptionCalls.ORDERBOOK ?? 0,
		),
		physicalWorkers: Number(
			state.brokerObservations?.physicalWorkers.ORDERBOOK ?? 0,
		),
		physicalFrames: Number(
			state.brokerObservations?.physicalFrames.ORDERBOOK ?? 0,
		),
		archiveDecisions: Number(
			state.brokerObservations?.archiveDecisions.ORDERBOOK ?? 0,
		),
		currentSnapshotCalls: Number(
			state.brokerObservations?.orderBookSnapshotCalls ?? 0,
		),
	};
}

function validateOrderBookObservation(
	state: SidecarState,
): ReturnType<typeof orderBookObservation> {
	const observation = orderBookObservation(state);
	if (
		observation.collectorSubscriptions < 1 ||
		observation.makerSubscriptions < 1 ||
		observation.totalSubscriptions < 2 ||
		observation.currentSnapshotCalls < 1 ||
		observation.physicalWorkers !== 1 ||
		observation.physicalFrames < 1 ||
		observation.archiveDecisions < 1 ||
		observation.archiveDecisions > observation.physicalFrames
	) {
		throw new Error(
			"Production-compatible Layer12 shared-feed and archive-decision evidence was not recorded",
		);
	}
	return observation;
}

async function verify(
	manifest: SidecarManifest,
): Promise<Record<string, unknown>> {
	let state = await waitReady(manifest, VERIFICATION_TIMEOUT_MS);
	const client = createClient({
		url: manifest.clickhouseUrl,
		username: "default",
		password: internalSecret(manifest.runId),
	});
	let result: Record<string, unknown>;
	try {
		const makerResult = await validateMakerSidecarResult(
			JSON.parse(await readFile(manifest.makerResultPath, "utf8")),
		);
		if (
			makerResult.runId !== manifest.runId ||
			makerResult.profile !== manifest.profile ||
			makerResult.makerSha !== manifest.makerSha ||
			makerResult.candidateSha !== manifest.candidateSha ||
			makerResult.deploymentId !== manifest.deploymentId ||
			makerResult.captureBundleId !== manifest.captureBundleId ||
			makerResult.profileEvidence.makerCheckout.sharedWireFixture.sha256 !==
				manifest.sharedWireFixture.sha256 ||
			makerResult.source !== manifest.strategyExpectation.source ||
			makerResult.producerId !== manifest.strategyExpectation.producerId ||
			makerResult.producerRunId !==
				manifest.strategyExpectation.producerRunId ||
			STRATEGY_TABLES.some(
				(table) =>
					makerResult.tableRows[table].count !==
					manifest.strategyExpectation.tableRows[table],
			)
		) {
			throw new Error(
				"Maker result identity does not match the sidecar manifest",
			);
		}
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
				`deployment_id = ${sqlString(manifest.deploymentId)} AND capture_bundle_id = ${sqlString(manifest.captureBundleId)}`,
			);
			if (marketCounts[table] === 0) {
				throw new Error(`Missing controlled-fixture market rows in ${table}`);
			}
		}
		const expectedProducerId = `hb_runtime:${manifest.deploymentId}:cex-sidecar-conformance`;
		const strategyCounts: Record<string, number> = {};
		for (const table of STRATEGY_TABLES) {
			const expected = makerResult.tableRows[table];
			const identityPredicate = `deployment_id = ${sqlString(manifest.deploymentId)} AND source = 'hb_runtime' AND schema_version = '2' AND producer_id = ${sqlString(expectedProducerId)} AND producer_run_id = ${sqlString(manifest.runId)} AND stream_seq > 0 AND seq > 0`;
			const observedIds = await queryArchiveEventIds(
				client,
				table,
				identityPredicate,
			);
			const expectedIds = [...expected.archiveEventIds].sort();
			strategyCounts[table] = observedIds.length;
			if (
				observedIds.length !== expected.count ||
				observedIds.join("\0") !== expectedIds.join("\0")
			) {
				throw new Error(
					`Exact hb_runtime row identities differ in ${table}: expected ${JSON.stringify(expectedIds)}, observed ${JSON.stringify(observedIds)}`,
				);
			}
		}
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			state = await readState(manifest);
			const observation = orderBookObservation(state);
			if (
				observation.makerSubscriptions >= 1 &&
				observation.currentSnapshotCalls >= 1 &&
				observation.archiveDecisions >= 1
			) {
				break;
			}
			await Bun.sleep(100);
		}
		const sharedFeed = validateOrderBookObservation(state);
		if (
			!state.forwarderHealth ||
			!(state.forwarderHealth.spool as Record<string, unknown> | undefined)
		) {
			throw new Error("Durable spool evidence is absent");
		}
		const spool = state.forwarderHealth.spool as Record<string, unknown>;
		if (
			Number(spool.queuedBatches ?? -1) !== 0 ||
			Number(spool.queuedWork ?? -1) !== 0 ||
			Number(spool.terminalWork ?? -1) !== 0
		) {
			throw new Error("Durable spool did not drain after the Maker batch");
		}
		const versionResult = await client.query({
			query: "SELECT version() AS version",
			format: "JSONEachRow",
		});
		const versionRows = (await versionResult.json()) as Array<{
			version: string;
		}>;
		const verificationInputStatePath = join(
			manifest.artifactsDir,
			"verification-input-state.json",
		);
		await writeFile(
			verificationInputStatePath,
			`${JSON.stringify(state, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const proofC = {
			schemaVersion: PROOF_C_SCHEMA,
			status: "passed",
			controlledFixture: {
				venue: "binance",
				profileId: "binance:l2-diff:500",
				captureBundleId: manifest.captureBundleId,
				sourceWindow: state.marketCapture?.sourceWindow,
			},
			layer12: {
				currentSnapshotObserved: true,
				liveSubscriptionObserved: true,
			},
			sharedFeed,
			durableDelivery: {
				httpStatus: makerResult.delivery.httpStatus,
				batchId: makerResult.delivery.batchId,
				acceptedRows: makerResult.delivery.acceptedRows,
				spoolQueuedBefore: makerResult.delivery.spoolQueuedBefore,
				spoolQueuedAfter: makerResult.delivery.spoolQueuedAfter,
				strategyCounts,
			},
		};
		result = {
			schemaVersion: VERIFICATION_SCHEMA,
			status: "passed",
			runId: manifest.runId,
			profile: manifest.profile,
			startedAt: makerResult.startedAt,
			completedAt: new Date().toISOString(),
			commits: {
				cex: manifest.candidateSha,
				maker: manifest.makerSha,
			},
			identities: {
				deploymentId: manifest.deploymentId,
				captureBundleId: manifest.captureBundleId,
				producerId: expectedProducerId,
				producerRunId: manifest.runId,
				batchId: makerResult.delivery.batchId,
			},
			sharedWireFixture: manifest.sharedWireFixture,
			versions: {
				clickhouse: versionRows[0]?.version,
				bun: Bun.version,
				marketSchema: MARKET_CAPTURE_SCHEMA_VERSION,
				checksum: CHECKSUM_ALGORITHM,
				strategySchema: "2",
			},
			outcomes: {
				readiness: true,
				spool: state.forwarderHealth?.spool,
				marketCounts,
				strategyCounts,
				proofC,
			},
			artifactHashes: {
				manifest: {
					path: manifest.manifestPath,
					sha256: await sha256File(manifest.manifestPath),
				},
				verificationInputState: {
					path: verificationInputStatePath,
					sha256: await sha256File(verificationInputStatePath),
				},
				makerResult: {
					path: manifest.makerResultPath,
					sha256: await sha256File(manifest.makerResultPath),
				},
			},
			commands: manifest.commands,
		};
	} catch (error) {
		result = {
			schemaVersion: VERIFICATION_SCHEMA,
			status: "failed",
			runId: manifest.runId,
			profile: manifest.profile,
			completedAt: new Date().toISOString(),
			commits: {
				cex: manifest.candidateSha,
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

export async function removeSidecarEphemeralFiles(paths: {
	spoolPath: string;
	producerAccessPath: string;
}): Promise<void> {
	for (const path of [
		paths.spoolPath,
		`${paths.spoolPath}-wal`,
		`${paths.spoolPath}-shm`,
		paths.producerAccessPath,
	]) {
		await rm(path, { force: true });
	}
}

async function down(manifest: SidecarManifest): Promise<void> {
	if (processAlive(manifest.supervisorPid)) {
		process.kill(manifest.supervisorPid, "SIGTERM");
		const deadline = Date.now() + 15_000;
		while (processAlive(manifest.supervisorPid) && Date.now() < deadline) {
			await Bun.sleep(100);
		}
		if (processAlive(manifest.supervisorPid)) {
			process.kill(manifest.supervisorPid, "SIGKILL");
		}
	}
	if (!manifest.containerName.startsWith("cex-sidecar-")) {
		throw new SidecarUsageError("Refusing to remove an unowned container");
	}
	await run("docker", ["rm", "-f", manifest.containerName], true);
	await removeSidecarEphemeralFiles(manifest);
}

async function main(): Promise<void> {
	const invocation = parseSidecarInvocation(process.argv.slice(2));
	const lifecycle = async <T>(operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof SidecarUsageError) throw error;
			throw new Error(error instanceof Error ? error.message : String(error));
		}
	};
	if (invocation.operation === "up") {
		const manifest = await lifecycle(() => up(invocation));
		console.info(manifest.manifestPath);
		return;
	}
	let manifest: SidecarManifest;
	try {
		manifest = await readManifest(invocation.manifestPath);
	} catch (error) {
		if (error instanceof SidecarUsageError) throw error;
		throw new SidecarUsageError(
			`Invalid sidecar manifest: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (resolve(manifest.manifestPath) !== resolve(invocation.manifestPath)) {
		throw new SidecarUsageError("Manifest path identity mismatch");
	}
	if (invocation.operation === "ready") {
		await lifecycle(() =>
			waitReady(manifest, invocation.timeoutMs ?? READY_TIMEOUT_MS),
		);
		console.info(
			JSON.stringify({ ready: true, manifest: manifest.manifestPath }),
		);
		return;
	}
	if (invocation.operation === "verify") {
		try {
			console.info(JSON.stringify(await verify(manifest)));
		} catch (error) {
			if (error instanceof SidecarUsageError) {
				throw new Error(error.message);
			}
			throw error;
		}
		return;
	}
	await lifecycle(() => down(manifest));
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
