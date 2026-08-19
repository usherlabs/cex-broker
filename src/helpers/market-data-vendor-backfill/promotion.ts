import { sha256Canonical } from "../market-data-archive/capture-contract";
import {
	type BackfillArchiveRow,
	type PromotionReceipt,
	promotionReceiptSchema,
} from "./contracts";

export type StablePromotionReceipt = Omit<
	PromotionReceipt,
	"receiptId" | "verificationTimeMs"
>;

export function promotionReceiptId(receipt: StablePromotionReceipt): string {
	return sha256Canonical(receipt);
}

export function finalizePromotionReceipt(
	stable: StablePromotionReceipt,
	verificationTimeMs: number,
): PromotionReceipt {
	return promotionReceiptSchema.parse({
		...stable,
		receiptId: promotionReceiptId(stable),
		verificationTimeMs,
	});
}

export function promotionReceiptToArchiveRow(
	receiptInput: PromotionReceipt,
): BackfillArchiveRow {
	const receipt = promotionReceiptSchema.parse(receiptInput);
	if (
		promotionReceiptId(
			Object.fromEntries(
				Object.entries(receipt).filter(
					([key]) => key !== "receiptId" && key !== "verificationTimeMs",
				),
			) as StablePromotionReceipt,
		) !== receipt.receiptId
	) {
		throw new Error("promotion receipt identity mismatch");
	}
	return {
		table: "market_data.cex_order_book_capture_promotions",
		row: {
			source: receipt.source,
			deployment_id: "market-data-vendor-backfill",
			receipt_schema_version: receipt.schemaVersion,
			receipt_id: receipt.receiptId,
			request_id: receipt.requestId,
			idempotency_key: receipt.idempotencyKey,
			status: receipt.status,
			capture_bundle_id: receipt.captureBundleId,
			provider: receipt.provider,
			adapter_version: receipt.adapterVersion,
			exchange: receipt.exchange,
			trading_pair: receipt.tradingPair,
			asset_type: receipt.marketType,
			feed: receipt.feed,
			window_start_ms: receipt.startTimeMs,
			window_end_ms: receipt.endTimeMs,
			depth_limit: receipt.depth,
			construction_mode: receipt.constructionMode,
			schema_version: receipt.canonicalSchemaVersion,
			checksum_algorithm: receipt.checksumAlgorithm,
			vendor_semantic_digest: receipt.vendorSemanticDigest,
			canonical_semantic_digest: receipt.canonicalSemanticDigest,
			prefix_digest: receipt.prefixDigest,
			suffix_digest: receipt.suffixDigest,
			seam_verified: 1,
			coverage_verified: 1,
			dataset_objects_json: JSON.stringify(receipt.datasetObjects),
			verification_time_ms: receipt.verificationTimeMs,
		},
	};
}

export function promotionReceiptFromArchiveRow(
	row: Record<string, unknown>,
): PromotionReceipt {
	let datasetObjects: unknown;
	try {
		datasetObjects = JSON.parse(String(row.dataset_objects_json));
	} catch {
		throw new Error("promotion dataset_objects_json is invalid");
	}
	const receipt = promotionReceiptSchema.parse({
		schemaVersion: row.receipt_schema_version,
		receiptId: row.receipt_id,
		requestId: row.request_id,
		idempotencyKey: row.idempotency_key,
		status: row.status,
		source: row.source,
		provider: row.provider,
		adapterVersion: row.adapter_version,
		captureBundleId: row.capture_bundle_id,
		exchange: row.exchange,
		tradingPair: row.trading_pair,
		marketType: row.asset_type,
		feed: row.feed,
		startTimeMs: row.window_start_ms,
		endTimeMs: row.window_end_ms,
		depth: row.depth_limit,
		constructionMode: row.construction_mode,
		canonicalSchemaVersion: row.schema_version,
		checksumAlgorithm: row.checksum_algorithm,
		vendorSemanticDigest: row.vendor_semantic_digest,
		canonicalSemanticDigest: row.canonical_semantic_digest,
		prefixDigest: row.prefix_digest,
		suffixDigest: row.suffix_digest,
		seamVerified: row.seam_verified === 1,
		coverageVerified: row.coverage_verified === 1,
		datasetObjects,
		verificationTimeMs: row.verification_time_ms,
	});
	const {
		receiptId,
		verificationTimeMs: _verificationTimeMs,
		...stable
	} = receipt;
	if (promotionReceiptId(stable) !== receiptId) {
		throw new Error("promotion receipt identity mismatch");
	}
	return receipt;
}
