import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import {
	BoundedSourceForensicsSink,
	classifySourceForensicsRecordsDeduplicated,
	commitSourceQualificationEvidence,
	evaluateSourceQualificationGates,
	type ReconstructionObservationSink,
	type SOURCE_TAPE_FAILURE_REASONS,
	type SourceForensicsLedgerWire,
	type SourceObjectInspection,
	type SourceTapeQualificationRecordWire,
} from "../market-data-source-forensics";
import type { ArchiveQueryClient } from "../market-data-vendor-backfill/archive-reader";
import {
	ARCHIVE_SELECTION_SCHEMA_ID,
	type ArchiveSelectionWire,
	type CanonicalScopeWire,
	type ForwarderBatch,
	finalizeArchiveSelection,
	type MarketDataVendorBackfillRequest,
	type ProviderCapability,
	type ProviderObjectEvidence,
} from "../market-data-vendor-backfill/contracts";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	CryptoHftDataAdapter,
	CryptoHftDataError,
	enumerateCryptoHftDataWindowObjects,
} from "../market-data-vendor-backfill/cryptohftdata";
import { jcsSha256 } from "../market-data-vendor-backfill/identity";
import {
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	RESOURCE_POLICY,
} from "../market-data-vendor-backfill/manifests";
import {
	assertSourceTapeSandboxAuthorization,
	createSourceTapeArchiveSink,
	SOURCE_TAPE_CAPABILITY,
	SOURCE_TAPE_CONSTRUCTION_MODE,
	SOURCE_TAPE_DEPTH,
	SOURCE_TAPE_SANDBOX_TARGET,
	type SourceTapeArchiveSinkResult,
	sourceTapeCaptureBundleId,
} from "../source-tape";
import {
	promoteAndExportSourceTapeSandbox,
	type SourceTapeExportResult,
	type SourceTapeSandboxEvidence,
	verifySourceTapeArchive,
} from "../source-tape-sandbox";
import {
	CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
	type CanonicalOrderBookExportResultWire,
	canonicalOrderBookExportResultCodec,
} from "./contracts";
import { assertSidecarBasename, atomicWriteJsonResult } from "./file-job";

export const MARKET_DATA_SOURCE_TAPE_OPERATION_ID =
	"market-data-source-tape/v1" as const;

type PolicyPin = { policy_id: string; policy_sha256: string };

export type MarketDataSourceTapeInvocation = {
	operation_id: typeof MARKET_DATA_SOURCE_TAPE_OPERATION_ID;
	attempt_id: string;
	request_id: string;
	scope: CanonicalScopeWire & {
		exchange: "okx";
		trading_pair: "ARB-USDC" | "ARB-USDT";
		market_type: "spot";
		feed: "ORDERBOOK";
	};
	window: { start_at: string; end_at: string };
	depth: 100;
	target: typeof SOURCE_TAPE_SANDBOX_TARGET;
	production_authorization_id: string;
	expected_canonical_schema: { schema_id: string; schema_sha256: string };
	product_pins: {
		source_tape_capability: PolicyPin;
		resource_policy: PolicyPin;
		adapter_policy: PolicyPin;
		acquisition_policy: PolicyPin;
	};
	artifacts: {
		ledger_file_name: string;
		qualification_record_file_name: string;
		exporter_result_file_name: string;
	};
};

export type SourceTapeAdapter = {
	capabilityFor(
		request: MarketDataVendorBackfillRequest,
	): ProviderCapability | undefined;
	acquire(
		request: MarketDataVendorBackfillRequest,
		capability: ProviderCapability,
		credential: { apiKey: string },
	): Promise<unknown>;
};

