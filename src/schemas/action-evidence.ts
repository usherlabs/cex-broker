import { z } from "zod";

export const EVIDENCE_DIGEST_ALGORITHM = "sha256-canonical-json-v1" as const;

export const CanonicalDecimalStringSchema = z
	.string()
	.regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/);

const accountScopeShape = {
	accountSelector: z.string().min(1),
	credentialSource: z.enum(["configured_pool", "request_metadata"]),
};

const evidenceSourceShape = {
	observedAt: z.string().datetime({ offset: true }),
	digestAlgorithm: z.literal(EVIDENCE_DIGEST_ALGORITHM),
	sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
};

export const TradingFeeEvidenceSchema = z
	.object({
		schemaVersion: z.literal("cex-trading-fee-evidence/v1"),
		exchange: z.string().min(1),
		marketType: z.literal("spot"),
		canonicalPair: z.string().regex(/^[^-\s]+-[^-\s]+$/),
		unifiedSymbol: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
		sourceSymbol: z.string().min(1),
		...accountScopeShape,
		...evidenceSourceShape,
		sourceMethod: z.literal("ccxt.fetchTradingFee"),
		makerRate: CanonicalDecimalStringSchema,
		takerRate: CanonicalDecimalStringSchema,
		rateUnit: z.literal("decimal_fraction"),
		makerBasisPoints: CanonicalDecimalStringSchema,
		takerBasisPoints: CanonicalDecimalStringSchema,
		basisPointsUnit: z.literal("basis_points"),
	})
	.strict();

export const MarketRuleEvidenceSchema = z
	.object({
		schemaVersion: z.literal("cex-market-rule-evidence/v1"),
		exchange: z.string().min(1),
		marketType: z.literal("spot"),
		canonicalPair: z.string().regex(/^[^-\s]+-[^-\s]+$/),
		unifiedSymbol: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
		sourceSymbol: z.string().min(1),
		baseAsset: z.string().min(1),
		quoteAsset: z.string().min(1),
		active: z.literal(true),
		precisionMode: z.union([z.string().min(1), z.number().int()]),
		priceIncrement: CanonicalDecimalStringSchema,
		amountIncrement: CanonicalDecimalStringSchema,
		minimumAmount: CanonicalDecimalStringSchema,
		minimumNotional: CanonicalDecimalStringSchema,
		maximumAmount: CanonicalDecimalStringSchema.optional(),
		maximumPrice: CanonicalDecimalStringSchema.optional(),
		maximumNotional: CanonicalDecimalStringSchema.optional(),
		...accountScopeShape,
		...evidenceSourceShape,
		sourceMethod: z.literal("ccxt.loadMarkets"),
	})
	.strict();

export const TransferNetworkEvidenceSchema = z
	.object({
		schemaVersion: z.literal("cex-transfer-network-evidence/v1"),
		exchange: z.string().min(1),
		asset: z.string().min(1),
		operatorNetworkAlias: z.string().min(1),
		brokerNetworkId: z.string().min(1),
		exchangeNetworkId: z.string().min(1),
		depositAvailable: z.boolean(),
		withdrawalAvailable: z.boolean(),
		withdrawalFee: CanonicalDecimalStringSchema.nullable(),
		withdrawalLimits: z
			.object({
				minimum: CanonicalDecimalStringSchema.nullable(),
				maximum: CanonicalDecimalStringSchema.nullable(),
			})
			.strict(),
		...accountScopeShape,
		...evidenceSourceShape,
		sourceMethod: z.literal("ccxt.fetchCurrencies"),
	})
	.strict();

const BatchSuccessEntrySchema = z
	.object({
		id: z.string().min(1),
		action: z.number().int().nonnegative(),
		symbol: z.string(),
		response: z
			.object({
				result: z.string(),
				proof: z.string(),
			})
			.strict(),
		error: z.null(),
	})
	.strict();

const BatchErrorEntrySchema = z
	.object({
		id: z.string().min(1),
		action: z.number().int().nonnegative(),
		symbol: z.string(),
		response: z.null(),
		error: z
			.object({
				code: z.string().min(1),
				grpcStatus: z.number().int().nonnegative(),
				message: z.string(),
			})
			.strict(),
	})
	.strict();

export const BatchResponseEntrySchema = z.union([
	BatchSuccessEntrySchema,
	BatchErrorEntrySchema,
]);

export const BatchResponseEnvelopeSchema = z
	.object({
		schemaVersion: z.literal("cex-broker-action-batch/v1"),
		responses: z.array(BatchResponseEntrySchema).max(32),
	})
	.strict();

export type TradingFeeEvidence = z.infer<typeof TradingFeeEvidenceSchema>;
export type MarketRuleEvidence = z.infer<typeof MarketRuleEvidenceSchema>;
export type TransferNetworkEvidence = z.infer<
	typeof TransferNetworkEvidenceSchema
>;
export type BatchResponseEntry = z.infer<typeof BatchResponseEntrySchema>;
export type BatchResponseEnvelope = z.infer<typeof BatchResponseEnvelopeSchema>;
