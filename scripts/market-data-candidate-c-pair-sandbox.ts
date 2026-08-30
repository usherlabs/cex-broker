import { createReadStream, createWriteStream } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
	CANDIDATE_C_INPUT_TAPE_CAPABILITY,
	CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
	CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET,
	candidateCInputTapeCaptureBundleId,
	createCandidateCInputTapeArchiveSink,
} from "../src/helpers/candidate-c-input-tape";
import {
	type CandidateCInputTapeSandboxManifest,
	promoteAndExportCandidateCInputTapeSandbox,
	verifyCandidateCInputTapeArchive,
} from "../src/helpers/candidate-c-input-tape-sandbox";
import { atomicWriteJsonResult } from "../src/helpers/market-data-preparation/file-job";
import type {
	SourceObjectInspection,
	SourceQualificationRecordWire,
} from "../src/helpers/market-data-source-forensics";
import { decodeBackfillRunDocuments } from "../src/helpers/market-data-vendor-backfill/contracts";
import { enumerateCryptoHftDataWindowObjects } from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import {
	documentSha256,
	jcsSha256,
} from "../src/helpers/market-data-vendor-backfill/identity";
import type { MarketDataQualificationSandboxRuntime } from "./market-data-qualification-sandbox-runtime";
import {
	type MarketDataSourceQualificationInput,
	runMarketDataSourceQualification,
} from "./market-data-source-qualification";
import type { TwoPairSourceQualificationRun } from "./market-data-source-qualification-gate";

const PAIR_MANIFEST_SCHEMA_ID =
	"https://schemas.usher.so/candidate-c-input-tape-pair-manifest/v1" as const;

type Pair = "ARB-USDC" | "ARB-USDT";

type PairManifest = {
	schema_id: typeof PAIR_MANIFEST_SCHEMA_ID;
	manifest_sha256: string;
	pair: Pair;
	created_at: string;
	clickhouse: MarketDataQualificationSandboxRuntime["clickhouse"];
	source_qualification: {
		record_sha256: string;
		ledger_sha256: string;
	};
	artifacts: {
		levels: CandidateCInputTapeSandboxManifest["export"]["levels"];
		summary: CandidateCInputTapeSandboxManifest["export"]["summary"];
	};
	sandbox: CandidateCInputTapeSandboxManifest;
};

export function candidateCInputTapePairArtifactFileNames(pair: Pair): {
	levels: string;
	summary: string;
} {
	const prefix = pair.toLowerCase();
	return {
		levels: `${prefix}-order-book-levels.parquet`,
		summary: `${prefix}-order-book-depth-summary.parquet`,
	};
}

async function assertOutputDirectory(directory: string): Promise<void> {
	const stats = await lstat(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error("candidate_c_pair_output_directory_invalid");
	}
}

