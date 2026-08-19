#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
	access,
	mkdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { createClient } from "@clickhouse/client";
import {
	CHECKSUM_ALGORITHM,
	MARKET_CAPTURE_SCHEMA_VERSION,
} from "../src/helpers/market-data-archive/capture-contract";
import {
	serializeCexOrderBookCoalescingEvidence,
	validateCexOrderBookCoalescingEvidence,
} from "../src/helpers/public-market-data-feed";
import { runAndWriteCexOrderBookCoalescingProofA } from "../test/e2e/archive/support/orderbook-equivalence";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const BASELINE_SHA = "7a83de5f29a08f42d81f64a75a83bc9318dce94a";
const ARCHIVE_IMPLEMENTATION_SHA = "3398066ae2c396a9a9e0220f88715ac22b6d8694";
const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:24.8";
const MAKER_WIRE_FIXTURE_SHA256 =
	"5c9fd679a5a05ebce5f5158f4cc376360f24a34d9a07edeee43e94e564db3ee7";
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
	archiveImplementationSha: string;
	makerSha: string;
	baselineSha: string;
	artifactsDir: string;
	manifestPath: string;
	statePath: string;
	logPath: string;
	verificationPath: string;
	spoolPath: string;
	producerAccessPath: string;
	makerResultPath: string;
	referenceExportPath: string;
	cexEvidencePath: string;
	containerName: string;
	clickhouseUrl: string;
	forwarderUrl: string;
	forwarderHealthUrl: string;
	brokerUrl: string;
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
	brokerObservations?: {
		collectorSubscriptionCalls: Record<string, number>;
		totalSubscriptionCalls: Record<string, number>;
		externalSubscriptionCalls: Record<string, number>;
		physicalWorkers: Record<string, number>;
		physicalFrames: Record<string, number>;
		archiveDecisions: Record<string, number>;
		orderBookSnapshotCalls: number;
	};
	referenceExport?: Record<string, unknown>;
	error?: string;
};

export type MakerSidecarResult = {
	schemaVersion: "fiet-maker-cex-sidecar-conformance/v1";
	status: "passed";
	runId: string;
	profile: Profile;
	makerSha: string;
	candidateSha: string;
	deploymentId: string;
	source: "maker_replay" | "hb_runtime";
	producerId: string;
	producerRunId: string;
	delivery: {
		httpStatus: 200 | 202;
		acceptedRows: number;
		spoolQueuedBefore: number;
		spoolQueuedAfter: number;
	};
	tableRows: Record<(typeof STRATEGY_TABLES)[number], number>;
	profileEvidence: {
		brokerBoundaryObserved: boolean;
		[key: string]: unknown;
	};
	artifactHashes: Record<string, unknown>;
};

const MANIFEST_KEYS = new Set([
	"schemaVersion",
	"runId",
	"profile",
	"candidateSha",
	"archiveImplementationSha",
	"makerSha",
	"baselineSha",
	"artifactsDir",
	"manifestPath",
	"statePath",
	"logPath",
	"verificationPath",
	"spoolPath",
	"producerAccessPath",
	"makerResultPath",
	"referenceExportPath",
	"cexEvidencePath",
	"containerName",
	"clickhouseUrl",
	"forwarderUrl",
	"forwarderHealthUrl",
	"brokerUrl",
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
	for (const key of [
		"candidateSha",
		"archiveImplementationSha",
		"makerSha",
		"baselineSha",
	]) {
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
		"producerAccessPath",
		"makerResultPath",
		"referenceExportPath",
		"cexEvidencePath",
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
		producerAccessPath: "producer-access.json",
		makerResultPath: "maker-result.json",
		referenceExportPath: "reference-export.json",
		cexEvidencePath: "cex-orderbook-coalescing-evidence.json",
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
		record.archiveImplementationSha !== ARCHIVE_IMPLEMENTATION_SHA ||
		record.clickhouseImage !== CLICKHOUSE_IMAGE
	) {
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

const FORBIDDEN_MAKER_PROOF_B_FIELDS = new Set([
	"sharedObservation",
	"logicalDeliveries",
	"physicalWatches",
	"archiveDecisions",
	"logicalPayloadsEqual",
	"canonicalArchiveEqual",
]);

type MakerProofBundleContext = {
	artifactsDir: string;
	cexEvidencePath: string;
};

function assertNoForbiddenMakerProofFields(
	value: unknown,
	path = "Maker Proof B",
): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			assertNoForbiddenMakerProofFields(value[index], `${path}[${index}]`);
		}
		return;
	}
	for (const [key, nested] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (FORBIDDEN_MAKER_PROOF_B_FIELDS.has(key)) {
			throw new SidecarUsageError(
				`Maker Proof B contains forbidden CEX-owned field ${path}.${key}`,
			);
		}
		assertNoForbiddenMakerProofFields(nested, `${path}.${key}`);
	}
}

