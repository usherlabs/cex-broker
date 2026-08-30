import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	BACKFILL_RESULT_V2_SCHEMA_ID,
	type BackfillJobResultV2Wire,
	backfillResultV2Codec,
	finalizeBackfillResultV2,
	PREPARATION_SCHEMA_MANIFEST_V2,
	type PreparationProducerIdentity,
} from "../helpers/market-data-preparation/contracts";
import {
	type AtomicWriteHooks,
	assertSafeFileJobPaths,
	assertSidecarBasename,
	assertSupportedNode22,
	atomicWriteJsonResult,
	containsParentTraversal,
	FILE_JOB_CLOCK_MAX_BYTES,
	FILE_JOB_REQUEST_MAX_BYTES,
	FileJobUnreadableError,
	parseFileJobArgv,
	readBoundedRegularFile,
	redactDiagnostics,
	sha256RegularFile,
} from "../helpers/market-data-preparation/file-job";
import {
	createClickHouseArchiveQueryClient,
	QualifiedOrderBookArchiveReader,
} from "../helpers/market-data-vendor-backfill/archive-reader";
import {
	decodeBackfillRunDocuments,
	requiredClockCodec,
} from "../helpers/market-data-vendor-backfill/contracts";
import {
	type BackfillDependencies,
	type BackfillDomainOutcome,
	runMarketDataVendorBackfill,
} from "../helpers/market-data-vendor-backfill/core";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	CryptoHftDataAdapter,
} from "../helpers/market-data-vendor-backfill/cryptohftdata";
import { createArchiveForwarderClient } from "../helpers/market-data-vendor-backfill/forwarder-client";
import {
	CAPABILITY_POLICY,
	RESOURCE_POLICY,
} from "../helpers/market-data-vendor-backfill/manifests";

declare const __CEX_BROKER_PACKAGE_VERSION__: string;
declare const __CEX_BROKER_GIT_HEAD__: string;

type Environment = Readonly<Record<string, string | undefined>>;

export type BackfillReleaseIdentity = {
	packageVersion: string;
	gitHead: string;
};

export type BackfillFileJobOptions = {
	requestPath: string;
	resultPath: string;
	executablePath?: string;
	release?: BackfillReleaseIdentity;
	dependencies?: BackfillDependencies;
	createDependencies?: (sensitiveValues: Set<string>) => BackfillDependencies;
	environment?: Environment;
	nowMs?: () => number;
	randomUuid?: () => string;
	atomicWriteHooks?: AtomicWriteHooks;
};

const SAFE_GIT_HEAD = /^[0-9a-f]{40}$/;
const SAFE_PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function validateReleaseIdentity(
	release: BackfillReleaseIdentity,
): BackfillReleaseIdentity {
	if (!SAFE_PACKAGE_VERSION.test(release.packageVersion)) {
		throw new Error("pin-eligible build is missing a valid package version");
	}
	if (!SAFE_GIT_HEAD.test(release.gitHead)) {
		throw new Error(
			"pin-eligible build is missing a valid cex-broker git head",
		);
	}
	return release;
}

function bakedReleaseIdentity(): BackfillReleaseIdentity {
	const packageVersion =
		typeof __CEX_BROKER_PACKAGE_VERSION__ === "string"
			? __CEX_BROKER_PACKAGE_VERSION__
			: "";
	const gitHead =
		typeof __CEX_BROKER_GIT_HEAD__ === "string" ? __CEX_BROKER_GIT_HEAD__ : "";
	return validateReleaseIdentity({ packageVersion, gitHead });
}

function readOptionalEnvironment(
	environment: Environment,
	name: string,
): string | undefined {
	const value = environment[name];
	return value && value.trim().length > 0 ? value : undefined;
}

export function createBackfillDependenciesFromEnv(
	environment: Environment,
	sensitiveValues: Set<string> = new Set(),
): BackfillDependencies {
	const clickhouseUrl =
		readOptionalEnvironment(environment, "CLICKHOUSE_URL") ?? "";
	const clickhouseUser = readOptionalEnvironment(
		environment,
		"CLICKHOUSE_USER",
	);
	const clickhousePassword = readOptionalEnvironment(
		environment,
		"CLICKHOUSE_PASSWORD",
	);
	const forwarderUrl =
		readOptionalEnvironment(environment, "CEX_BROKER_ARCHIVE_FORWARDER_URL") ??
		"";
	const forwarderToken = readOptionalEnvironment(
		environment,
		"CEX_BROKER_ARCHIVE_FORWARDER_TOKEN",
	);
	if (clickhousePassword) sensitiveValues.add(clickhousePassword);
	if (forwarderToken) sensitiveValues.add(forwarderToken);

	return {
		archive: new QualifiedOrderBookArchiveReader(
			createClickHouseArchiveQueryClient({
				url: clickhouseUrl,
				username: clickhouseUser,
				password: clickhousePassword,
			}),
		),
		providers: new CryptoHftDataAdapter({
			profiles: [
				CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
				CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
			],
		}),
		forwarder: createArchiveForwarderClient({
			url: forwarderUrl,
			authToken: forwarderToken,
		}),
		credentials: {
			async resolve(provider) {
				if (provider !== "cryptohftdata") return;
				const apiKey = readOptionalEnvironment(
					environment,
					"CRYPTOHFTDATA_API_KEY",
				);
				if (!apiKey) return;
				sensitiveValues.add(apiKey);
				return { apiKey };
			},
		},
		clock: { nowMs: Date.now },
	};
}