export type MarketDataSourceTapeDependencies = {
	forwarder: {
		preflight(input: {
			authorizationId: string;
			target: { environment: string; cluster: string };
		}): Promise<{
			forwarderIdentity: { environment: string; cluster: string };
			authorization: {
				authorizationId: string;
				scope: "production";
				environment: string;
				cluster: string;
				expiresAt: string;
				credentialValidated: true;
			};
		}>;
		submit(batch: ForwarderBatch): Promise<{
			ok: boolean;
			inserted: number;
		}>;
	};
	archive_query: ArchiveQueryClient;
	archive: {
		resolveSelection(
			request: MarketDataVendorBackfillRequest,
		): Promise<ArchiveSelectionWire>;
	};
	exporter: {
		export(
			request: Parameters<
				Parameters<
					typeof promoteAndExportSourceTapeSandbox
				>[0]["exporter"]["export"]
			>[0],
		): Promise<
			SourceTapeExportResult & {
				result: CanonicalOrderBookExportResultWire;
			}
		>;
	};
	adapter_factory?: (
		observer: ReconstructionObservationSink,
		sink: ReturnType<typeof createSourceTapeArchiveSink>,
	) => SourceTapeAdapter;
	inspect_source_object?: (
		identity: string,
		attempt: number,
	) => SourceObjectInspection | Promise<SourceObjectInspection>;
};

export type MarketDataSourceTapeInput = {
	invocation: MarketDataSourceTapeInvocation;
	attempt_root: string;
	created_at: string;
	credential: { api_key: string };
	dependencies: MarketDataSourceTapeDependencies;
};

export type MarketDataSourceTapeResult = {
	operation_id: typeof MARKET_DATA_SOURCE_TAPE_OPERATION_ID;
	normalized_invocation_sha256: string;
	ledger: SourceForensicsLedgerWire;
	qualification: SourceTapeQualificationRecordWire;
	sink_result: SourceTapeArchiveSinkResult | null;
	sandbox_evidence: SourceTapeSandboxEvidence | null;
	exporter_result: CanonicalOrderBookExportResultWire | null;
};

function exactObject(
	value: unknown,
	keys: readonly string[],
	reason: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(reason);
	}
	if (
		JSON.stringify(Object.keys(value).sort()) !==
		JSON.stringify([...keys].sort())
	) {
		throw new Error(reason);
	}
}

function fixedTime(value: unknown, reason: string): number {
	if (typeof value !== "string") throw new Error(reason);
	const parsed = Date.parse(value);
	if (
		!Number.isSafeInteger(parsed) ||
		new Date(parsed).toISOString() !== value
	) {
		throw new Error(reason);
	}
	return parsed;
}

function samePin(left: PolicyPin, right: PolicyPin): boolean {
	return (
		left.policy_id === right.policy_id &&
		left.policy_sha256 === right.policy_sha256
	);
}