function hasSha256(value: unknown): boolean {
	if (typeof value === "string") return /^[0-9a-f]{64}$/.test(value);
	if (!value || typeof value !== "object") return false;
	return Object.values(value as Record<string, unknown>).some(hasSha256);
}

function validateMakerEvaluationOutput(value: unknown, label: string): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SidecarUsageError(`${label} must be an object`);
	}
	const output = value as Record<string, unknown>;
	for (const key of ["bidDepth", "askDepth", "envelopeLiquidityCap"] as const) {
		if (!Number.isFinite(output[key]) || Number(output[key]) < 0) {
			throw new SidecarUsageError(`${label}.${key} is invalid`);
		}
	}
	if (
		output.limitingSide !== "bid" &&
		output.limitingSide !== "ask" &&
		output.limitingSide !== "balanced"
	) {
		throw new SidecarUsageError(`${label}.limitingSide is invalid`);
	}
	if (
		!Number.isSafeInteger(output.selectedWidthTicks) ||
		Number(output.selectedWidthTicks) < 1 ||
		!output.authoredPosition ||
		typeof output.authoredPosition !== "object" ||
		typeof output.positionRebalanceReason !== "string" ||
		!output.positionRebalanceReason
	) {
		throw new SidecarUsageError(`${label} lacks Layer 12 policy outputs`);
	}
}

function validateMakerProofB(
	value: unknown,
	expectedCexSha256: string,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SidecarUsageError("Maker Proof B must be an object");
	}
	assertNoForbiddenMakerProofFields(value);
	const proof = value as Record<string, unknown>;
	if (
		proof.schemaVersion !== "fiet-maker-immediate-hedgeability/v2" ||
		proof.status !== "passed"
	) {
		throw new SidecarUsageError("Maker Proof B did not pass the v2 schema");
	}
	const source = proof.sourceCexEvidence as Record<string, unknown> | undefined;
	if (
		source?.schemaVersion !== "cex-orderbook-coalescing-evidence/v1" ||
		source.sha256 !== expectedCexSha256
	) {
		throw new SidecarUsageError(
			"Maker Proof B is not bound to the current CEX Proof A",
		);
	}
	if (
		typeof proof.policyConfigSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(proof.policyConfigSha256) ||
		!hasSha256(proof.artifactHashes)
	) {
		throw new SidecarUsageError(
			"Maker Proof B lacks policy or artifact hash evidence",
		);
	}
	if (!Array.isArray(proof.cases) || proof.cases.length !== 2) {
		throw new SidecarUsageError(
			"Maker Proof B must contain exactly one Binance and MEXC case",
		);
	}
	const venues = new Set<string>();
	for (const [caseIndex, caseValue] of proof.cases.entries()) {
		if (
			!caseValue ||
			typeof caseValue !== "object" ||
			Array.isArray(caseValue)
		) {
			throw new SidecarUsageError(`Maker Proof B case ${caseIndex} is invalid`);
		}
		const proofCase = caseValue as Record<string, unknown>;
		const venue = proofCase.venue;
		if (
			(venue !== "binance" && venue !== "mexc") ||
			venues.has(venue) ||
			proofCase.profileId !== `${venue}:l2-diff:500`
		) {
			throw new SidecarUsageError(
				"Maker Proof B venue/profile cases are invalid or duplicated",
			);
		}
		venues.add(venue);
		if (
			!Array.isArray(proofCase.evaluations) ||
			proofCase.evaluations.length < 1 ||
			!hasSha256(proofCase.diagnosticHashes)
		) {
			throw new SidecarUsageError(
				`Maker Proof B ${venue} case lacks evaluation/hash evidence`,
			);
		}
		const caseVerdicts = proofCase.equivalenceVerdicts as
			| Record<string, unknown>
			| undefined;
		if (
			caseVerdicts?.liveVsRehydrated !== true ||
			caseVerdicts.conservativeVsCoalesced !== true
		) {
			throw new SidecarUsageError(
				`Maker Proof B ${venue} equivalence verdict did not pass`,
			);
		}
		for (let index = 0; index < proofCase.evaluations.length; index += 1) {
			const evaluation = proofCase.evaluations[index] as
				| Record<string, unknown>
				| undefined;
			const streams = evaluation?.streams as
				| Record<string, unknown>
				| undefined;
			if (
				evaluation?.index !== index ||
				!streams ||
				Object.keys(streams).sort().join(",") !==
					[
						"conservativeLive",
						"conservativeRehydrated",
						"coalescedLive",
						"coalescedRehydrated",
					]
						.sort()
						.join(",") ||
				!hasSha256(evaluation.diagnosticHashes)
			) {
				throw new SidecarUsageError(
					`Maker Proof B ${venue} evaluation ${index} is incomplete`,
				);
			}
			const verdicts = evaluation.equivalenceVerdicts as
				| Record<string, unknown>
				| undefined;
			if (
				verdicts?.liveVsRehydrated !== true ||
				verdicts.conservativeVsCoalesced !== true
			) {
				throw new SidecarUsageError(
					`Maker Proof B ${venue} evaluation ${index} did not pass`,
				);
			}
			for (const [stream, output] of Object.entries(streams)) {
				validateMakerEvaluationOutput(
					output,
					`Maker Proof B ${venue} evaluation ${index}.${stream}`,
				);
			}
		}
	}
	if (!venues.has("binance") || !venues.has("mexc")) {
		throw new SidecarUsageError(
			"Maker Proof B must contain exactly one Binance and MEXC case",
		);
	}
	return proof;
}

