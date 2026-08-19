import { sha256Canonical } from "../market-data-archive/capture-contract";
import { buildForwarderBatches } from "./batching";
import {
	BACKFILL_PROMOTION_SCHEMA_VERSION,
	BACKFILL_RESULT_SCHEMA_VERSION,
	type BackfillArchiveRow,
	type BackfillResult,
	EXTERNAL_BACKFILL_SOURCE,
	type ForwarderBatch,
	type MarketDataVendorBackfillRequest,
	type PromotionReceipt,
	type ProviderCapability,
	type ProviderObjectEvidence,
	parseBackfillRequest,
} from "./contracts";
import {
	finalizePromotionReceipt,
	promotionReceiptToArchiveRow,
} from "./promotion";

export type QualifiedCoverage = {
	complete: boolean;
	coverageDigest: string;
	prefixDigest?: string;
	suffixDigest?: string;
};

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

export type BackfillDependencies = {
	archive: {
		coverage(
			request: MarketDataVendorBackfillRequest,
		): Promise<QualifiedCoverage>;
		verifyCandidate(
			request: MarketDataVendorBackfillRequest,
			normalized: NormalizedBackfill,
			captureBundleId: string,
			baseline: QualifiedCoverage,
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
		submit(batch: ForwarderBatch): Promise<{ ok: boolean; inserted: number }>;
	};
	clock: { nowMs(): number };
	retry?: {
		maxAttempts: number;
		wait?: (completedAttempt: number) => Promise<void>;
	};
	log?: (event: string, fields: Record<string, unknown>) => void;
};

function result(
	request: Partial<MarketDataVendorBackfillRequest>,
	status: BackfillResult["status"],
	reasonCode: string,
	extra: Pick<BackfillResult, "receipt" | "diagnostics"> = {},
): BackfillResult {
	return {
		schemaVersion: BACKFILL_RESULT_SCHEMA_VERSION,
		requestId:
			typeof request.requestId === "string"
				? request.requestId
				: "invalid-request",
		...(typeof request.idempotencyKey === "string"
			? { idempotencyKey: request.idempotencyKey }
			: {}),
		status,
		reasonCode,
		...extra,
	};
}

function captureBundleId(
	request: MarketDataVendorBackfillRequest,
	capability: ProviderCapability,
	dataset: ProviderDataset,
): string {
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

function promotionReceipt(
	request: MarketDataVendorBackfillRequest,
	capability: ProviderCapability,
	normalized: NormalizedBackfill,
	verification: CandidateVerification,
	verificationTimeMs: number,
): PromotionReceipt {
	const stable = {
		schemaVersion: BACKFILL_PROMOTION_SCHEMA_VERSION,
		requestId: request.requestId,
		idempotencyKey: request.idempotencyKey,
		status: "passing" as const,
		source: EXTERNAL_BACKFILL_SOURCE,
		provider: capability.provider,
		adapterVersion: capability.adapterVersion,
		captureBundleId: normalized.captureBundleId,
		exchange: request.scope.exchange,
		tradingPair: request.scope.tradingPair,
		marketType: request.scope.marketType,
		feed: request.scope.feed,
		startTimeMs: request.window.startTimeMs,
		endTimeMs: request.window.endTimeMs,
		depth: request.depth,
		constructionMode: request.constructionMode,
		canonicalSchemaVersion: request.expectedProduct.canonicalSchemaVersion,
		checksumAlgorithm: request.expectedProduct.checksumAlgorithm,
		vendorSemanticDigest: normalized.vendorSemanticDigest,
		canonicalSemanticDigest: verification.canonicalSemanticDigest,
		prefixDigest: verification.prefixDigest,
		suffixDigest: verification.suffixDigest,
		seamVerified: true as const,
		coverageVerified: true as const,
		datasetObjects: normalized.objects,
	};
	return finalizePromotionReceipt(stable, verificationTimeMs);
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

export async function runMarketDataVendorBackfill(
	input: unknown,
	dependencies: BackfillDependencies,
): Promise<BackfillResult> {
	let request: MarketDataVendorBackfillRequest;
	try {
		request = parseBackfillRequest(input);
	} catch {
		return result(
			(input && typeof input === "object"
				? input
				: {}) as Partial<MarketDataVendorBackfillRequest>,
			"capability_unsupported",
			"request_invalid",
		);
	}

	let initialCoverage: QualifiedCoverage;
	try {
		initialCoverage = await dependencies.archive.coverage(request);
	} catch {
		return result(
			request,
			"promotion_verification_failed",
			"qualified_archive_preflight_failed",
		);
	}
	if (initialCoverage.complete) {
		return result(request, "already_covered", "qualified_coverage_complete");
	}

	let capability: ProviderCapability | undefined;
	try {
		capability = dependencies.providers.capabilityFor(request);
	} catch {
		return result(request, "capability_unsupported", "capability_probe_failed");
	}
	if (!capability) {
		return result(request, "capability_unsupported", "scope_unsupported");
	}
	if (
		!request.providerPolicy.allowedAdapterVersions.includes(
			capability.adapterVersion,
		)
	) {
		return result(
			request,
			"capability_unsupported",
			"adapter_version_unpinned",
		);
	}

	let credential: unknown;
	try {
		credential = await dependencies.credentials.resolve(capability.provider);
	} catch {
		return result(
			request,
			"credentials_missing",
			"credential_resolution_failed",
		);
	}
	if (credential === undefined || credential === null) {
		return result(
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
			return result(
				request,
				"vendor_fetch_failed",
				"capture_identity_mismatch",
			);
		}
	} catch (error) {
		return result(
			request,
			"vendor_fetch_failed",
			stableFailureReason(error, "provider_dataset_invalid"),
		);
	}

	let candidateBatches: ForwarderBatch[];
	try {
		candidateBatches = buildForwarderBatches({
			captureBundleId: normalized.captureBundleId,
			deploymentId: "market-data-vendor-backfill",
			rows: normalized.rows,
		});
		if (!(await submitAll(dependencies, candidateBatches))) {
			return result(
				request,
				"archive_ingest_failed",
				"candidate_batch_rejected",
			);
		}
	} catch {
		return result(
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
			initialCoverage,
		);
	} catch {
		return result(
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
		return result(
			request,
			"promotion_verification_failed",
			verification.reasonCode ?? "semantic_verification_failed",
		);
	}

	const receipt = promotionReceipt(
		request,
		capability,
		normalized,
		verification,
		dependencies.clock.nowMs(),
	);
	try {
		const [batch] = buildForwarderBatches({
			captureBundleId: normalized.captureBundleId,
			deploymentId: "market-data-vendor-backfill",
			rows: [promotionReceiptToArchiveRow(receipt)],
		});
		if (!batch || !(await submitAll(dependencies, [batch]))) {
			return result(
				request,
				"archive_ingest_failed",
				"promotion_commit_failed",
			);
		}
	} catch {
		return result(request, "archive_ingest_failed", "promotion_commit_failed");
	}

	let finalCoverage: QualifiedCoverage;
	try {
		finalCoverage = await dependencies.archive.coverage(request);
	} catch {
		return result(
			request,
			"post_backfill_coverage_insufficient",
			"post_promotion_query_failed",
			{ receipt },
		);
	}
	if (!finalCoverage.complete) {
		return result(
			request,
			"post_backfill_coverage_insufficient",
			"qualified_coverage_incomplete",
			{ receipt },
		);
	}
	return result(request, "promoted", "promotion_qualified", { receipt });
}
