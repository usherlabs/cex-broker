import { z } from "zod";
import { sha256Canonical } from "../market-data-archive/capture-contract";

export const BACKFILL_REQUEST_SCHEMA_VERSION =
	"market-data-vendor-backfill-request/v1" as const;
export const BACKFILL_RESULT_SCHEMA_VERSION =
	"market-data-vendor-backfill-result/v1" as const;
export const BACKFILL_PROMOTION_SCHEMA_VERSION =
	"market-data-vendor-backfill-promotion-receipt/v1" as const;
export const EXTERNAL_BACKFILL_SOURCE = "external_backfill" as const;
export const HISTORICAL_VENDOR_SOURCE_MODE =
	"historical_vendor_orderbook_v1" as const;
export const VENDOR_DATASET_RAW_CAPTURE_SCOPE =
	"vendor_normalized_dataset_file" as const;

const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestampMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const backfillRequestSchema = z
	.object({
		schemaVersion: z.literal(BACKFILL_REQUEST_SCHEMA_VERSION),
		requestId: nonEmpty,
		idempotencyKey: sha256,
		providerPolicy: z
			.object({
				provider: z.literal("cryptohftdata"),
				allowedAdapterVersions: z.array(nonEmpty).min(1).max(16),
			})
			.strict(),
		scope: z
			.object({
				exchange: nonEmpty,
				tradingPair: nonEmpty,
				sourceSymbol: nonEmpty,
				marketType: z.enum(["spot", "swap", "future"]),
				feed: z.literal("ORDERBOOK"),
			})
			.strict(),
		window: z
			.object({ startTimeMs: timestampMs, endTimeMs: timestampMs })
			.strict()
			.refine(({ startTimeMs, endTimeMs }) => endTimeMs > startTimeMs, {
				message: "endTimeMs must be greater than startTimeMs",
			}),
		depth: z.number().int().min(1).max(500),
		constructionMode: z.enum([
			"sampled_top_n_snapshot",
			"exact_l2_reconstruction",
		]),
		requiredClockTargetsMs: z.array(timestampMs).min(1).max(100_000),
		maxPriorAsOfLagMs: z.number().int().nonnegative().max(86_400_000),
		sourcePolicy: z.enum(["authoritative_window", "fill_gaps"]),
		budgets: z
			.object({
				maxFiles: z.number().int().min(1).max(10_000),
				maxBytes: z
					.number()
					.int()
					.min(1)
					.max(100 * 1024 * 1024 * 1024),
				maxRows: z.number().int().min(1).max(1_000_000_000),
				maxDurationMs: z
					.number()
					.int()
					.min(1)
					.max(24 * 60 * 60 * 1_000),
				maxBoundaryLookbackMs: z
					.number()
					.int()
					.nonnegative()
					.max(7 * 24 * 60 * 60 * 1_000),
			})
			.strict(),
		expectedProduct: z
			.object({
				packageName: z.literal("@usherlabs/cex-broker"),
				packageVersion: nonEmpty.optional(),
				canonicalSchemaVersion: nonEmpty,
				checksumAlgorithm: z.literal("sha256-canonical-json-v1"),
			})
			.strict(),
	})
	.strict()
	.superRefine((request, context) => {
		const targets = request.requiredClockTargetsMs;
		for (let index = 0; index < targets.length; index += 1) {
			const target = targets[index] as number;
			if (
				target < request.window.startTimeMs ||
				target >= request.window.endTimeMs
			) {
				context.addIssue({
					code: "custom",
					path: ["requiredClockTargetsMs", index],
					message: "clock target must be inside the half-open request window",
				});
			}
			if (index > 0 && target <= (targets[index - 1] as number)) {
				context.addIssue({
					code: "custom",
					path: ["requiredClockTargetsMs", index],
					message: "clock targets must be strictly increasing",
				});
			}
		}
	});

export type MarketDataVendorBackfillRequest = z.infer<
	typeof backfillRequestSchema
>;

type IdempotencyBusinessFields = Omit<
	MarketDataVendorBackfillRequest,
	"requestId" | "idempotencyKey"
>;

export function backfillBusinessFields(
	request: Omit<MarketDataVendorBackfillRequest, "idempotencyKey"> & {
		idempotencyKey?: string;
	},
): IdempotencyBusinessFields {
	const {
		requestId: _requestId,
		idempotencyKey: _idempotencyKey,
		...business
	} = request;
	return business;
}

export function createBackfillIdempotencyKey(
	request: Omit<MarketDataVendorBackfillRequest, "idempotencyKey"> & {
		idempotencyKey?: string;
	},
): string {
	return sha256Canonical(backfillBusinessFields(request));
}