async function resolveRunOwnedAttachment(
	path: string,
	artifactsDir: string,
): Promise<string> {
	const root = resolve(artifactsDir);
	const candidate = resolve(root, path);
	if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
		throw new SidecarUsageError(
			"Maker Proof B attachment path is not run-owned",
		);
	}
	const [realRoot, realCandidate] = await Promise.all([
		realpath(root),
		realpath(candidate),
	]);
	if (
		realCandidate === realRoot ||
		!realCandidate.startsWith(`${realRoot}${sep}`)
	) {
		throw new SidecarUsageError(
			"Maker Proof B attachment path is not run-owned",
		);
	}
	return realCandidate;
}

async function validateMakerProofBundle(
	descriptorValue: unknown,
	context: MakerProofBundleContext,
): Promise<{
	proofASha256: string;
	proofBSha256: string;
	proofBPath: string;
	proofA: Record<string, unknown>;
	proofB: Record<string, unknown>;
}> {
	if (
		!descriptorValue ||
		typeof descriptorValue !== "object" ||
		Array.isArray(descriptorValue)
	) {
		throw new SidecarUsageError(
			"Maker Proof B attachment descriptor is absent",
		);
	}
	const descriptor = descriptorValue as Record<string, unknown>;
	if (
		Object.keys(descriptor).sort().join(",") !==
			["schemaVersion", "path", "sha256"].sort().join(",") ||
		descriptor.schemaVersion !==
			"fiet-maker-immediate-hedgeability-attachment/v1" ||
		typeof descriptor.path !== "string" ||
		typeof descriptor.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(descriptor.sha256)
	) {
		throw new SidecarUsageError(
			"Maker Proof B attachment descriptor is invalid",
		);
	}
	const proofBPath = await resolveRunOwnedAttachment(
		descriptor.path,
		context.artifactsDir,
	);
	const proofBBytes = await readFile(proofBPath);
	const proofBSha256 = createHash("sha256").update(proofBBytes).digest("hex");
	if (proofBSha256 !== descriptor.sha256) {
		throw new SidecarUsageError("Maker Proof B attachment SHA-256 is invalid");
	}
	const cexBytes = await readFile(context.cexEvidencePath);
	const cexEvidence = validateCexOrderBookCoalescingEvidence(
		JSON.parse(cexBytes.toString("utf8")),
	);
	if (
		!Buffer.from(serializeCexOrderBookCoalescingEvidence(cexEvidence)).equals(
			cexBytes,
		)
	) {
		throw new SidecarUsageError("Current CEX Proof A bytes are not canonical");
	}
	const proofASha256 = createHash("sha256").update(cexBytes).digest("hex");
	const proofB = validateMakerProofB(
		JSON.parse(proofBBytes.toString("utf8")),
		proofASha256,
	);
	return {
		proofASha256,
		proofBSha256,
		proofBPath,
		proofA: cexEvidence as unknown as Record<string, unknown>,
		proofB,
	};
}