function requiredClockReferenceFromJson(request: unknown): {
	clockId: string;
	clockSha256: string;
	eventCount: number;
	fileName: string;
} {
	if (!request || typeof request !== "object" || Array.isArray(request)) {
		throw new Error("request document must be an object");
	}
	const reference = (request as Record<string, unknown>).required_clock;
	if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
		throw new Error("request required clock reference must be an object");
	}
	const fields = reference as Record<string, unknown>;
	if (
		typeof fields.clock_id !== "string" ||
		typeof fields.clock_sha256 !== "string" ||
		typeof fields.file_name !== "string" ||
		!Number.isSafeInteger(fields.event_count) ||
		Number(fields.event_count) < 0
	) {
		throw new Error("request required clock reference is invalid");
	}
	assertSidecarBasename(fields.file_name);
	return {
		clockId: fields.clock_id,
		clockSha256: fields.clock_sha256,
		eventCount: Number(fields.event_count),
		fileName: fields.file_name,
	};
}

function requestInvalidOutcome(reasonSubcode?: string): BackfillDomainOutcome {
	return {
		status: "request_invalid",
		reasonCode: "request_invalid",
		...(reasonSubcode ? { reasonSubcode } : {}),
	};
}

function outcomeToWire(
	outcome: BackfillDomainOutcome,
	sensitiveValues: ReadonlySet<string>,
): BackfillJobResultV2Wire["outcome"] {
	return {
		status: outcome.status,
		reason_code: outcome.reasonCode,
		reason_subcode: outcome.reasonSubcode ?? null,
		request_id: outcome.requestId ?? null,
		idempotency_key: outcome.idempotencyKey ?? null,
		target: outcome.target ?? null,
		selection: outcome.selection ?? null,
		receipt: outcome.receipt ?? null,
		diagnostics: redactDiagnostics(outcome.diagnostics ?? {}, sensitiveValues),
	};
}

function producerIdentity(input: {
	release: BackfillReleaseIdentity;
	executableSha256: string;
}): BackfillJobResultV2Wire["producer"] {
	return {
		product_id: "market-data-vendor-backfill",
		product_version: "market-data-vendor-backfill/v1",
		package: {
			name: "@usherlabs/cex-broker",
			version: input.release.packageVersion,
			git_head: input.release.gitHead,
		},
		executable_sha256: input.executableSha256,
		runtime: { name: "node", version: process.versions.node },
	};
}

async function writeOutcome(input: {
	resultPath: string;
	outcome: BackfillDomainOutcome;
	requestFileSha256: string | null;
	producer: PreparationProducerIdentity & {
		product_id: "market-data-vendor-backfill";
		product_version: "market-data-vendor-backfill/v1";
	};
	jobId: string;
	startedAt: string;
	completedAt: string;
	sensitiveValues: ReadonlySet<string>;
	hooks?: AtomicWriteHooks;
}): Promise<BackfillJobResultV2Wire> {
	const result = finalizeBackfillResultV2({
		schema_id: BACKFILL_RESULT_V2_SCHEMA_ID,
		job_id: input.jobId,
		request_file_sha256: input.requestFileSha256,
		schema_manifest_sha256: PREPARATION_SCHEMA_MANIFEST_V2.manifest_sha256,
		producer: input.producer,
		capability_policy: {
			policy_id: CAPABILITY_POLICY.policy_id,
			policy_sha256: CAPABILITY_POLICY.policy_sha256,
		},
		resource_policy: {
			policy_id: RESOURCE_POLICY.policy_id,
			policy_sha256: RESOURCE_POLICY.policy_sha256,
		},
		started_at: input.startedAt,
		completed_at: input.completedAt,
		outcome: outcomeToWire(input.outcome, input.sensitiveValues),
	});
	await atomicWriteJsonResult(input.resultPath, result, {
		validate: (value) => {
			backfillResultV2Codec.decode(value);
		},
		hooks: input.hooks,
	});
	return result;
}