function decodeInvocation(value: unknown): MarketDataSourceTapeInvocation {
	exactObject(
		value,
		[
			"operation_id",
			"attempt_id",
			"request_id",
			"scope",
			"window",
			"depth",
			"target",
			"production_authorization_id",
			"expected_canonical_schema",
			"product_pins",
			"artifacts",
		],
		"source_tape_invocation_invalid",
	);
	if (
		value.operation_id !== MARKET_DATA_SOURCE_TAPE_OPERATION_ID ||
		typeof value.attempt_id !== "string" ||
		!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.attempt_id) ||
		typeof value.request_id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
			value.request_id,
		) ||
		typeof value.production_authorization_id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
			value.production_authorization_id,
		) ||
		value.depth !== SOURCE_TAPE_DEPTH
	) {
		throw new Error("source_tape_invocation_invalid");
	}
	exactObject(
		value.scope,
		["exchange", "trading_pair", "market_type", "feed"],
		"source_tape_scope_invalid",
	);
	if (
		value.scope.exchange !== "okx" ||
		(value.scope.trading_pair !== "ARB-USDC" &&
			value.scope.trading_pair !== "ARB-USDT") ||
		value.scope.market_type !== "spot" ||
		value.scope.feed !== "ORDERBOOK"
	) {
		throw new Error("source_tape_scope_invalid");
	}
	exactObject(
		value.window,
		["start_at", "end_at"],
		"source_tape_window_invalid",
	);
	const startTimeMs = fixedTime(
		value.window.start_at,
		"source_tape_window_invalid",
	);
	const endTimeMs = fixedTime(
		value.window.end_at,
		"source_tape_window_invalid",
	);
	if (
		endTimeMs <= startTimeMs ||
		endTimeMs - startTimeMs > RESOURCE_POLICY.request_bounds.max_window_ms
	) {
		throw new Error("source_tape_window_invalid");
	}
	exactObject(
		value.target,
		["environment", "cluster"],
		"source_tape_target_invalid",
	);
	if (
		value.target.environment !== SOURCE_TAPE_SANDBOX_TARGET.environment ||
		value.target.cluster !== SOURCE_TAPE_SANDBOX_TARGET.cluster
	) {
		throw new Error("source_tape_target_invalid");
	}
	exactObject(
		value.expected_canonical_schema,
		["schema_id", "schema_sha256"],
		"source_tape_canonical_schema_invalid",
	);
	if (
		value.expected_canonical_schema.schema_id !==
			"cex-order-book-canonical/v1" ||
		typeof value.expected_canonical_schema.schema_sha256 !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.expected_canonical_schema.schema_sha256)
	) {
		throw new Error("source_tape_canonical_schema_invalid");
	}
	exactObject(
		value.product_pins,
		[
			"source_tape_capability",
			"resource_policy",
			"adapter_policy",
			"acquisition_policy",
		],
		"source_tape_policy_pins_invalid",
	);
	for (const key of [
		"source_tape_capability",
		"resource_policy",
		"adapter_policy",
		"acquisition_policy",
	] as const) {
		exactObject(
			value.product_pins[key],
			["policy_id", "policy_sha256"],
			"source_tape_policy_pins_invalid",
		);
	}
	if (
		!samePin(
			value.product_pins.source_tape_capability as PolicyPin,
			SOURCE_TAPE_CAPABILITY,
		) ||
		!samePin(
			value.product_pins.resource_policy as PolicyPin,
			RESOURCE_POLICY,
		) ||
		!samePin(
			value.product_pins.adapter_policy as PolicyPin,
			EFFECTIVE_ADAPTER_POLICY_PIN,
		) ||
		!samePin(
			value.product_pins.acquisition_policy as PolicyPin,
			EFFECTIVE_ACQUISITION_POLICY_PIN,
		)
	) {
		throw new Error("source_tape_policy_pins_invalid");
	}
	exactObject(
		value.artifacts,
		[
			"ledger_file_name",
			"qualification_record_file_name",
			"exporter_result_file_name",
		],
		"source_tape_artifacts_invalid",
	);
	for (const fileName of Object.values(value.artifacts)) {
		if (typeof fileName !== "string")
			throw new Error("source_tape_artifacts_invalid");
		assertSidecarBasename(fileName);
	}
	return value as MarketDataSourceTapeInvocation;
}

async function assertAttemptRoot(attemptRoot: string): Promise<void> {
	if (!path.isAbsolute(attemptRoot))
		throw new Error("source_tape_attempt_root_invalid");
	const stats = await lstat(attemptRoot);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error("source_tape_attempt_root_invalid");
	}
}

function initialSelection(input: {
	invocation: MarketDataSourceTapeInvocation;
	createdAt: string;
	normalizedInvocationSha256: string;
}): ArchiveSelectionWire {
	return finalizeArchiveSelection({
		schema_id: ARCHIVE_SELECTION_SCHEMA_ID,
		scope: input.invocation.scope,
		required_clock: {
			clock_id: input.invocation.request_id,
			clock_sha256: input.normalizedInvocationSha256,
			event_count: 0,
		},
		coverage_policy: {
			policy_id: "prior-asof-strict/v1",
			max_asof_lag_ms: 5_000,
			future_rows: "reject",
			missing_required_event: "fail",
		},
		source_policy: "authoritative_window",
		coverage_class: "missing",
		requested_intervals: [input.invocation.window],
		selected_intervals: [],
		precedence: ["vendor"],
		bundles: [],
		support_anchors: [],
		receipt_ids: [],
		qualification_event_ids: [],
		resolved_at: input.createdAt,
	});
}

