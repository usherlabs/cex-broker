import { sha256Canonical } from "../market-data-archive/capture-contract";
import {
	type BackfillArchiveRow,
	type PromotionReceipt,
	type PromotionReceiptWire,
	promotionIdentitySha256,
	promotionReceiptCodec,
	promotionReceiptSchema,
} from "./contracts";
import { documentSha256, jcsCanonicalize } from "./identity";

export type StablePromotionReceipt = Omit<
	PromotionReceipt,
	"receiptId" | "verificationTimeMs"
>;

export function promotionReceiptId(receipt: StablePromotionReceipt): string {
	return sha256Canonical(receipt);
}

function finalizeLegacyPromotionReceipt(
	stable: StablePromotionReceipt,
	verificationTimeMs: number,
): PromotionReceipt {
	return promotionReceiptSchema.parse({
		...stable,
		receiptId: promotionReceiptId(stable),
		verificationTimeMs,
	});
}

type UnfinalizedPromotionReceiptWire = Omit<
	PromotionReceiptWire,
	"receipt_id" | "promotion_identity_sha256"
> &
	Partial<
		Pick<PromotionReceiptWire, "receipt_id" | "promotion_identity_sha256">
	>;

export function finalizePromotionReceipt(
	receipt: UnfinalizedPromotionReceiptWire,
): PromotionReceiptWire;
export function finalizePromotionReceipt(
	receipt: StablePromotionReceipt,
	verificationTimeMs: number,
): PromotionReceipt;
export function finalizePromotionReceipt(
	receipt: UnfinalizedPromotionReceiptWire | StablePromotionReceipt,
	verificationTimeMs?: number,
): PromotionReceiptWire | PromotionReceipt {
	if ("schema_id" in receipt) {
		const {
			receipt_id: _receiptId,
			promotion_identity_sha256: _promotionIdentity,
			...semanticAndTimestamp
		} = receipt;
		const promotion_identity_sha256 =
			promotionIdentitySha256(semanticAndTimestamp);
		const content = { ...semanticAndTimestamp, promotion_identity_sha256 };
		return promotionReceiptCodec.decode({
			...content,
			receipt_id: documentSha256(content, "receipt_id"),
		});
	}
	if (verificationTimeMs === undefined) {
		throw new TypeError("legacy promotion receipt requires verificationTimeMs");
	}
	return finalizeLegacyPromotionReceipt(receipt, verificationTimeMs);
}

export function promotionReceiptToArchiveRow(
	receiptInput: PromotionReceipt | PromotionReceiptWire,
): BackfillArchiveRow {
	if ("schema_id" in receiptInput) {
		const receipt = promotionReceiptCodec.decode(receiptInput);
		return {
			table: "market_data.cex_order_book_capture_promotions",
			row: {
				source: receipt.source,
				capture_origin: receipt.capture_origin,
				source_mode: receipt.source_mode,
				deployment_id: "market-data-vendor-backfill",
				receipt_schema_version: receipt.schema_id,
				receipt_id: receipt.receipt_id,
				promotion_identity_sha256: receipt.promotion_identity_sha256,
				request_id: receipt.request_id,
				idempotency_key: receipt.idempotency_key,
				status: "passing",
				capture_bundle_id: receipt.capture_bundle_id,
				provider: receipt.provider,
				adapter_version: receipt.adapter_version,
				exchange: receipt.scope.exchange,
				trading_pair: receipt.scope.trading_pair,
				asset_type: receipt.scope.market_type,
				feed: receipt.scope.feed,
				window_start_ms: Date.parse(receipt.window.start_at),
				window_end_ms: Date.parse(receipt.window.end_at),
				depth_limit: receipt.depth,
				construction_mode: receipt.construction_mode,
				schema_version: "1.0.0",
				canonical_schema_sha256: receipt.canonical_schema.schema_sha256,
				checksum_algorithm: "sha256-canonical-json-v1",
				coverage_policy_json: jcsCanonicalize(receipt.coverage_policy),
				selection_sha256: receipt.selection_sha256,
				capability_policy_id:
					receipt.effective_policies.capability_policy.policy_id,
				capability_policy_sha256:
					receipt.effective_policies.capability_policy.policy_sha256,
				resource_policy_id:
					receipt.effective_policies.resource_policy.policy_id,
				resource_policy_sha256:
					receipt.effective_policies.resource_policy.policy_sha256,
				adapter_policy_id: receipt.effective_policies.adapter_policy.policy_id,
				adapter_policy_sha256:
					receipt.effective_policies.adapter_policy.policy_sha256,
				acquisition_policy_id:
					receipt.effective_policies.acquisition_policy.policy_id,
				acquisition_policy_sha256:
					receipt.effective_policies.acquisition_policy.policy_sha256,
				vendor_semantic_digest: receipt.vendor_semantic_digest,
				canonical_semantic_digest: receipt.canonical_semantic_digest,
				prefix_digest: receipt.prefix_digest,
				suffix_digest: receipt.suffix_digest,
				seam_verified: 1,
				coverage_verified: 1,
				dataset_objects_json: jcsCanonicalize(receipt.dataset_objects),
				receipt_json: jcsCanonicalize(receipt),
				verification_time_ms: Date.parse(receipt.verified_at),
			},
		};
	}
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
): PromotionReceipt | PromotionReceiptWire {
	if (typeof row.receipt_json === "string" && row.receipt_json.length > 0) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.receipt_json);
		} catch {
			throw new Error("promotion receipt_json is invalid");
		}
		const receipt = promotionReceiptCodec.decode(parsed);
		if (
			receipt.receipt_id !== row.receipt_id ||
			receipt.promotion_identity_sha256 !== row.promotion_identity_sha256
		) {
			throw new Error("promotion receipt archive identity mismatch");
		}
		return receipt;
	}
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
