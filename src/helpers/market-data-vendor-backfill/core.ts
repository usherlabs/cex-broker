import { sha256Canonical } from "../market-data-archive/capture-contract";
import { buildForwarderBatches } from "./batching";
import {
	type ArchiveSelectionWire,
	archiveSelectionCodec,
	type BackfillArchiveRow,
	decodeBackfillRunDocuments,
	EXTERNAL_BACKFILL_SOURCE,
	type FinalBackfillStatus,
	type ForwarderBatch,
	type MarketDataVendorBackfillRequest,
	PROMOTION_RECEIPT_SCHEMA_ID,
	type PromotionReceiptWire,
	type ProviderCapability,
	type ProviderObjectEvidence,
	promotionReceiptCodec,
} from "./contracts";
import { jcsCanonicalize } from "./identity";
import {
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	RESOURCE_POLICY,
} from "./manifests";
import {
	finalizePromotionReceipt,
	promotionReceiptToArchiveRow,
} from "./promotion";
import {
	finalizeQualificationEvent,
	qualificationEventToArchiveRow,
} from "./qualification";
import { archiveSelectionToArchiveRow } from "./selection";

export type ProviderDataset<Row = unknown> = {
	objects: ProviderObjectEvidence[];
	vendorSemanticDigest: string;
	rows: Row[];
};

export type NormalizedBackfill = {
	captureBundleId: string;
	objects: ProviderObjectEvidence[];
	rows: BackfillArchiveRow[];
	vendorSemanticDigest: string;
	canonicalSemanticDigest: string;
};

export type CandidateVerification = {
	passed: boolean;
	captureBundleId: string;
	canonicalSemanticDigest: string;
	prefixDigest: string;
	suffixDigest: string;
	seamVerified: boolean;
	coverageVerified: boolean;
	reasonCode?: string;
};

export type ArchiveClusterIdentity = {
	environment: string;
	cluster: string;
};

export type ProductionForwarderAuthorization = {
	authorizationId: string;
	scope: "production";
	environment: string;
	cluster: string;
	expiresAt: string;
	credentialValidated: true;
};

export type ArchivePreflightResolution = {
	selection: ArchiveSelectionWire;
	receipts: PromotionReceiptWire[];
	readerIdentity: ArchiveClusterIdentity;
	verificationBaseline?: {
		prefixDigest: string;
		suffixDigest: string;
	};
};

export type ForwarderPreflightResolution = {
	forwarderIdentity: ArchiveClusterIdentity;
	authorization: ProductionForwarderAuthorization;
};

/** @deprecated Use ArchivePreflightResolution and its exact selection. */
export type QualifiedCoverage = {
	complete: boolean;
	coverageDigest: string;
	prefixDigest?: string;
	suffixDigest?: string;
};

export type BackfillDomainOutcome = {
	status: FinalBackfillStatus;
	reasonCode: string;
	reasonSubcode?: string;
	requestId?: string;
	idempotencyKey?: string;
	target?: ArchiveClusterIdentity;
	selection?: ArchiveSelectionWire;
	receipt?: PromotionReceiptWire;
	diagnostics?: Record<string, string | number | boolean>;
};

export type BackfillDependencies = {
	archive: {
		resolveSelection(
			request: MarketDataVendorBackfillRequest,
		): Promise<ArchivePreflightResolution>;
		verifyCandidate(
			request: MarketDataVendorBackfillRequest,
			normalized: NormalizedBackfill,
			captureBundleId: string,
			baseline: ArchivePreflightResolution,
		): Promise<CandidateVerification>;
	};
	providers: {
		capabilityFor(
			request: MarketDataVendorBackfillRequest,
		): ProviderCapability | undefined;
		acquire(
			request: MarketDataVendorBackfillRequest,
			capability: ProviderCapability,
			credential: unknown,
		): Promise<ProviderDataset>;
		normalize(
			request: MarketDataVendorBackfillRequest,
			capability: ProviderCapability,
			dataset: ProviderDataset,
			captureBundleId: string,
		): Promise<NormalizedBackfill>;
	};
	credentials: {
		resolve(provider: "cryptohftdata"): Promise<unknown | undefined>;
	};
	forwarder: {
		preflight(input: {
			authorizationId: string;
			target: ArchiveClusterIdentity;
		}): Promise<ForwarderPreflightResolution>;
		submit(batch: ForwarderBatch): Promise<{ ok: boolean; inserted: number }>;
	};
	clock: { nowMs(): number };
	retry?: {
		maxAttempts: number;
		wait?: (completedAttempt: number) => Promise<void>;
	};
	log?: (event: string, fields: Record<string, unknown>) => void;
};