function internalRequest(input: {
	invocation: MarketDataSourceTapeInvocation;
	normalizedInvocationSha256: string;
	createdAt: string;
}): MarketDataVendorBackfillRequest {
	const startTimeMs = Date.parse(input.invocation.window.start_at);
	const endTimeMs = Date.parse(input.invocation.window.end_at);
	const coveragePolicy = {
		policy_id: "prior-asof-strict/v1" as const,
		max_asof_lag_ms: 5_000,
		future_rows: "reject" as const,
		missing_required_event: "fail" as const,
	};
	return {
		schemaVersion: "market-data-vendor-backfill-request/v1",
		requestId: input.invocation.request_id,
		idempotencyKey: input.normalizedInvocationSha256,
		providerPolicy: {
			provider: "cryptohftdata",
			allowedAdapterVersions: [SOURCE_TAPE_CAPABILITY.adapter_version],
		},
		scope: {
			exchange: "okx",
			tradingPair: input.invocation.scope.trading_pair,
			sourceSymbol: input.invocation.scope.trading_pair,
			marketType: "spot",
			feed: "ORDERBOOK",
		},
		window: { startTimeMs, endTimeMs },
		depth: SOURCE_TAPE_DEPTH,
		constructionMode: "sampled_top_n_snapshot",
		requiredClockTargetsMs: [],
		maxPriorAsOfLagMs: 5_000,
		sourcePolicy: "authoritative_window",
		budgets: {
			maxFiles: RESOURCE_POLICY.limits.max_files,
			maxBytes: RESOURCE_POLICY.limits.max_bytes,
			maxRows: RESOURCE_POLICY.limits.max_rows,
			maxDurationMs: RESOURCE_POLICY.limits.max_duration_ms,
			maxBoundaryLookbackMs: RESOURCE_POLICY.limits.max_boundary_lookback_ms,
		},
		expectedProduct: {
			packageName: "@usherlabs/cex-broker",
			canonicalSchemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
		},
		attemptId: input.invocation.attempt_id,
		target: SOURCE_TAPE_SANDBOX_TARGET,
		coveragePolicy,
		initialSelection: initialSelection(input),
		expectedCanonicalSchema: input.invocation.expected_canonical_schema,
		productPins: {
			capability_policy: input.invocation.product_pins.source_tape_capability,
			resource_policy: input.invocation.product_pins.resource_policy,
		},
		productionAuthorizationId: input.invocation.production_authorization_id,
	};
}

function datasetEvidence(value: unknown): {
	objects: ProviderObjectEvidence[];
	vendorSemanticDigest: string;
} | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as {
		objects?: unknown;
		vendorSemanticDigest?: unknown;
	};
	if (
		!Array.isArray(candidate.objects) ||
		typeof candidate.vendorSemanticDigest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(candidate.vendorSemanticDigest)
	)
		return null;
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
	)
		return null;
	return {
		objects: objects.map((object) => ({ ...object })),
		vendorSemanticDigest: candidate.vendorSemanticDigest,
	};
}

function defaultAdapter(
	observer: ReconstructionObservationSink,
	sink: ReturnType<typeof createSourceTapeArchiveSink>,
): SourceTapeAdapter {
	return new CryptoHftDataAdapter({
		observer,
		policyNeutralTapeSink: sink,
		profiles: [
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
		],
	});
}

