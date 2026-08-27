import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import {
	BoundedSourceForensicsSink,
	classifySourceForensicsRecordsDeduplicated,
	commitSourceQualificationEvidence,
	type ReconstructionObservationSink,
	type RequiredClockSourceForensicsLedgerWire,
	type RequiredClockSourceQualificationRecordWire,
	type SourceObjectInspection,
} from "../market-data-source-forensics";
import {
	decodeBackfillRunDocuments,
	type MarketDataVendorBackfillRequest,
	type ProviderCapability,
	type ProviderObjectEvidence,
	type RequiredClockWire,
} from "../market-data-vendor-backfill/contracts";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	CryptoHftDataAdapter,
	CryptoHftDataError,
	enumerateCryptoHftDataObjects,
} from "../market-data-vendor-backfill/cryptohftdata";
import { jcsSha256 } from "../market-data-vendor-backfill/identity";
import {
	CAPABILITY_POLICY,
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	RESOURCE_POLICY,
} from "../market-data-vendor-backfill/manifests";
import { assertSidecarBasename } from "./file-job";

export const MARKET_DATA_REQUIRED_CLOCK_QUALIFICATION_OPERATION_ID =
	"market-data-required-clock-qualification/v1" as const;

export type RequiredClockQualificationAdapter = {
	capabilityFor(
		request: MarketDataVendorBackfillRequest,
	): ProviderCapability | undefined;
	acquire(
		request: MarketDataVendorBackfillRequest,
		capability: ProviderCapability,
		credential: { apiKey: string },
	): Promise<unknown>;
};

export type RequiredClockQualificationAdapterFactory = (
	observer: ReconstructionObservationSink,
) => RequiredClockQualificationAdapter;

export type MarketDataRequiredClockQualificationInvocation = {
	operation_id: typeof MARKET_DATA_REQUIRED_CLOCK_QUALIFICATION_OPERATION_ID;
	attempt_id: string;
	request: unknown;
	required_clock: unknown;
	artifacts: {
		ledger_file_name: string;
		qualification_record_file_name: string;
	};
};

export type MarketDataRequiredClockQualificationInput = {
	invocation: MarketDataRequiredClockQualificationInvocation;
	attempt_root: string;
	created_at: string;
	credential: { api_key: string };
	dependencies?: {
		adapter_factory?: RequiredClockQualificationAdapterFactory;
		inspect_source_object?: (
			identity: string,
			attempt: number,
		) => SourceObjectInspection | Promise<SourceObjectInspection>;
	};
};

export type MarketDataRequiredClockQualificationResult = {
	operation_id: typeof MARKET_DATA_REQUIRED_CLOCK_QUALIFICATION_OPERATION_ID;
	normalized_invocation_sha256: string;
	ledger: RequiredClockSourceForensicsLedgerWire;
	qualification: RequiredClockSourceQualificationRecordWire;
	source_dataset_evidence: {
		objects: ProviderObjectEvidence[];
		vendor_semantic_digest: string;
	} | null;
};

function assertExactKeys(
	value: unknown,
	keys: readonly string[],
	reason: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(reason);
	}
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(reason);
	}
}

function decodeInvocation(
	value: unknown,
): MarketDataRequiredClockQualificationInvocation {
	assertExactKeys(
		value,
		["operation_id", "attempt_id", "request", "required_clock", "artifacts"],
		"required_clock_qualification_invocation_invalid",
	);
	if (
		value.operation_id !==
			MARKET_DATA_REQUIRED_CLOCK_QUALIFICATION_OPERATION_ID ||
		typeof value.attempt_id !== "string" ||
		!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.attempt_id)
	) {
		throw new Error("required_clock_qualification_invocation_invalid");
	}
	assertExactKeys(
		value.artifacts,
		["ledger_file_name", "qualification_record_file_name"],
		"required_clock_qualification_artifacts_invalid",
	);
	if (
		typeof value.artifacts.ledger_file_name !== "string" ||
		typeof value.artifacts.qualification_record_file_name !== "string"
	) {
		throw new Error("required_clock_qualification_artifacts_invalid");
	}
	assertSidecarBasename(value.artifacts.ledger_file_name);
	assertSidecarBasename(value.artifacts.qualification_record_file_name);
	return value as MarketDataRequiredClockQualificationInvocation;
}

