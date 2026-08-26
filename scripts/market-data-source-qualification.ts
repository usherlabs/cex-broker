#!/usr/bin/env bun
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
	FILE_JOB_CLOCK_MAX_BYTES,
	FILE_JOB_REQUEST_MAX_BYTES,
	readBoundedRegularFile,
} from "../src/helpers/market-data-preparation/file-job";
import {
	BoundedSourceForensicsSink,
	classifySourceForensicsRecordsDeduplicated,
	commitSourceQualificationEvidence,
	type ReconstructionObservationSink,
	type SourceForensicsLedgerWire,
	type SourceObjectInspection,
	type SourceQualificationRecordWire,
	sourceQualificationRecordCodec,
} from "../src/helpers/market-data-source-forensics";
import {
	decodeBackfillRunDocuments,
	type MarketDataVendorBackfillRequest,
	type ProviderCapability,
	type ProviderObjectEvidence,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	CryptoHftDataAdapter,
	CryptoHftDataError,
	enumerateCryptoHftDataObjects,
	enumerateCryptoHftDataWindowObjects,
	type PolicyNeutralTapeSink,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import {
	CAPABILITY_POLICY,
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";

type SourceQualificationAdapter = {
	capabilityFor(
		request: MarketDataVendorBackfillRequest,
	): ProviderCapability | undefined;
	acquire(
		request: MarketDataVendorBackfillRequest,
		capability: ProviderCapability,
		credential: { apiKey: string },
	): Promise<unknown>;
};

export type SourceQualificationAdapterFactory = (
	observer: ReconstructionObservationSink,
	options?: { policyNeutralTapeSink?: PolicyNeutralTapeSink },
) => SourceQualificationAdapter;

export type MarketDataSourceQualificationResult = {
	sourceAccepted: boolean;
	failureReason: string | null;
	ledger: SourceForensicsLedgerWire;
	qualification: SourceQualificationRecordWire;
	candidateCInputTapeEligible: boolean;
	sourceDatasetEvidence: {
		objects: ProviderObjectEvidence[];
		vendorSemanticDigest: string;
	} | null;
};

export type MarketDataSourceQualificationInput = {
	documents: { request: unknown; requiredClock: unknown };
	outputDirectory: string;
	createdAt: string;
	apiKey: string;
	ledgerFileName?: string;
	qualificationFileName?: string;
	adapterFactory?: SourceQualificationAdapterFactory;
	inspectSourceObject?: (
		identity: string,
		attempt: number,
	) => SourceObjectInspection | Promise<SourceObjectInspection>;
	candidateCInputTapeSink?: PolicyNeutralTapeSink;
	bootstrapQualification?: SourceQualificationRecordWire;
};

function defaultAdapterFactory(
	observer: ReconstructionObservationSink,
	options: { policyNeutralTapeSink?: PolicyNeutralTapeSink } = {},
): SourceQualificationAdapter {
	return new CryptoHftDataAdapter({
		observer,
		policyNeutralTapeSink: options.policyNeutralTapeSink,
		profiles: [
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
		],
	});
}

async function assertOutputDirectory(outputDirectory: string): Promise<void> {
	const stats = await lstat(outputDirectory);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(
			"source qualification output must be a non-symlink directory",
		);
	}
}

function pairArtifactPrefix(tradingPair: string): string {
	if (tradingPair !== "ARB-USDT" && tradingPair !== "ARB-USDC") {
		throw new Error("source qualification pair is unsupported");
	}
	return tradingPair.toLowerCase();
}

function currentPolicyPin(policy: {
	policy_id: string;
	policy_sha256: string;
}) {
	return {
		policy_id: policy.policy_id,
		policy_sha256: policy.policy_sha256,
	};
}

/**
 * Repository-only source gate. It observes the same current OKX adapter used by
 * the file job and commits only bounded, secret-free qualification evidence.
 */
export async function runMarketDataSourceQualification(
	input: MarketDataSourceQualificationInput,
): Promise<MarketDataSourceQualificationResult> {
	if (!input.apiKey.trim()) {
		throw new Error("cryptohftdata_api_key_missing");
	}
	await assertOutputDirectory(input.outputDirectory);
	const request = decodeBackfillRunDocuments(input.documents);
	const wire = request.wire;
	if (!wire || !request.requiredClock) {
		throw new Error("source qualification requires wire documents");
	}
	const prefix = pairArtifactPrefix(wire.scope.trading_pair);
	if (input.candidateCInputTapeSink) {
		const bootstrap = input.bootstrapQualification
			? sourceQualificationRecordCodec.decode(input.bootstrapQualification)
			: undefined;
		if (
			!bootstrap?.qualified ||
			!bootstrap.candidate_c_source_enumeration_eligible ||
			bootstrap.scope.exchange !== wire.scope.exchange ||
			bootstrap.scope.trading_pair !== wire.scope.trading_pair
		) {
			throw new Error("candidate_c_input_tape_bootstrap_gate_missing");
		}
	}
	const sink = new BoundedSourceForensicsSink({
		schema_id:
			"https://schemas.usher.so/market-data-source-forensics-ledger/v1",
		request_id: wire.request_id,
		idempotency_key: wire.idempotency_key,
		scope: wire.scope,
		required_clock: {
			clock_id: request.requiredClock.clock_id,
			clock_sha256: request.requiredClock.clock_sha256,
			event_count: request.requiredClock.targets.length,
		},
		effective_policies: {
			capability_policy: currentPolicyPin(CAPABILITY_POLICY),
			resource_policy: currentPolicyPin(RESOURCE_POLICY),
			adapter_policy: EFFECTIVE_ADAPTER_POLICY_PIN,
			acquisition_policy: EFFECTIVE_ACQUISITION_POLICY_PIN,
		},
		adapter_version: CAPABILITY_POLICY.adapter_policy.adapter_version,
		required_clock_targets: request.requiredClock.targets.map((target) => ({
			target_id: target.target_id,
			target_time_ms: Date.parse(target.target_at),
		})),
		expected_provider_object_identities: input.candidateCInputTapeSink
			? enumerateCryptoHftDataWindowObjects(
					request,
					"okx_spot",
					wire.scope.trading_pair,
				)
			: enumerateCryptoHftDataObjects(
					request,
					"okx_spot",
					wire.scope.trading_pair,
				),
		redact_values: new Set([input.apiKey]),
	});
	const adapter = (input.adapterFactory ?? defaultAdapterFactory)(sink, {
		policyNeutralTapeSink: input.candidateCInputTapeSink,
	});
	const capability = adapter.capabilityFor(request);
	let sourceAccepted = false;
	let failureReason: string | null = null;
	let sourceDatasetEvidence: MarketDataSourceQualificationResult["sourceDatasetEvidence"] =
		null;
	if (!capability) {
		failureReason = "capability_unsupported";
	} else if (
		capability.adapterVersion !==
		CAPABILITY_POLICY.adapter_policy.adapter_version
	) {
		failureReason = "adapter_policy_mismatch";
	} else {
		try {
			const acquired = await adapter.acquire(request, capability, {
				apiKey: input.apiKey,
			});
			if (
				acquired &&
				typeof acquired === "object" &&
				Array.isArray((acquired as { objects?: unknown }).objects) &&
				typeof (acquired as { vendorSemanticDigest?: unknown })
					.vendorSemanticDigest === "string"
			) {
				const dataset = acquired as {
					objects: ProviderObjectEvidence[];
					vendorSemanticDigest: string;
				};
				if (
					/^[a-f0-9]{64}$/u.test(dataset.vendorSemanticDigest) &&
					dataset.objects.every(
						(object) =>
							object &&
							typeof object.identity === "string" &&
							/^[a-f0-9]{64}$/u.test(object.checksum) &&
							Number.isSafeInteger(object.bytes) &&
							Number.isSafeInteger(object.rows),
					)
				) {
					sourceDatasetEvidence = {
						objects: dataset.objects.map((object) => ({ ...object })),
						vendorSemanticDigest: dataset.vendorSemanticDigest,
					};
				}
			}
			sourceAccepted = true;
		} catch (error) {
			failureReason =
				error instanceof CryptoHftDataError
					? error.reason
					: "source_qualification_failed";
		}
	}
	const classificationRequests = sink.pendingClassificationRequests();
	if (classificationRequests.length > 0 && input.inspectSourceObject) {
		try {
			const classifications = await classifySourceForensicsRecordsDeduplicated({
				requests: classificationRequests,
				maxAttempts: 3,
				inspect: input.inspectSourceObject,
			});
			for (const classification of classifications) {
				sink.applyRecordClassification(classification);
			}
		} catch {
			// Unavailable or invalid re-fetch evidence remains unresolved and
			// therefore cannot support derivation or Candidate C enumeration.
			if (failureReason === null) {
				failureReason = "source_classification_failed";
			}
		}
	}

	const ledger = sink.finish();
	const qualification = await commitSourceQualificationEvidence({
		outputDirectory: input.outputDirectory,
		ledgerFileName: input.ledgerFileName ?? `${prefix}-source-forensics.json`,
		qualificationFileName:
			input.qualificationFileName ?? `${prefix}-source-qualification.json`,
		ledger,
		createdAt: input.createdAt,
		sourceAccepted,
	});
	return {
		sourceAccepted,
		failureReason,
		ledger,
		qualification,
		candidateCInputTapeEligible:
			input.candidateCInputTapeSink !== undefined &&
			qualification.qualified &&
			qualification.candidate_c_source_enumeration_eligible,
		sourceDatasetEvidence,
	};
}

function parseCli(argv: readonly string[]): {
	requestPath: string;
	clockPath: string;
	outputDirectory: string;
} {
	if (
		argv.length !== 7 ||
		argv[0] !== "run" ||
		argv[1] !== "--request" ||
		argv[3] !== "--clock" ||
		argv[5] !== "--output-directory" ||
		!argv[2] ||
		!argv[4] ||
		!argv[6]
	) {
		throw new Error(
			"expected exactly: run --request <path> --clock <path> --output-directory <path>",
		);
	}
	return {
		requestPath: path.resolve(argv[2]),
		clockPath: path.resolve(argv[4]),
		outputDirectory: path.resolve(argv[6]),
	};
}

if (import.meta.main) {
	if (process.env.MARKET_DATA_SOURCE_QUALIFICATION_ENABLED !== "1") {
		throw new Error(
			"Set MARKET_DATA_SOURCE_QUALIFICATION_ENABLED=1 to run licensed source qualification",
		);
	}
	const paths = parseCli(process.argv.slice(2));
	const [requestBytes, clockBytes] = await Promise.all([
		readBoundedRegularFile(paths.requestPath, FILE_JOB_REQUEST_MAX_BYTES),
		readBoundedRegularFile(paths.clockPath, FILE_JOB_CLOCK_MAX_BYTES),
	]);
	const result = await runMarketDataSourceQualification({
		documents: {
			request: JSON.parse(requestBytes.toString("utf8")),
			requiredClock: JSON.parse(clockBytes.toString("utf8")),
		},
		outputDirectory: paths.outputDirectory,
		createdAt: new Date().toISOString(),
		apiKey: process.env.CRYPTOHFTDATA_API_KEY ?? "",
	});
	console.log(
		JSON.stringify({
			source_accepted: result.sourceAccepted,
			failure_reason: result.failureReason,
			qualification: result.qualification,
			ledger_summary: result.ledger.summary,
		}),
	);
	if (!result.qualification.qualified) process.exitCode = 1;
}