function failureReason(
	phase: string,
	error: unknown,
): (typeof SOURCE_TAPE_FAILURE_REASONS)[number] {
	const reason =
		error instanceof CryptoHftDataError
			? error.reason
			: error instanceof Error
				? error.message
				: "";
	if (
		reason.includes("archive_forwarder") ||
		reason.includes("source_tape_forwarder")
	) {
		return "source_tape_archive_failed";
	}
	if (reason.includes("selection")) return "source_tape_selection_failed";
	if (reason.includes("export")) return "source_tape_export_failed";
	if (reason.includes("promotion")) return "source_tape_promotion_failed";
	if (phase === "credential") return "source_tape_credentials_missing";
	if (phase === "capability") return "source_tape_capability_unsupported";
	if (phase === "authorization") return "source_tape_archive_failed";
	if (phase === "acquisition") {
		return /sequence|snapshot|book|reconstruct|update/u.test(reason)
			? "source_tape_reconstruction_failed"
			: "source_tape_acquisition_failed";
	}
	if (phase === "inventory") return "source_tape_inventory_incomplete";
	if (phase === "verification") return "source_tape_archive_failed";
	if (phase === "promotion") return "source_tape_promotion_failed";
	if (phase === "selection") return "source_tape_selection_failed";
	if (phase === "export") return "source_tape_export_failed";
	return "source_tape_internal_failure";
}