export async function validateMakerSidecarResult(
	value: unknown,
	context?: MakerProofBundleContext,
): Promise<MakerSidecarResult> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SidecarUsageError("Maker result must be an object");
	}
	assertNoSecrets(value, "makerResult");
	const result = value as Record<string, unknown>;
	const keys = Object.keys(result).sort();
	const expectedKeys = [
		"artifactHashes",
		"candidateSha",
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
		"status",
		"tableRows",
	].sort();
	if (keys.join(",") !== expectedKeys.join(",")) {
		throw new SidecarUsageError(
			"Maker result uses an unknown or incomplete field set",
		);
	}
	if (
		result.schemaVersion !== "fiet-maker-cex-sidecar-conformance/v1" ||
		result.status !== "passed"
	) {
		throw new SidecarUsageError(
			"Maker result did not pass the supported schema",
		);
	}
	const profile = requiredString(result, "profile") as Profile;
	if (profile !== "native_replay" && profile !== "production_compatible") {
		throw new SidecarUsageError("Maker result profile is unsupported");
	}
	for (const key of ["makerSha", "candidateSha"]) {
		if (!validSha(requiredString(result, key))) {
			throw new SidecarUsageError(`Maker result ${key} is invalid`);
		}
	}
	const runId = requiredString(result, "runId");
	const deploymentId = requiredString(result, "deploymentId");
	const source = requiredString(result, "source");
	const expectedSource =
		profile === "native_replay" ? "maker_replay" : "hb_runtime";
	const producerId = requiredString(result, "producerId");
	if (
		source !== expectedSource ||
		result.producerRunId !== runId ||
		producerId !== `${expectedSource}:${deploymentId}:cex-sidecar-conformance`
	) {
		throw new SidecarUsageError(
			"Maker result provenance is not the exact external producer",
		);
	}
	const delivery = result.delivery as Record<string, unknown> | undefined;
	const expectedStatus = profile === "native_replay" ? 200 : 202;
	if (
		!delivery ||
		delivery.httpStatus !== expectedStatus ||
		!Number.isSafeInteger(delivery.acceptedRows) ||
		Number(delivery.acceptedRows) < STRATEGY_TABLES.length ||
		!Number.isSafeInteger(delivery.spoolQueuedBefore) ||
		!Number.isSafeInteger(delivery.spoolQueuedAfter)
	) {
		throw new SidecarUsageError("Maker result delivery evidence is invalid");
	}
	if (
		profile === "native_replay" &&
		delivery.spoolQueuedBefore !== delivery.spoolQueuedAfter
	) {
		throw new SidecarUsageError("Native replay must not use the durable spool");
	}
	if (profile === "production_compatible" && delivery.spoolQueuedAfter !== 0) {
		throw new SidecarUsageError(
			"Production-compatible Maker result does not prove spool drainage",
		);
	}
	const tableRows = result.tableRows as Record<string, unknown> | undefined;
	if (
		!tableRows ||
		Object.keys(tableRows).sort().join(",") !==
			[...STRATEGY_TABLES].sort().join(",") ||
		STRATEGY_TABLES.some(
			(table) =>
				!Number.isSafeInteger(tableRows[table]) || Number(tableRows[table]) < 1,
		)
	) {
		throw new SidecarUsageError(
			"Maker result must account for all five strategy tables",
		);
	}
	const profileEvidence = result.profileEvidence as
		| Record<string, unknown>
		| undefined;
	if (
		!profileEvidence ||
		profileEvidence.brokerBoundaryObserved !==
			(profile === "production_compatible")
	) {
		throw new SidecarUsageError(
			"Maker result broker-boundary claim conflicts with profile",
		);
	}
	if (profile === "production_compatible") {
		const brokerObservation = profileEvidence.brokerObservation as
			| Record<string, unknown>
			| undefined;
		if (
			brokerObservation?.schemaVersion !==
				"fiet-hummingbot-external-sidecar-broker/v1" ||
			brokerObservation.status !== "passed" ||
			brokerObservation.boundary !== "external_sidecar_broker" ||
			brokerObservation.layer12Boundary !== "layer12_live_reference_depth"
		) {
			throw new SidecarUsageError(
				"Production-compatible evidence lacks the real Layer12 broker path",
			);
		}
		if (!context) {
			throw new SidecarUsageError(
				"Production-compatible verification requires current CEX Proof A context",
			);
		}
		await validateMakerProofBundle(
			profileEvidence.immediateHedgeability,
			context,
		);
	} else {
		const consumer = profileEvidence.consumer as
			| Record<string, unknown>
			| undefined;
		if (
			consumer?.path !==
				"hb_maker_emulation.order_book_depth_sourcing.load_precomputed_order_book" ||
			consumer.sourceMode !== "vendor_archive_normalized" ||
			!Number.isSafeInteger(consumer.levelRows) ||
			Number(consumer.levelRows) < 1 ||
			!Number.isSafeInteger(consumer.summaryRows) ||
			Number(consumer.summaryRows) < 1
		) {
			throw new SidecarUsageError(
				"Native replay evidence lacks the Maker emulation fixture consumer",
			);
		}
	}
	const makerCheckout = profileEvidence.makerCheckout as
		| Record<string, unknown>
		| undefined;
	const wireContractTests = makerCheckout?.wireContractTests as
		| Record<string, unknown>
		| undefined;
	if (
		makerCheckout?.branch !== "develop" ||
		makerCheckout.clean !== true ||
		makerCheckout.sha !== result.makerSha ||
		makerCheckout.originDevelopSha !== result.makerSha ||
		makerCheckout.pr1067Ancestor !== true ||
		makerCheckout.fixtureSha256 !== MAKER_WIRE_FIXTURE_SHA256 ||
		!wireContractTests ||
		wireContractTests.exitCode !== 0
	) {
		throw new SidecarUsageError(
			"Maker result lacks refreshed develop and PR 1067 contract evidence",
		);
	}
	if (!result.artifactHashes || typeof result.artifactHashes !== "object") {
		throw new SidecarUsageError("Maker result artifact hashes are absent");
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

async function assertArchiveImplementationAncestor(): Promise<void> {
	const result = await run(
		"git",
		["merge-base", "--is-ancestor", ARCHIVE_IMPLEMENTATION_SHA, "HEAD"],
		true,
	);
	if (result.code !== 0) {
		throw new SidecarUsageError(
			"checked-out CEX candidate does not contain the reviewed archive implementation",
		);
	}
}

async function up(invocation: UpInvocation): Promise<SidecarManifest> {
	await assertCleanCandidate();
	await assertArchiveImplementationAncestor();
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
	const cexEvidencePath = join(
		artifactsDir,
		"cex-orderbook-coalescing-evidence.json",
	);
	await runAndWriteCexOrderBookCoalescingProofA(cexEvidencePath);
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
			archiveImplementationSha: ARCHIVE_IMPLEMENTATION_SHA,
			makerSha: invocation.makerSha,
			baselineSha: BASELINE_SHA,
			artifactsDir,
			manifestPath,
			statePath: join(artifactsDir, "state.json"),
			logPath,
			verificationPath: join(artifactsDir, "verification.json"),
			spoolPath: ephemeralPaths.spoolPath,
			producerAccessPath: ephemeralPaths.producerAccessPath,
			makerResultPath: join(artifactsDir, "maker-result.json"),
			referenceExportPath: join(artifactsDir, "reference-export.json"),
			cexEvidencePath,
			containerName,
			clickhouseUrl: `http://127.0.0.1:${port}`,
			forwarderUrl: `http://127.0.0.1:${forwarderPort}/archive`,
			forwarderHealthUrl: `http://127.0.0.1:${forwarderPort}/health`,
			brokerUrl: `127.0.0.1:${brokerPort}`,
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
		await writeFile(
			manifest.producerAccessPath,
			`${JSON.stringify(
				{
					schemaVersion: "cex-archive-sidecar-producer-access/v1",
					forwarderUrl: manifest.forwarderUrl,
					brokerUrl: manifest.brokerUrl,
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
		if (containerStarted)
			await run("docker", ["rm", "-f", containerName], true);
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

async function sha256File(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function verify(
	manifest: SidecarManifest,
): Promise<Record<string, unknown>> {
	let state = await waitReady(manifest, READY_TIMEOUT_MS);
	const client = createClient({
		url: manifest.clickhouseUrl,
		username: "default",
		password: internalSecret(manifest.runId),
	});
	let result: Record<string, unknown>;
	try {
		const makerResultValue = JSON.parse(
			await readFile(manifest.makerResultPath, "utf8"),
		) as Record<string, unknown>;
		const proofBundle =
			manifest.profile === "production_compatible"
				? await validateMakerProofBundle(
						(
							makerResultValue.profileEvidence as
								| Record<string, unknown>
								| undefined
						)?.immediateHedgeability,
						{
							artifactsDir: manifest.artifactsDir,
							cexEvidencePath: manifest.cexEvidencePath,
						},
					)
				: undefined;
		const makerResult = await validateMakerSidecarResult(makerResultValue, {
			artifactsDir: manifest.artifactsDir,
			cexEvidencePath: manifest.cexEvidencePath,
		});
		if (
			makerResult.runId !== manifest.runId ||
			makerResult.profile !== manifest.profile ||
			makerResult.makerSha !== manifest.makerSha ||
			makerResult.candidateSha !== manifest.candidateSha ||
			makerResult.deploymentId !== manifest.deploymentId
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
				`deployment_id = '${manifest.deploymentId}' AND capture_bundle_id = '${manifest.captureBundleId}'`,
			);
			if (marketCounts[table] === 0)
				throw new Error(`Missing sidecar market rows in ${table}`);
		}
		const expectedSource =
			manifest.profile === "native_replay" ? "maker_replay" : "hb_runtime";
		const expectedProducerId = `${expectedSource}:${manifest.deploymentId}:cex-sidecar-conformance`;
		const strategyCounts: Record<string, number> = {};
		for (const table of STRATEGY_TABLES) {
			strategyCounts[table] = await queryCount(
				client,
				table,
				`deployment_id = '${manifest.deploymentId}' AND source = '${expectedSource}' AND schema_version = '2' AND producer_id = '${expectedProducerId}' AND producer_run_id = '${manifest.runId}' AND stream_seq > 0 AND seq > 0`,
			);
			if (strategyCounts[table] === 0)
				throw new Error(`Missing v2 ${expectedSource} rows in ${table}`);
		}
		if (manifest.profile === "production_compatible") {
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				state = await readState(manifest);
				if (
					Number(
						state.brokerObservations?.externalSubscriptionCalls.ORDERBOOK ?? 0,
					) >= 1 &&
					Number(state.brokerObservations?.orderBookSnapshotCalls ?? 0) >= 1 &&
					Number(state.brokerObservations?.archiveDecisions.ORDERBOOK ?? 0) >= 1
				) {
					break;
				}
				await Bun.sleep(100);
			}
			if (
				Number(
					state.brokerObservations?.externalSubscriptionCalls.ORDERBOOK ?? 0,
				) < 1 ||
				Number(state.brokerObservations?.orderBookSnapshotCalls ?? 0) < 1 ||
				Number(
					state.brokerObservations?.totalSubscriptionCalls.ORDERBOOK ?? 0,
				) < 2 ||
				Number(state.brokerObservations?.physicalWorkers.ORDERBOOK ?? 0) !==
					1 ||
				Number(state.brokerObservations?.physicalFrames.ORDERBOOK ?? 0) !==
					Number(state.brokerObservations?.archiveDecisions.ORDERBOOK ?? -1)
			) {
				throw new Error(
					"Production-compatible Maker Layer12 shared-feed observations were not recorded",
				);
			}
		}
		const exportArtifacts: Record<string, unknown> = {};
		if (manifest.profile === "native_replay") {
			const referenceExport = JSON.parse(
				await readFile(manifest.referenceExportPath, "utf8"),
			) as Record<string, unknown>;
			if (
				referenceExport.schemaVersion !== "cex-canonical-orderbook-export/v1" ||
				referenceExport.runId !== manifest.runId
			) {
				throw new Error("Native reference export identity is invalid");
			}
			for (const label of ["levels", "summary"] as const) {
				const artifact = referenceExport[label] as
					| Record<string, unknown>
					| undefined;
				if (
					!artifact ||
					typeof artifact.path !== "string" ||
					Number(artifact.rows) < 1 ||
					artifact.sha256 !== (await sha256File(artifact.path))
				) {
					throw new Error(`Native reference export ${label} is invalid`);
				}
			}
			Object.assign(exportArtifacts, referenceExport);
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
			makerResult: {
				path: manifest.makerResultPath,
				sha256: await sha256File(manifest.makerResultPath),
			},
			...(proofBundle
				? {
						cexProofA: {
							path: manifest.cexEvidencePath,
							sha256: proofBundle.proofASha256,
						},
						makerProofB: {
							path: proofBundle.proofBPath,
							sha256: proofBundle.proofBSha256,
						},
					}
				: {}),
		};
		const proofC =
			manifest.profile === "production_compatible"
				? {
						schemaVersion: "cex-maker-sidecar-proof-c/v1",
						status: "passed",
						venue: "binance",
						profileId: "binance:l2-diff:500",
						logicalSubscriptions: {
							collector: Number(
								state.brokerObservations?.collectorSubscriptionCalls
									.ORDERBOOK ?? 0,
							),
							maker: Number(
								state.brokerObservations?.externalSubscriptionCalls.ORDERBOOK ??
									0,
							),
							total: Number(
								state.brokerObservations?.totalSubscriptionCalls.ORDERBOOK ?? 0,
							),
						},
						physical: {
							workers: Number(
								state.brokerObservations?.physicalWorkers.ORDERBOOK ?? 0,
							),
							frames: Number(
								state.brokerObservations?.physicalFrames.ORDERBOOK ?? 0,
							),
							archiveDecisions: Number(
								state.brokerObservations?.archiveDecisions.ORDERBOOK ?? 0,
							),
						},
						durableDelivery: {
							httpStatus: makerResult.delivery.httpStatus,
							spoolQueuedAfter: makerResult.delivery.spoolQueuedAfter,
							marketCounts,
							strategyCounts,
						},
					}
				: undefined;
		result = {
			schemaVersion: "cex-archive-sidecar-verification/v1",
			status: "passed",
			runId: manifest.runId,
			profile: manifest.profile,
			commits: {
				baseline: manifest.baselineSha,
				candidate: manifest.candidateSha,
				archiveImplementation: manifest.archiveImplementationSha,
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
				makerResult,
				brokerObservations: state.brokerObservations,
				exportArtifacts,
				...(proofBundle && proofC
					? {
							proofs: {
								proofA: {
									schemaVersion: proofBundle.proofA.schemaVersion,
									sha256: proofBundle.proofASha256,
									status: "passed",
								},
								proofB: {
									schemaVersion: proofBundle.proofB.schemaVersion,
									sha256: proofBundle.proofBSha256,
									status: "passed",
								},
								proofC,
							},
						}
					: {}),
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
				archiveImplementation: manifest.archiveImplementationSha,
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
		while (processAlive(manifest.supervisorPid) && Date.now() < deadline)
			await Bun.sleep(100);
		if (processAlive(manifest.supervisorPid))
			process.kill(manifest.supervisorPid, "SIGKILL");
	}
	if (!manifest.containerName.startsWith("cex-sidecar-"))
		throw new SidecarUsageError("Refusing to remove an unowned container");
	await run("docker", ["rm", "-f", manifest.containerName], true);
	await removeSidecarEphemeralFiles(manifest);
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
