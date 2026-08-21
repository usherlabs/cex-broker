import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ExactOrderBookExportError } from "../helpers/canonical-orderbook-export/exact-selection";
import {
	createClickHouseExactOrderBookExportClient,
	type ExactOrderBookExportQueryClient,
	exportExactCanonicalOrderBook,
} from "../helpers/canonical-orderbook-export/exporter";
import {
	CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
	type CanonicalOrderBookExportQuerySegment,
	type CanonicalOrderBookExportRequestWire,
	type CanonicalOrderBookExportResultWire,
	type CanonicalOrderBookExportStatus,
	canonicalOrderBookExportRequestCodec,
	canonicalOrderBookExportResultCodec,
	finalizeCanonicalOrderBookExportResult,
} from "../helpers/market-data-preparation/contracts";
import {
	type AtomicWriteHooks,
	assertSafeFileJobPaths,
	assertSupportedNode22,
	atomicWriteJsonResult,
	containsParentTraversal,
	FILE_JOB_REQUEST_MAX_BYTES,
	FileJobUnreadableError,
	parseFileJobArgv,
	readBoundedRegularFile,
	sha256RegularFile,
} from "../helpers/market-data-preparation/file-job";

declare const __CEX_BROKER_PACKAGE_VERSION__: string;
declare const __CEX_BROKER_GIT_HEAD__: string;

type Environment = Readonly<Record<string, string | undefined>>;

export type CanonicalOrderBookExportReleaseIdentity = {
	packageVersion: string;
	gitHead: string;
};

export type CanonicalOrderBookExportFileJobOptions = {
	requestPath: string;
	resultPath: string;
	executablePath?: string;
	release?: CanonicalOrderBookExportReleaseIdentity;
	client?: ExactOrderBookExportQueryClient;
	environment?: Environment;
	nowMs?: () => number;
	randomUuid?: () => string;
	atomicWriteHooks?: AtomicWriteHooks;
};