export async function runMarketDataVendorBackfillFileJob(
	options: BackfillFileJobOptions,
): Promise<BackfillJobResultV2Wire> {
	assertSupportedNode22(process.versions.node, "market-data-vendor-backfill");
	const release = validateReleaseIdentity(
		options.release ?? bakedReleaseIdentity(),
	);
	const nowMs = options.nowMs ?? Date.now;
	const startedAt = new Date(nowMs()).toISOString();
	const jobId = (options.randomUuid ?? randomUUID)();
	const executablePath = options.executablePath
		? path.resolve(options.executablePath)
		: process.argv[1]
			? path.resolve(process.argv[1])
			: "";
	if (!executablePath)
		throw new Error("running executable path is unavailable");
	const executableSha256 = await sha256RegularFile(executablePath);
	const producer = producerIdentity({ release, executableSha256 });

	const resolvedRequestPath = path.resolve(options.requestPath);
	const resolvedResultPath = path.resolve(options.resultPath);
	const paths = await assertSafeFileJobPaths(
		resolvedRequestPath,
		resolvedResultPath,
	);
	const sensitiveValues = new Set<string>();
	const commonWrite = {
		resultPath: paths.resultPath,
		producer,
		jobId,
		startedAt,
		sensitiveValues,
		hooks: options.atomicWriteHooks,
	};

	if (
		containsParentTraversal(options.requestPath) ||
		containsParentTraversal(options.resultPath)
	) {
		return writeOutcome({
			...commonWrite,
			outcome: requestInvalidOutcome("request_file_unreadable"),
			requestFileSha256: null,
			completedAt: new Date(nowMs()).toISOString(),
		});
	}

	let requestBytes: Buffer;
	try {
		requestBytes = await readBoundedRegularFile(
			paths.requestPath,
			FILE_JOB_REQUEST_MAX_BYTES,
		);
	} catch (error) {
		if (!(error instanceof FileJobUnreadableError)) throw error;
		return writeOutcome({
			...commonWrite,
			outcome: requestInvalidOutcome("request_file_unreadable"),
			requestFileSha256: null,
			completedAt: new Date(nowMs()).toISOString(),
		});
	}
	const requestFileSha256 = createHash("sha256")
		.update(requestBytes)
		.digest("hex");

	let requestDocument: unknown;
	try {
		requestDocument = JSON.parse(requestBytes.toString("utf8"));
	} catch {
		return writeOutcome({
			...commonWrite,
			outcome: requestInvalidOutcome(),
			requestFileSha256,
			completedAt: new Date(nowMs()).toISOString(),
		});
	}

	let requiredClock: unknown;
	try {
		const reference = requiredClockReferenceFromJson(requestDocument);
		const clockBytes = await readBoundedRegularFile(
			path.join(paths.attemptRoot, reference.fileName),
			FILE_JOB_CLOCK_MAX_BYTES,
		);
		requiredClock = JSON.parse(clockBytes.toString("utf8"));
		const decodedClock = requiredClockCodec.decode(requiredClock);
		if (
			decodedClock.clock_id !== reference.clockId ||
			decodedClock.clock_sha256 !== reference.clockSha256 ||
			decodedClock.targets.length !== reference.eventCount
		) {
			throw new Error(
				"required clock sidecar does not match request reference",
			);
		}
		decodeBackfillRunDocuments({
			request: requestDocument,
			requiredClock,
		});
	} catch {
		return writeOutcome({
			...commonWrite,
			outcome: requestInvalidOutcome(),
			requestFileSha256,
			completedAt: new Date(nowMs()).toISOString(),
		});
	}

	const dependencies =
		options.dependencies ??
		options.createDependencies?.(sensitiveValues) ??
		createBackfillDependenciesFromEnv(
			options.environment ?? process.env,
			sensitiveValues,
		);
	const outcome = await runMarketDataVendorBackfill(
		{ request: requestDocument, requiredClock },
		dependencies,
	);
	return writeOutcome({
		...commonWrite,
		outcome,
		requestFileSha256,
		completedAt: new Date(nowMs()).toISOString(),
	});
}

export async function runMarketDataVendorBackfillCli(
	argv: readonly string[],
	options: Omit<BackfillFileJobOptions, "requestPath" | "resultPath"> = {},
): Promise<number> {
	assertSupportedNode22(process.versions.node, "market-data-vendor-backfill");
	const paths = parseFileJobArgv(argv);
	await runMarketDataVendorBackfillFileJob({ ...options, ...paths });
	return 0;
}

const invokedUrl = process.argv[1]
	? pathToFileURL(path.resolve(process.argv[1])).href
	: null;
if (invokedUrl === import.meta.url) {
	runMarketDataVendorBackfillCli(process.argv.slice(2)).then(
		(exitCode) => {
			process.exitCode = exitCode;
		},
		() => {
			console.error("market-data-vendor-backfill failed");
			process.exitCode = 1;
		},
	);
}