export function parseBackfillRequest(
	value: unknown,
): MarketDataVendorBackfillRequest {
	const request = backfillRequestSchema.parse(value);
	if (createBackfillIdempotencyKey(request) !== request.idempotencyKey) {
		throw new Error("idempotencyKey does not match canonical business fields");
	}
	return request;
}

export const BACKFILL_STATUSES = [
	"already_covered",
	"promoted",
	"capability_unsupported",
	"credentials_missing",
	"vendor_fetch_failed",
	"archive_ingest_failed",
	"promotion_verification_failed",
	"post_backfill_coverage_insufficient",
] as const;

export type BackfillStatus = (typeof BACKFILL_STATUSES)[number];

export type ProviderCapability = {
	provider: "cryptohftdata";
	adapterVersion: string;
	providerExchangeId: string;
	resolvedSymbol: string;
};

export type ProviderObjectEvidence = {
	identity: string;
	checksum: string;
	bytes: number;
	rows: number;
};

const providerObjectEvidenceSchema = z
	.object({
		identity: nonEmpty,
		checksum: sha256,
		bytes: z.number().int().nonnegative(),
		rows: z.number().int().nonnegative(),
	})
	.strict();

export type BackfillArchiveRow = {
	table:
		| "market_data.cex_order_book_levels"
		| "market_data.cex_order_book_depth_summary"
		| "market_data.cex_order_book_capture_promotions";
	row: Record<string, unknown>;
};

export type ForwarderBatch = {
	source: typeof EXTERNAL_BACKFILL_SOURCE;
	deployment_id: string;
	batch_id: string;
	rows: BackfillArchiveRow[];
};

export type PromotionReceipt = {
	schemaVersion: typeof BACKFILL_PROMOTION_SCHEMA_VERSION;
	receiptId: string;
	requestId: string;
	idempotencyKey: string;
	status: "passing";
	source: typeof EXTERNAL_BACKFILL_SOURCE;
	provider: "cryptohftdata";
	adapterVersion: string;
	captureBundleId: string;
	exchange: string;
	tradingPair: string;
	marketType: "spot" | "swap" | "future";
	feed: "ORDERBOOK";
	startTimeMs: number;
	endTimeMs: number;
	depth: number;
	constructionMode: "sampled_top_n_snapshot" | "exact_l2_reconstruction";
	canonicalSchemaVersion: string;
	checksumAlgorithm: "sha256-canonical-json-v1";
	vendorSemanticDigest: string;
	canonicalSemanticDigest: string;
	prefixDigest: string;
	suffixDigest: string;
	seamVerified: true;
	coverageVerified: true;
	datasetObjects: ProviderObjectEvidence[];
	verificationTimeMs: number;
};

export const promotionReceiptSchema: z.ZodType<PromotionReceipt> = z
	.object({
		schemaVersion: z.literal(BACKFILL_PROMOTION_SCHEMA_VERSION),
		receiptId: sha256,
		requestId: nonEmpty,
		idempotencyKey: sha256,
		status: z.literal("passing"),
		source: z.literal(EXTERNAL_BACKFILL_SOURCE),
		provider: z.literal("cryptohftdata"),
		adapterVersion: nonEmpty,
		captureBundleId: sha256,
		exchange: nonEmpty,
		tradingPair: nonEmpty,
		marketType: z.enum(["spot", "swap", "future"]),
		feed: z.literal("ORDERBOOK"),
		startTimeMs: timestampMs,
		endTimeMs: timestampMs,
		depth: z.number().int().min(1).max(500),
		constructionMode: z.enum([
			"sampled_top_n_snapshot",
			"exact_l2_reconstruction",
		]),
		canonicalSchemaVersion: nonEmpty,
		checksumAlgorithm: z.literal("sha256-canonical-json-v1"),
		vendorSemanticDigest: sha256,
		canonicalSemanticDigest: sha256,
		prefixDigest: sha256,
		suffixDigest: sha256,
		seamVerified: z.literal(true),
		coverageVerified: z.literal(true),
		datasetObjects: z.array(providerObjectEvidenceSchema).min(1).max(10_000),
		verificationTimeMs: timestampMs,
	})
	.strict()
	.refine(({ endTimeMs, startTimeMs }) => endTimeMs > startTimeMs, {
		message: "promotion window must be increasing",
	});

export type BackfillResult = {
	schemaVersion: typeof BACKFILL_RESULT_SCHEMA_VERSION;
	requestId: string;
	idempotencyKey?: string;
	status: BackfillStatus;
	reasonCode: string;
	receipt?: PromotionReceipt;
	diagnostics?: Record<string, string | number | boolean>;
};
