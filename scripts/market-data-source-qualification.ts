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
	commitSourceQualificationEvidence,
	type ReconstructionObservationSink,
	type SourceForensicsLedgerWire,
	type SourceQualificationRecordWire,
} from "../src/helpers/market-data-source-forensics";
import {
	decodeBackfillRunDocuments,
	type MarketDataVendorBackfillRequest,
	type ProviderCapability,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	CryptoHftDataAdapter,
	CryptoHftDataError,
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
) => SourceQualificationAdapter;

export type MarketDataSourceQualificationResult = {
	sourceAccepted: boolean;
	failureReason: string | null;
	ledger: SourceForensicsLedgerWire;
	qualification: SourceQualificationRecordWire;
};

export type MarketDataSourceQualificationInput = {
	documents: { request: unknown; requiredClock: unknown };
	outputDirectory: string;
	createdAt: string;
	apiKey: string;
	ledgerFileName?: string;
	qualificationFileName?: string;
	adapterFactory?: SourceQualificationAdapterFactory;
};

function defaultAdapterFactory(
	observer: ReconstructionObservationSink,
): SourceQualificationAdapter {
	return new CryptoHftDataAdapter({
		observer,
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
		required_clock_target_times_ms: request.requiredClockTargetsMs,
		redact_values: new Set([input.apiKey]),
	});
	const adapter = (input.adapterFactory ?? defaultAdapterFactory)(sink);
	const capability = adapter.capabilityFor(request);
	let sourceAccepted = false;
	let failureReason: string | null = null;
	if (!capability) {
		failureReason = "capability_unsupported";
	} else if (
		capability.adapterVersion !==
		CAPABILITY_POLICY.adapter_policy.adapter_version
	) {
		failureReason = "adapter_policy_mismatch";
	} else {
		try {
			await adapter.acquire(request, capability, { apiKey: input.apiKey });
			sourceAccepted = true;
		} catch (error) {
			failureReason =
				error instanceof CryptoHftDataError
					? error.reason
					: "source_qualification_failed";
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
	return { sourceAccepted, failureReason, ledger, qualification };
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