async function assertAttemptRoot(attemptRoot: string): Promise<void> {
	if (!path.isAbsolute(attemptRoot)) {
		throw new Error("required_clock_qualification_attempt_root_invalid");
	}
	const stats = await lstat(attemptRoot);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error("required_clock_qualification_attempt_root_invalid");
	}
}

function defaultAdapterFactory(
	observer: ReconstructionObservationSink,
): RequiredClockQualificationAdapter {
	return new CryptoHftDataAdapter({
		observer,
		profiles: [
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
		],
	});
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

function sourceDatasetEvidence(
	value: unknown,
):
	| MarketDataRequiredClockQualificationResult["source_dataset_evidence"]
	| null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as {
		objects?: unknown;
		vendorSemanticDigest?: unknown;
	};
	if (
		!Array.isArray(candidate.objects) ||
		typeof candidate.vendorSemanticDigest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(candidate.vendorSemanticDigest)
	) {
		return null;
	}
	const objects = candidate.objects as ProviderObjectEvidence[];
	if (
		!objects.every(
			(object) =>
				object &&
				typeof object.identity === "string" &&
				/^[a-f0-9]{64}$/u.test(object.checksum) &&
				Number.isSafeInteger(object.bytes) &&
				Number.isSafeInteger(object.rows),
		)
	) {
		return null;
	}
	return {
		objects: objects.map((object) => ({ ...object })),
		vendor_semantic_digest: candidate.vendorSemanticDigest,
	};
}

function stableFailureReason(
	reason: string | null,
):
	| "required_clock_capability_unsupported"
	| "required_clock_credentials_missing"
	| "required_clock_acquisition_failed"
	| "required_clock_reconstruction_failed"
	| "required_clock_classification_failed" {
	if (reason === "required_clock_credentials_missing") return reason;
	if (reason === "required_clock_capability_unsupported") return reason;
	if (reason === "required_clock_classification_failed") return reason;
	if (
		reason?.includes("clock") ||
		reason?.includes("snapshot") ||
		reason?.includes("sequence") ||
		reason?.includes("book") ||
		reason?.includes("update")
	) {
		return "required_clock_reconstruction_failed";
	}
	return "required_clock_acquisition_failed";
}