export function createMarketDataVendorBackfillDependencies(
	dependencies: BackfillDependencies,
): BackfillDependencies {
	for (const [name, value] of Object.entries({
		archive: dependencies.archive,
		providers: dependencies.providers,
		credentials: dependencies.credentials,
		forwarder: dependencies.forwarder,
		clock: dependencies.clock,
	})) {
		if (!value || typeof value !== "object") {
			throw new TypeError(`Backfill dependency ${name} is required`);
		}
	}
	for (const [name, method] of Object.entries({
		"archive.resolveSelection": dependencies.archive.resolveSelection,
		"archive.verifyCandidate": dependencies.archive.verifyCandidate,
		"providers.capabilityFor": dependencies.providers.capabilityFor,
		"providers.acquire": dependencies.providers.acquire,
		"providers.normalize": dependencies.providers.normalize,
		"credentials.resolve": dependencies.credentials.resolve,
		"forwarder.preflight": dependencies.forwarder.preflight,
		"forwarder.submit": dependencies.forwarder.submit,
		"clock.nowMs": dependencies.clock.nowMs,
	})) {
		if (typeof method !== "function") {
			throw new TypeError(`Backfill dependency ${name} is required`);
		}
	}
	return dependencies;
}

function outcome(
	request: MarketDataVendorBackfillRequest | undefined,
	status: FinalBackfillStatus,
	reasonCode: string,
	extra: Pick<
		BackfillDomainOutcome,
		"reasonSubcode" | "selection" | "receipt" | "diagnostics"
	> = {},
): BackfillDomainOutcome {
	return {
		status,
		reasonCode,
		...(request
			? {
					requestId: request.requestId,
					idempotencyKey: request.idempotencyKey,
					...(request.target ? { target: request.target } : {}),
				}
			: {}),
		...extra,
	};
}

function captureBundleId(
	request: MarketDataVendorBackfillRequest,
	capability: ProviderCapability,
	dataset: ProviderDataset,
): string {
	// Capture-bundle identity intentionally retains the existing capture checksum
	// algorithm. RFC 8785 applies only to final-v1 wire documents.
	return sha256Canonical({
		request_business_identity: request.idempotencyKey,
		provider: capability.provider,
		provider_exchange_id: capability.providerExchangeId,
		resolved_symbol: capability.resolvedSymbol,
		adapter_version: capability.adapterVersion,
		objects: dataset.objects.map(({ identity, checksum, bytes, rows }) => ({
			identity,
			checksum,
			bytes,
			rows,
		})),
		canonical_schema_version: request.expectedProduct.canonicalSchemaVersion,
		checksum_algorithm: request.expectedProduct.checksumAlgorithm,
	});
}

function buildPromotionReceipt(
	request: MarketDataVendorBackfillRequest,
	capability: ProviderCapability,
	normalized: NormalizedBackfill,
	verification: CandidateVerification,
	verificationTimeMs: number,
): PromotionReceiptWire {
	if (
		!request.wire ||
		!request.initialSelection ||
		!request.expectedCanonicalSchema ||
		!request.coveragePolicy ||
		!request.productPins
	) {
		throw new Error("decoded final-v1 request context is missing");
	}
	return finalizePromotionReceipt({
		schema_id: PROMOTION_RECEIPT_SCHEMA_ID,
		verified_at: new Date(verificationTimeMs).toISOString(),
		request_id: request.requestId,
		idempotency_key: request.idempotencyKey,
		source: EXTERNAL_BACKFILL_SOURCE,
		capture_origin: "vendor_historical_backfill",
		source_mode: "vendor_historical_backfill_v1",
		provider: capability.provider,
		adapter_version: capability.adapterVersion,
		effective_policies: {
			capability_policy: request.productPins.capability_policy,
			resource_policy: request.productPins.resource_policy,
			adapter_policy: EFFECTIVE_ADAPTER_POLICY_PIN,
			acquisition_policy: EFFECTIVE_ACQUISITION_POLICY_PIN,
		},
		capture_bundle_id: normalized.captureBundleId,
		scope: request.wire.scope,
		window: request.wire.window,
		depth: request.depth,
		construction_mode: request.constructionMode,
		canonical_schema: request.expectedCanonicalSchema,
		coverage_policy: request.coveragePolicy,
		selection_sha256: request.initialSelection.selection_sha256,
		vendor_semantic_digest: normalized.vendorSemanticDigest,
		canonical_semantic_digest: verification.canonicalSemanticDigest,
		prefix_digest: verification.prefixDigest,
		suffix_digest: verification.suffixDigest,
		seam_verified: true,
		coverage_verified: true,
		dataset_objects: normalized.objects,
	});
}