const SAFE_GIT_HEAD = /^[0-9a-f]{40}$/;
const SAFE_PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function validateReleaseIdentity(
	release: CanonicalOrderBookExportReleaseIdentity,
): CanonicalOrderBookExportReleaseIdentity {
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

function bakedReleaseIdentity(): CanonicalOrderBookExportReleaseIdentity {
	return validateReleaseIdentity({
		packageVersion:
			typeof __CEX_BROKER_PACKAGE_VERSION__ === "string"
				? __CEX_BROKER_PACKAGE_VERSION__
				: "",
		gitHead:
			typeof __CEX_BROKER_GIT_HEAD__ === "string"
				? __CEX_BROKER_GIT_HEAD__
				: "",
	});
}

function optionalEnvironment(
	environment: Environment,
	name: string,
): string | undefined {
	const value = environment[name];
	return value && value.trim().length > 0 ? value : undefined;
}

export function createCanonicalOrderBookExportClientFromEnv(
	environment: Environment,
): ExactOrderBookExportQueryClient {
	return createClickHouseExactOrderBookExportClient({
		url: optionalEnvironment(environment, "CLICKHOUSE_URL") ?? "",
		username: optionalEnvironment(environment, "CLICKHOUSE_USER"),
		password: optionalEnvironment(environment, "CLICKHOUSE_PASSWORD"),
	});
}

function classifyExportFailure(reason: string): CanonicalOrderBookExportStatus {
	if (
		reason === "archive_url_invalid" ||
		reason === "archive_query_failed" ||
		reason === "archive_query_unreachable" ||
		reason.startsWith("archive_query_http_")
	) {
		return "archive_query_failed";
	}
	return reason === "artifact_write_failed"
		? "artifact_write_failed"
		: "archive_data_invalid";
}

async function writeResult(input: {
	resultPath: string;
	requestFileSha256: string | null;
	request: CanonicalOrderBookExportRequestWire | null;
	status: CanonicalOrderBookExportStatus;
	reasonCode: string;
	reasonSubcode: string | null;
	querySha256?: string;
	querySegments?: CanonicalOrderBookExportQuerySegment[];
	promotionReceiptIds?: string[];
	artifacts?: CanonicalOrderBookExportResultWire["outcome"]["artifacts"];
	producer: CanonicalOrderBookExportResultWire["producer"];
	jobId: string;
	startedAt: string;
	completedAt: string;
	hooks?: AtomicWriteHooks;
}): Promise<CanonicalOrderBookExportResultWire> {
	const result = finalizeCanonicalOrderBookExportResult({
		schema_id: CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
		job_id: input.jobId,
		request_file_sha256: input.requestFileSha256,
		producer: input.producer,
		started_at: input.startedAt,
		completed_at: input.completedAt,
		outcome: {
			status: input.status,
			reason_code: input.reasonCode,
			reason_subcode: input.reasonSubcode,
			request_id: input.request?.request_id ?? null,
			target: input.request?.target ?? null,
			selection_sha256: input.request?.selection.selection_sha256 ?? null,
			query_sha256: input.querySha256 ?? null,
			query_segments: input.querySegments ?? [],
			promotion_receipt_ids: input.promotionReceiptIds ?? [],
			artifacts: input.artifacts ?? null,
			diagnostics: {},
		},
	});
	await atomicWriteJsonResult(input.resultPath, result, {
		validate: (value) => {
			canonicalOrderBookExportResultCodec.decode(value);
		},
		hooks: input.hooks,
	});
	return result;
}

export async function runCanonicalOrderBookExportFileJob(
	options: CanonicalOrderBookExportFileJobOptions,
): Promise<CanonicalOrderBookExportResultWire> {
	assertSupportedNode22(
		process.versions.node,
		"cex-canonical-orderbook-export",
	);
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
	const producer: CanonicalOrderBookExportResultWire["producer"] = {
		product_id: "cex-canonical-orderbook-export",
		product_version: "cex-canonical-orderbook-export/v1",
		package: {
			name: "@usherlabs/cex-broker",
			version: release.packageVersion,
			git_head: release.gitHead,
		},
		executable_sha256: executableSha256,
		runtime: { name: "node", version: process.versions.node },
	};

	const paths = await assertSafeFileJobPaths(
		path.resolve(options.requestPath),
		path.resolve(options.resultPath),
	);
	const common = {
		resultPath: paths.resultPath,
		producer,
		jobId,
		startedAt,
		hooks: options.atomicWriteHooks,
	};
	if (
		containsParentTraversal(options.requestPath) ||
		containsParentTraversal(options.resultPath)
	) {
		return writeResult({
			...common,
			requestFileSha256: null,
			request: null,
			status: "request_invalid",
			reasonCode: "request_invalid",
			reasonSubcode: "request_file_unreadable",
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
		return writeResult({
			...common,
			requestFileSha256: null,
			request: null,
			status: "request_invalid",
			reasonCode: "request_invalid",
			reasonSubcode: "request_file_unreadable",
			completedAt: new Date(nowMs()).toISOString(),
		});
	}
	const requestFileSha256 = createHash("sha256")
		.update(requestBytes)
		.digest("hex");
	let request: CanonicalOrderBookExportRequestWire;
	try {
		request = canonicalOrderBookExportRequestCodec.decode(
			JSON.parse(requestBytes.toString("utf8")),
		);
	} catch {
		return writeResult({
			...common,
			requestFileSha256,
			request: null,
			status: "request_invalid",
			reasonCode: "request_invalid",
			reasonSubcode: null,
			completedAt: new Date(nowMs()).toISOString(),
		});
	}

	try {
		const exported = await exportExactCanonicalOrderBook({
			request,
			client:
				options.client ??
				createCanonicalOrderBookExportClientFromEnv(
					options.environment ?? process.env,
				),
			outputDirectory: paths.attemptRoot,
		});
		return writeResult({
			...common,
			requestFileSha256,
			request,
			status: "exported",
			reasonCode: "qualified_selection_exported",
			reasonSubcode: null,
			querySha256: exported.compiled.querySha256,
			querySegments: exported.compiled.segments,
			promotionReceiptIds: exported.promotionReceiptIds,
			artifacts: { levels: exported.levels, summary: exported.summary },
			completedAt: new Date(nowMs()).toISOString(),
		});
	} catch (error) {
		const reason =
			error instanceof ExactOrderBookExportError
				? error.reason
				: "archive_query_failed";
		const status = classifyExportFailure(reason);
		return writeResult({
			...common,
			requestFileSha256,
			request,
			status,
			reasonCode: status,
			reasonSubcode: reason,
			completedAt: new Date(nowMs()).toISOString(),
		});
	}
}

export async function runCanonicalOrderBookExportCli(
	argv: readonly string[],
	options: Omit<
		CanonicalOrderBookExportFileJobOptions,
		"requestPath" | "resultPath"
	> = {},
): Promise<number> {
	assertSupportedNode22(
		process.versions.node,
		"cex-canonical-orderbook-export",
	);
	const paths = parseFileJobArgv(argv);
	await runCanonicalOrderBookExportFileJob({ ...options, ...paths });
	return 0;
}

const invokedUrl = process.argv[1]
	? pathToFileURL(path.resolve(process.argv[1])).href
	: null;
if (invokedUrl === import.meta.url) {
	runCanonicalOrderBookExportCli(process.argv.slice(2)).then(
		(exitCode) => {
			process.exitCode = exitCode;
		},
		() => {
			console.error("cex-canonical-orderbook-export failed");
			process.exitCode = 1;
		},
	);
}