export async function runMarketDataSourceTape(
	input: MarketDataSourceTapeInput,
): Promise<MarketDataSourceTapeResult> {
	exactObject(
		input,
		["invocation", "attempt_root", "created_at", "credential", "dependencies"],
		"source_tape_input_invalid",
	);
	const invocation = decodeInvocation(input.invocation);
	await assertAttemptRoot(input.attempt_root);
	fixedTime(input.created_at, "source_tape_created_at_invalid");
	exactObject(input.credential, ["api_key"], "source_tape_credential_invalid");
	if (!input.dependencies || typeof input.dependencies !== "object")
		throw new Error("source_tape_dependencies_invalid");
	const dependencyKeys = Object.keys(input.dependencies);
	if (
		dependencyKeys.some(
			(key) =>
				![
					"forwarder",
					"archive_query",
					"archive",
					"exporter",
					"adapter_factory",
					"inspect_source_object",
				].includes(key),
		)
	) {
		throw new Error("source_tape_dependencies_invalid");
	}
	const normalizedInvocationSha256 = jcsSha256(invocation);
	for (const fileName of [
		invocation.artifacts.qualification_record_file_name,
		invocation.artifacts.exporter_result_file_name,
	]) {
		await rm(path.join(input.attempt_root, fileName), { force: true });
	}
	const request = internalRequest({
		invocation,
		normalizedInvocationSha256,
		createdAt: input.created_at,
	});
	const expectedObjects = enumerateCryptoHftDataWindowObjects(
		request,
		"okx_spot",
		invocation.scope.trading_pair,
	);
	const captureBundleId = sourceTapeCaptureBundleId({
		idempotencyKey: normalizedInvocationSha256,
		tradingPair: invocation.scope.trading_pair,
		window: request.window,
		expectedObjectIdentities: expectedObjects,
	});
	const tapeSink = createSourceTapeArchiveSink({
		captureBundleId,
		tradingPair: invocation.scope.trading_pair,
		window: request.window,
		forwarder: input.dependencies.forwarder,
	});
	const forensicSink = new BoundedSourceForensicsSink({
		schema_id:
			"https://schemas.usher.so/market-data-source-forensics-ledger/v1",
		operation_kind: "source_tape",
		normalized_invocation_sha256: normalizedInvocationSha256,
		request_id: invocation.request_id,
		scope: invocation.scope,
		window: {
			start_time_ms: request.window.startTimeMs,
			end_time_ms_exclusive: request.window.endTimeMs,
		},
		effective_policies: {
			capability_policy: invocation.product_pins.source_tape_capability,
			resource_policy: invocation.product_pins.resource_policy,
			adapter_policy: invocation.product_pins.adapter_policy,
			acquisition_policy: invocation.product_pins.acquisition_policy,
		},
		adapter_version: SOURCE_TAPE_CAPABILITY.adapter_version,
		expected_provider_object_identities: expectedObjects,
		source_tape: {
			product_id: "market-data-source-tape",
			product_version: "market-data-source-tape/v1",
			state_count: 0,
		},
		redact_values: new Set([input.credential.api_key]),
	});
	let phase = "credential";
	let sourceAccepted = false;
	let sinkResult: SourceTapeArchiveSinkResult | null = null;
	let sandboxEvidence: SourceTapeSandboxEvidence | null = null;
	const exporterResultState: {
		value: CanonicalOrderBookExportResultWire | null;
	} = { value: null };
	let handledError: unknown;
	try {
		if (!input.credential.api_key.trim())
			throw new Error("source_tape_credentials_missing");
		phase = "capability";
		const adapter = (input.dependencies.adapter_factory ?? defaultAdapter)(
			forensicSink,
			tapeSink,
		);
		const capability = adapter.capabilityFor(request);
		if (
			!capability ||
			capability.adapterVersion !== SOURCE_TAPE_CAPABILITY.adapter_version
		) {
			throw new Error("source_tape_capability_unsupported");
		}
		phase = "authorization";
		const preflight = await input.dependencies.forwarder.preflight({
			authorizationId: invocation.production_authorization_id,
			target: invocation.target,
		});
		assertSourceTapeSandboxAuthorization({
			requestAuthorizationId: invocation.production_authorization_id,
			requestTarget: invocation.target,
			preflight: preflight.authorization,
		});
		phase = "acquisition";
		const acquired = await adapter.acquire(request, capability, {
			apiKey: input.credential.api_key,
		});
		const dataset = datasetEvidence(acquired);
		if (!dataset) throw new Error("source_tape_dataset_evidence_invalid");
		sinkResult = tapeSink.result();
		forensicSink.setSourceTapeStateCount(sinkResult.state_count);
		const classificationRequests = forensicSink.pendingClassificationRequests();
		if (
			classificationRequests.length > 0 &&
			input.dependencies.inspect_source_object
		) {
			const classifications = await classifySourceForensicsRecordsDeduplicated({
				requests: classificationRequests,
				maxAttempts: 3,
				inspect: input.dependencies.inspect_source_object,
			});
			for (const classification of classifications)
				forensicSink.applyRecordClassification(classification);
		}
		sourceAccepted = true;
		const provisionalLedger = forensicSink.finish();
		if (!provisionalLedger.provider_object_inventory.complete) {
			phase = "inventory";
			throw new Error("source_tape_inventory_incomplete");
		}
		const provisionalGates = evaluateSourceQualificationGates(
			provisionalLedger,
			true,
		);
		if (
			provisionalGates.operation_kind !== "source_tape" ||
			!provisionalGates.source_event_enumeration_eligible
		) {
			phase = "inventory";
			throw new Error("source_tape_enumeration_evidence_incomplete");
		}
		const tapeRequest = {
			...request,
			constructionMode: SOURCE_TAPE_CONSTRUCTION_MODE,
		} as MarketDataVendorBackfillRequest;
		phase = "verification";
		const verification = await verifySourceTapeArchive({
			request: tapeRequest,
			sinkResult,
			client: input.dependencies.archive_query,
		});
		if (!verification.passed)
			throw new Error(
				verification.reasonCode ?? "source_tape_verification_failed",
			);
		phase = "promotion";
		sandboxEvidence = await promoteAndExportSourceTapeSandbox({
			request: tapeRequest,
			sinkResult,
			verification,
			datasetObjects: dataset.objects,
			vendorSemanticDigest: dataset.vendorSemanticDigest,
			verifiedAt: input.created_at,
			forwarder: input.dependencies.forwarder,
			archive: input.dependencies.archive,
			exporter: {
				async export(exportRequest) {
					phase = "export";
					const exported =
						await input.dependencies.exporter.export(exportRequest);
					exporterResultState.value =
						canonicalOrderBookExportResultCodec.decode(exported.result);
					const resultArtifacts = exporterResultState.value.outcome.artifacts;
					if (
						exporterResultState.value.outcome.status !== "exported" ||
						exporterResultState.value.schema_id !==
							CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID ||
						exporterResultState.value.outcome.request_id !==
							exportRequest.request_id ||
						exporterResultState.value.outcome.selection_sha256 !==
							exportRequest.selection.selection_sha256 ||
						JSON.stringify(
							exporterResultState.value.outcome.promotion_receipt_ids,
						) !== JSON.stringify(exported.promotionReceiptIds) ||
						!resultArtifacts ||
						JSON.stringify(resultArtifacts.levels) !==
							JSON.stringify(exported.levels) ||
						JSON.stringify(resultArtifacts.summary) !==
							JSON.stringify(exported.summary)
					) {
						throw new Error("source_tape_export_result_invalid");
					}
					return exported;
				},
			},
		});
		if (!exporterResultState.value) {
			throw new Error("source_tape_export_result_missing");
		}
		await atomicWriteJsonResult(
			path.join(
				input.attempt_root,
				invocation.artifacts.exporter_result_file_name,
			),
			exporterResultState.value,
			{
				validate: (value) => canonicalOrderBookExportResultCodec.decode(value),
			},
		);
	} catch (error) {
		handledError = error;
	}
	let ledger = forensicSink.finish();
	if (
		sinkResult &&
		ledger.operation_kind === "source_tape" &&
		ledger.source_tape.state_count !== sinkResult.state_count
	) {
		forensicSink.setSourceTapeStateCount(sinkResult.state_count);
		ledger = forensicSink.finish();
	}
	let exporterResult = exporterResultState.value;
	const exportDescriptor = exporterResult
		? (() => {
				const bytes = new TextEncoder().encode(
					`${JSON.stringify(exporterResult)}\n`,
				);
				return {
					schema_id:
						"https://schemas.usher.so/cex-canonical-orderbook-export-result/v2" as const,
					file_name: invocation.artifacts.exporter_result_file_name,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					bytes: bytes.byteLength,
					result_sha256: exporterResult.result_sha256,
				};
			})()
		: null;
	const outcome: SourceTapeQualificationRecordWire["outcome"] = handledError
		? {
				status: "failure",
				reason: failureReason(phase, handledError),
				partial_evidence: [],
				exporter_result: null,
			}
		: {
				status: "success",
				reason: "source_tape_prepared",
				partial_evidence: [],
				exporter_result: exportDescriptor as NonNullable<
					typeof exportDescriptor
				>,
			};
	if (handledError && exporterResult) {
		const artifacts = exporterResult.outcome.artifacts;
		if (artifacts) {
			for (const fileName of [
				artifacts.levels.file_name,
				artifacts.summary.file_name,
			]) {
				assertSidecarBasename(fileName);
				await rm(path.join(input.attempt_root, fileName), { force: true });
			}
		}
		await rm(
			path.join(
				input.attempt_root,
				invocation.artifacts.exporter_result_file_name,
			),
			{ force: true },
		);
		exporterResult = null;
		sandboxEvidence = null;
	}
	const qualification = await commitSourceQualificationEvidence({
		outputDirectory: input.attempt_root,
		ledgerFileName: invocation.artifacts.ledger_file_name,
		qualificationFileName: invocation.artifacts.qualification_record_file_name,
		ledger,
		createdAt: input.created_at,
		sourceAccepted,
		sourceTapeInitializer: sinkResult?.initializer,
		sourceTapeOutcome: outcome,
	});
	return {
		operation_id: MARKET_DATA_SOURCE_TAPE_OPERATION_ID,
		normalized_invocation_sha256: normalizedInvocationSha256,
		ledger,
		qualification: qualification as SourceTapeQualificationRecordWire,
		sink_result: sinkResult,
		sandbox_evidence: sandboxEvidence,
		exporter_result: exporterResult,
	};
}