async function submitAll(
	dependencies: BackfillDependencies,
	batches: readonly ForwarderBatch[],
): Promise<boolean> {
	const maxAttempts = Math.max(
		1,
		Math.min(10, dependencies.retry?.maxAttempts ?? 3),
	);
	for (const batch of batches) {
		let accepted = false;
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				const response = await dependencies.forwarder.submit(batch);
				accepted = response.ok && response.inserted === batch.rows.length;
			} catch {
				accepted = false;
			}
			if (accepted) break;
			if (attempt < maxAttempts) await dependencies.retry?.wait?.(attempt);
		}
		if (!accepted) return false;
	}
	return true;
}

function stableFailureReason(error: unknown, fallback: string): string {
	if (error && typeof error === "object") {
		const reason = (error as { reason?: unknown }).reason;
		if (typeof reason === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(reason)) {
			return reason;
		}
	}
	return fallback;
}

function assertArchivePreflight(
	request: MarketDataVendorBackfillRequest,
	resolution: ArchivePreflightResolution,
): void {
	if (!request.target || !request.productionAuthorizationId) {
		throw new Error("request target or production authorization ID is missing");
	}
	const selection = archiveSelectionCodec.decode(resolution.selection);
	const receipts = resolution.receipts.map((receipt) =>
		promotionReceiptCodec.decode(receipt),
	);
	const receiptById = new Map<string, PromotionReceiptWire>();
	for (const receipt of receipts) {
		const existing = receiptById.get(receipt.receipt_id);
		if (existing && jcsCanonicalize(existing) !== jcsCanonicalize(receipt)) {
			throw new Error("stored receipt identity has conflicting content");
		}
		receiptById.set(receipt.receipt_id, receipt);
	}
	for (const bundle of selection.bundles) {
		if (
			bundle.capture_origin === "vendor_historical_backfill" &&
			(!bundle.qualification ||
				!receiptById.has(bundle.qualification.receipt_id))
		) {
			throw new Error("vendor selection lacks its validated stored receipt");
		}
	}
	if (
		resolution.readerIdentity.environment !== request.target.environment ||
		resolution.readerIdentity.cluster !== request.target.cluster
	) {
		throw new Error("archive reader cluster identity mismatch");
	}
}

function assertForwarderPreflight(
	request: MarketDataVendorBackfillRequest,
	resolution: ForwarderPreflightResolution,
	nowMs: number,
): void {
	if (!request.target || !request.productionAuthorizationId) {
		throw new Error("request target or production authorization ID is missing");
	}
	if (
		resolution.forwarderIdentity.environment !== request.target.environment ||
		resolution.forwarderIdentity.cluster !== request.target.cluster
	) {
		throw new Error("archive forwarder cluster identity mismatch");
	}
	const authorization = resolution.authorization;
	const expiresAtMs = Date.parse(authorization.expiresAt);
	if (
		authorization.authorizationId !== request.productionAuthorizationId ||
		authorization.scope !== "production" ||
		authorization.environment !== request.target.environment ||
		authorization.cluster !== request.target.cluster ||
		authorization.credentialValidated !== true ||
		!Number.isSafeInteger(expiresAtMs) ||
		new Date(expiresAtMs).toISOString() !== authorization.expiresAt ||
		expiresAtMs <= nowMs
	) {
		throw new Error("production forwarder authorization is invalid");
	}
}

function resourcePolicyScopeExceeded(
	request: MarketDataVendorBackfillRequest,
): boolean {
	return (
		request.depth > RESOURCE_POLICY.request_bounds.max_depth ||
		request.window.endTimeMs - request.window.startTimeMs >
			RESOURCE_POLICY.request_bounds.max_window_ms ||
		request.requiredClockTargetsMs.length >
			RESOURCE_POLICY.request_bounds.max_required_events
	);
}