export async function runMarketDataRequiredClockQualification(
	input: MarketDataRequiredClockQualificationInput,
): Promise<MarketDataRequiredClockQualificationResult> {
	assertExactKeys(
		input,
		[
			"invocation",
			"attempt_root",
			"created_at",
			"credential",
			"dependencies",
		].filter(
			(key) => key !== "dependencies" || input.dependencies !== undefined,
		),
		"required_clock_qualification_input_invalid",
	);
	const invocation = decodeInvocation(input.invocation);
	await assertAttemptRoot(input.attempt_root);
	assertExactKeys(
		input.credential,
		["api_key"],
		"required_clock_qualification_credential_invalid",
	);
	if (input.dependencies) {
		const allowed = ["adapter_factory", "inspect_source_object"];
		const actual = Object.keys(input.dependencies);
		if (actual.some((key) => !allowed.includes(key))) {
			throw new Error("required_clock_qualification_dependencies_invalid");
		}
	}

	const request = decodeBackfillRunDocuments({
		request: invocation.request,
		requiredClock: invocation.required_clock,
	});
	if (!request.wire || !request.requiredClock) {
		throw new Error("required_clock_qualification_documents_invalid");
	}
	const requiredClock = request.requiredClock as RequiredClockWire;
	const normalizedInvocationSha256 = jcsSha256({
		operation_id: invocation.operation_id,
		attempt_id: invocation.attempt_id,
		request: request.wire,
		required_clock: requiredClock,
		artifacts: invocation.artifacts,
	});
	await rm(
		path.join(
			input.attempt_root,
			invocation.artifacts.qualification_record_file_name,
		),
		{ force: true },
	);

	const expectedObjects = enumerateCryptoHftDataObjects(
		request,
		"okx_spot",
		request.scope.tradingPair,
	);
	const sink = new BoundedSourceForensicsSink({
		schema_id:
			"https://schemas.usher.so/market-data-source-forensics-ledger/v1",
		operation_kind: "required_clock_qualification",
		normalized_invocation_sha256: normalizedInvocationSha256,
		request_id: request.wire.request_id,
		scope: request.wire.scope,
		window: {
			start_time_ms: request.window.startTimeMs,
			end_time_ms_exclusive: request.window.endTimeMs,
		},
		required_clock: {
			clock_id: requiredClock.clock_id,
			clock_sha256: requiredClock.clock_sha256,
			event_count: requiredClock.targets.length,
		},
		effective_policies: {
			capability_policy: currentPolicyPin(CAPABILITY_POLICY),
			resource_policy: currentPolicyPin(RESOURCE_POLICY),
			adapter_policy: EFFECTIVE_ADAPTER_POLICY_PIN,
			acquisition_policy: EFFECTIVE_ACQUISITION_POLICY_PIN,
		},
		adapter_version: CAPABILITY_POLICY.adapter_policy.adapter_version,
		required_clock_targets: requiredClock.targets.map((target) => ({
			target_id: target.target_id,
			target_time_ms: Date.parse(target.target_at),
		})),
		expected_provider_object_identities: expectedObjects,
		redact_values: new Set([input.credential.api_key]),
	});

	let sourceAccepted = false;
	let failureReason: string | null = null;
	let datasetEvidence: MarketDataRequiredClockQualificationResult["source_dataset_evidence"] =
		null;
	if (!input.credential.api_key.trim()) {
		failureReason = "required_clock_credentials_missing";
	} else {
		const adapter = (
			input.dependencies?.adapter_factory ?? defaultAdapterFactory
		)(sink);
		const capability = adapter.capabilityFor(request);
		if (
			!capability ||
			capability.adapterVersion !==
				CAPABILITY_POLICY.adapter_policy.adapter_version
		) {
			failureReason = "required_clock_capability_unsupported";
		} else {
			try {
				const acquired = await adapter.acquire(request, capability, {
					apiKey: input.credential.api_key,
				});
				datasetEvidence = sourceDatasetEvidence(acquired);
				sourceAccepted = true;
			} catch (error) {
				failureReason =
					error instanceof CryptoHftDataError
						? error.reason
						: "required_clock_acquisition_failed";
			}
		}
	}

	const classificationRequests = sink.pendingClassificationRequests();
	if (
		classificationRequests.length > 0 &&
		input.dependencies?.inspect_source_object
	) {
		try {
			const classifications = await classifySourceForensicsRecordsDeduplicated({
				requests: classificationRequests,
				maxAttempts: 3,
				inspect: input.dependencies.inspect_source_object,
			});
			for (const classification of classifications) {
				sink.applyRecordClassification(classification);
			}
		} catch {
			failureReason = "required_clock_classification_failed";
			sourceAccepted = false;
		}
	}

	const ledger = sink.finish() as RequiredClockSourceForensicsLedgerWire;
	const qualification = (await commitSourceQualificationEvidence({
		outputDirectory: input.attempt_root,
		ledgerFileName: invocation.artifacts.ledger_file_name,
		qualificationFileName: invocation.artifacts.qualification_record_file_name,
		ledger,
		createdAt: input.created_at,
		sourceAccepted,
		requiredClock,
		...(sourceAccepted
			? {}
			: { requiredClockFailureReason: stableFailureReason(failureReason) }),
	})) as RequiredClockSourceQualificationRecordWire;

	return {
		operation_id: MARKET_DATA_REQUIRED_CLOCK_QUALIFICATION_OPERATION_ID,
		normalized_invocation_sha256: normalizedInvocationSha256,
		ledger,
		qualification,
		source_dataset_evidence: datasetEvidence,
	};
}