async function durableCopyFile(
	source: string,
	destination: string,
): Promise<void> {
	const temporary = `${destination}.tmp`;
	await rm(temporary, { force: true });
	try {
		await pipeline(
			createReadStream(source),
			createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
		);
		const file = await open(temporary, "r");
		try {
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, destination);
		const directory = await open(path.dirname(destination), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

function stableReason(error: unknown): string {
	const value = error instanceof Error ? error.message : "";
	return /^[a-z][a-z0-9_]{0,127}$/u.test(value)
		? value
		: "candidate_c_pair_sandbox_failed";
}

export async function runCandidateCInputTapePairSandbox(input: {
	pair: Pair;
	documents: MarketDataSourceQualificationInput["documents"];
	bootstrapQualification: SourceQualificationRecordWire;
	apiKey: string;
	createdAt: string;
	outputDirectory: string;
	runtime: MarketDataQualificationSandboxRuntime;
	inspectSourceObject?: (
		identity: string,
		attempt: number,
	) => SourceObjectInspection | Promise<SourceObjectInspection>;
}): Promise<TwoPairSourceQualificationRun> {
	await assertOutputDirectory(input.outputDirectory);
	const manifestFileName = `${input.pair.toLowerCase()}-tape-manifest.json`;
	const manifestPath = path.join(input.outputDirectory, manifestFileName);
	const artifactFileNames = candidateCInputTapePairArtifactFileNames(
		input.pair,
	);
	const levelsPath = path.join(input.outputDirectory, artifactFileNames.levels);
	const summaryPath = path.join(
		input.outputDirectory,
		artifactFileNames.summary,
	);
	let partialEvidenceSha256s: string[] = [];
	try {
		const request = decodeBackfillRunDocuments(input.documents);
		if (
			request.scope.tradingPair !== input.pair ||
			request.depth !== 100 ||
			request.target?.environment !==
				CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET.environment ||
			request.target.cluster !==
				CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET.cluster ||
			!request.productionAuthorizationId
		) {
			throw new Error("candidate_c_pair_request_scope_invalid");
		}
		const expectedObjectIdentities = enumerateCryptoHftDataWindowObjects(
			request,
			"okx_spot",
			input.pair,
		);
		const captureBundleId = candidateCInputTapeCaptureBundleId({
			idempotencyKey: request.idempotencyKey,
			tradingPair: input.pair,
			window: request.window,
			expectedObjectIdentities,
		});
		const sink = createCandidateCInputTapeArchiveSink({
			captureBundleId,
			tradingPair: input.pair,
			window: request.window,
			forwarder: input.runtime.forwarder,
		});
		const source = await runMarketDataSourceQualification({
			documents: input.documents,
			outputDirectory: input.outputDirectory,
			createdAt: input.createdAt,
			apiKey: input.apiKey,
			ledgerFileName: `${input.pair.toLowerCase()}-tape-source-forensics.json`,
			qualificationFileName: `${input.pair.toLowerCase()}-tape-source-qualification.json`,
			candidateCInputTapeSink: sink,
			bootstrapQualification: input.bootstrapQualification,
			inspectSourceObject: input.inspectSourceObject,
		});
		partialEvidenceSha256s = [
			source.ledger.ledger_sha256,
			source.qualification.record_sha256,
		];
		if (
			!source.sourceAccepted ||
			!source.candidateCInputTapeEligible ||
			!source.sourceDatasetEvidence
		) {
			throw new Error(
				source.failureReason ?? "candidate_c_pair_source_not_eligible",
			);
		}
		const sinkResult = sink.result();
		const tapeRequest = {
			...request,
			idempotencyKey: jcsSha256({
				identity: "candidate-c-input-tape-request/v1",
				original_idempotency_key: request.idempotencyKey,
				capture_bundle_id: captureBundleId,
				capability_policy_sha256:
					CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_sha256,
			}),
			constructionMode: CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
		};
		const verification = await verifyCandidateCInputTapeArchive({
			request: tapeRequest,
			sinkResult,
			client: input.runtime.queryClient,
		});
		if (!verification.passed) {
			throw new Error(
				verification.reasonCode ?? "candidate_c_pair_archive_not_verified",
			);
		}
		const sandbox = await promoteAndExportCandidateCInputTapeSandbox({
			request: tapeRequest,
			sinkResult,
			verification,
			datasetObjects: source.sourceDatasetEvidence.objects,
			vendorSemanticDigest: source.sourceDatasetEvidence.vendorSemanticDigest,
			verifiedAt: input.createdAt,
			forwarder: input.runtime.forwarder,
			archive: input.runtime.archive,
			exporter: input.runtime.exporter,
		});
		await Promise.all([
			durableCopyFile(
				path.join(
					input.runtime.outputDirectory,
					sandbox.export.levels.file_name,
				),
				levelsPath,
			),
			durableCopyFile(
				path.join(
					input.runtime.outputDirectory,
					sandbox.export.summary.file_name,
				),
				summaryPath,
			),
		]);
		const content = {
			schema_id: PAIR_MANIFEST_SCHEMA_ID,
			pair: input.pair,
			created_at: input.createdAt,
			clickhouse: input.runtime.clickhouse,
			source_qualification: {
				record_sha256: source.qualification.record_sha256,
				ledger_sha256: source.ledger.ledger_sha256,
			},
			artifacts: {
				levels: {
					...sandbox.export.levels,
					file_name: artifactFileNames.levels,
				},
				summary: {
					...sandbox.export.summary,
					file_name: artifactFileNames.summary,
				},
			},
			sandbox,
		};
		const manifest: PairManifest = {
			...content,
			manifest_sha256: documentSha256(content, "manifest_sha256"),
		};
		await atomicWriteJsonResult(manifestPath, manifest);
		return {
			pair: input.pair,
			status: "passed",
			manifest_file_name: manifestFileName,
			manifest_sha256: manifest.manifest_sha256,
			artifact_sha256s: [
				sandbox.export.levels.sha256,
				sandbox.export.summary.sha256,
			].sort(),
			partial_evidence_sha256s: [],
		};
	} catch (error) {
		await Promise.all([
			rm(manifestPath, { force: true }),
			rm(levelsPath, { force: true }),
			rm(summaryPath, { force: true }),
		]);
		return {
			pair: input.pair,
			status: "failed",
			reason: stableReason(error),
			artifact_sha256s: [],
			partial_evidence_sha256s: [...new Set(partialEvidenceSha256s)].sort(),
		};
	}
}