function storedReceiptForSelection(
	resolution: ArchivePreflightResolution,
): PromotionReceiptWire | undefined {
	const receiptId = resolution.selection.receipt_ids[0];
	return receiptId
		? resolution.receipts.find((receipt) => receipt.receipt_id === receiptId)
		: undefined;
}

export async function runMarketDataVendorBackfill(
	input: unknown,
	dependencies: BackfillDependencies,
): Promise<BackfillDomainOutcome> {
	let request: MarketDataVendorBackfillRequest;
	try {
		const documents = input as { request?: unknown; requiredClock?: unknown };
		request = decodeBackfillRunDocuments({
			request: documents.request,
			requiredClock: documents.requiredClock,
		});
	} catch {
		return outcome(undefined, "request_invalid", "request_invalid");
	}

	let initialResolution: ArchivePreflightResolution;
	try {
		initialResolution = await dependencies.archive.resolveSelection(request);
		assertArchivePreflight(request, initialResolution);
		const forwarderPreflight = await dependencies.forwarder.preflight({
			authorizationId: request.productionAuthorizationId as string,
			target: request.target as ArchiveClusterIdentity,
		});
		assertForwarderPreflight(
			request,
			forwarderPreflight,
			dependencies.clock.nowMs(),
		);
	} catch {
		return outcome(
			request,
			"archive_preflight_failed",
			"archive_preflight_failed",
		);
	}
	if (initialResolution.selection.coverage_class === "complete") {
		const receipt = storedReceiptForSelection(initialResolution);
		return outcome(request, "already_covered", "qualified_coverage_complete", {
			selection: initialResolution.selection,
			...(receipt ? { receipt } : {}),
		});
	}

	if (resourcePolicyScopeExceeded(request)) {
		return outcome(
			request,
			"capability_unsupported",
			"capability_unsupported",
			{ reasonSubcode: "resource_policy_scope_exceeded" },
		);
	}

	let capability: ProviderCapability | undefined;
	try {
		capability = dependencies.providers.capabilityFor(request);
	} catch {
		return outcome(
			request,
			"capability_unsupported",
			"capability_probe_failed",
		);
	}
	if (!capability) {
		return outcome(request, "capability_unsupported", "scope_unsupported");
	}
	if (
		!request.providerPolicy.allowedAdapterVersions.includes(
			capability.adapterVersion,
		)
	) {
		return outcome(
			request,
			"capability_unsupported",
			"adapter_version_unpinned",
		);
	}

	let credential: unknown;
	try {
		credential = await dependencies.credentials.resolve(capability.provider);
	} catch {
		return outcome(
			request,
			"credentials_missing",
			"credential_resolution_failed",
		);
	}
	if (credential === undefined || credential === null) {
		return outcome(
			request,
			"credentials_missing",
			"provider_credentials_missing",
		);
	}

	let dataset: ProviderDataset;
	let normalized: NormalizedBackfill;
	try {
		dataset = await dependencies.providers.acquire(
			request,
			capability,
			credential,
		);
		const bundleId = captureBundleId(request, capability, dataset);
		normalized = await dependencies.providers.normalize(
			request,
			capability,
			dataset,
			bundleId,
		);
		if (normalized.captureBundleId !== bundleId) {
			return outcome(request, "vendor_fetch_failed", "vendor_fetch_failed", {
				reasonSubcode: "capture_identity_mismatch",
			});
		}
	} catch (error) {
		const reason = stableFailureReason(error, "provider_dataset_invalid");
		return outcome(request, "vendor_fetch_failed", "vendor_fetch_failed", {
			reasonSubcode: reason.startsWith("budget_")
				? "resource_limit_exceeded"
				: reason,
		});
	}

	try {
		const candidateBatches = buildForwarderBatches({
			captureBundleId: normalized.captureBundleId,
			deploymentId: "market-data-vendor-backfill",
			rows: normalized.rows,
		});
		if (!(await submitAll(dependencies, candidateBatches))) {
			return outcome(
				request,
				"archive_ingest_failed",
				"candidate_batch_rejected",
			);
		}
	} catch {
		return outcome(
			request,
			"archive_ingest_failed",
			"candidate_submission_failed",
		);
	}

	let verification: CandidateVerification;
	try {
		verification = await dependencies.archive.verifyCandidate(
			request,
			normalized,
			normalized.captureBundleId,
			initialResolution,
		);
	} catch {
		return outcome(
			request,
			"promotion_verification_failed",
			"candidate_query_failed",
		);
	}
	if (
		!verification.passed ||
		verification.captureBundleId !== normalized.captureBundleId ||
		verification.canonicalSemanticDigest !==
			normalized.canonicalSemanticDigest ||
		!verification.seamVerified ||
		!verification.coverageVerified
	) {
		return outcome(
			request,
			"promotion_verification_failed",
			verification.reasonCode ?? "semantic_verification_failed",
		);
	}

	let receipt: PromotionReceiptWire;
	try {
		receipt = buildPromotionReceipt(
			request,
			capability,
			normalized,
			verification,
			dependencies.clock.nowMs(),
		);
		const [batch] = buildForwarderBatches({
			captureBundleId: normalized.captureBundleId,
			deploymentId: "market-data-vendor-backfill",
			rows: [promotionReceiptToArchiveRow(receipt)],
		});
		if (!batch || !(await submitAll(dependencies, [batch]))) {
			return outcome(
				request,
				"archive_ingest_failed",
				"promotion_commit_failed",
			);
		}
		const qualification = finalizeQualificationEvent({
			capture_bundle_id: receipt.capture_bundle_id,
			state: "qualified",
			receipt_id: receipt.receipt_id,
			promotion_identity_sha256: receipt.promotion_identity_sha256,
			window: receipt.window,
			event_at: receipt.verified_at,
			reason_code: "promotion_verified",
		});
		const [qualificationBatch] = buildForwarderBatches({
			captureBundleId: normalized.captureBundleId,
			deploymentId: "market-data-vendor-backfill",
			rows: [qualificationEventToArchiveRow(qualification)],
		});
		if (
			!qualificationBatch ||
			!(await submitAll(dependencies, [qualificationBatch]))
		) {
			return outcome(
				request,
				"archive_ingest_failed",
				"qualification_commit_failed",
				{ receipt },
			);
		}
	} catch {
		return outcome(request, "archive_ingest_failed", "promotion_commit_failed");
	}

	let finalResolution: ArchivePreflightResolution;
	try {
		finalResolution = await dependencies.archive.resolveSelection(request);
		assertArchivePreflight(request, finalResolution);
	} catch (error) {
		return outcome(
			request,
			"promotion_verification_failed",
			"post_promotion_selection_failed",
			{
				receipt,
				reasonSubcode: stableFailureReason(
					error,
					"archive_selection_resolution_failed",
				),
			},
		);
	}
	if (finalResolution.selection.coverage_class !== "complete") {
		return outcome(
			request,
			"promotion_verification_failed",
			"qualified_coverage_incomplete",
			{ receipt, selection: finalResolution.selection },
		);
	}
	if (
		finalResolution.selection.bundles.some(
			(bundle) =>
				bundle.capture_bundle_id === receipt.capture_bundle_id &&
				bundle.capture_origin === "vendor_historical_backfill" &&
				bundle.qualification?.receipt_id === receipt.receipt_id,
		) === false
	) {
		return outcome(
			request,
			"promotion_verification_failed",
			"promoted_receipt_not_selected",
			{ receipt, selection: finalResolution.selection },
		);
	}
	try {
		if (!request.wire) throw new Error("decoded request wire is missing");
		const [selectionBatch] = buildForwarderBatches({
			captureBundleId: receipt.capture_bundle_id,
			deploymentId: "market-data-vendor-backfill",
			rows: [
				archiveSelectionToArchiveRow(request.wire, finalResolution.selection),
			],
		});
		if (!selectionBatch || !(await submitAll(dependencies, [selectionBatch]))) {
			return outcome(
				request,
				"archive_ingest_failed",
				"selection_persistence_failed",
				{ receipt, selection: finalResolution.selection },
			);
		}
	} catch {
		return outcome(
			request,
			"archive_ingest_failed",
			"selection_persistence_failed",
			{ receipt, selection: finalResolution.selection },
		);
	}
	return outcome(request, "promoted", "promotion_qualified", {
		receipt,
		selection: finalResolution.selection,
	});
}
