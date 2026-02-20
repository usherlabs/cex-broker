import { z } from "zod";

const parseJsonString = (value: unknown): unknown => {
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

const stringNumberRecordSchema = z.record(
	z.string(),
	z.union([z.string(), z.number()]),
);

export const DepositPayloadSchema = z.object({
	recipientAddress: z.string().min(1),
	amount: z.coerce.number().positive(),
	transactionHash: z.string().min(1),
	since: z.coerce.number().optional(),
	params: z.preprocess(parseJsonString, stringNumberRecordSchema).default({}),
});

export const CallPayloadSchema = z.object({
	functionName: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
	args: z.preprocess(parseJsonString, z.array(z.unknown())).default([]),
	params: z
		.preprocess(parseJsonString, z.record(z.string(), z.unknown()))
		.default({}),
});

export const FetchDepositAddressesPayloadSchema = z.object({
	chain: z.string().min(1),
	params: z
		.preprocess(parseJsonString, z.record(z.string(), z.string()))
		.default({}),
});

export const WithdrawPayloadSchema = z.object({
	recipientAddress: z.string().min(1),
	amount: z.coerce.number().positive(),
	chain: z.string().min(1),
	params: z.preprocess(parseJsonString, stringNumberRecordSchema).default({}),
});

export const CreateOrderPayloadSchema = z.object({
	orderType: z.enum(["market", "limit"]).default("limit"),
	amount: z.coerce.number().positive(),
	fromToken: z.string().min(1),
	toToken: z.string().min(1),
	price: z.coerce.number().positive(),
	params: z.preprocess(parseJsonString, stringNumberRecordSchema).default({}),
});

export const GetOrderDetailsPayloadSchema = z.object({
	orderId: z.string().min(1),
	params: z.preprocess(parseJsonString, stringNumberRecordSchema).default({}),
});

export const CancelOrderPayloadSchema = z.object({
	orderId: z.string().min(1),
	params: z.preprocess(parseJsonString, stringNumberRecordSchema).default({}),
});

const booleanLikeSchema = z.preprocess((value: unknown) => {
	if (typeof value !== "string") {
		return value;
	}
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "yes"].includes(normalized)) {
		return true;
	}
	if (["false", "0", "no"].includes(normalized)) {
		return false;
	}
	return value;
}, z.boolean());

export const FetchFeesPayloadSchema = z.object({
	includeAllFees: booleanLikeSchema.optional().default(false),
	includeFundingFees: booleanLikeSchema.optional(),
});

export type DepositPayload = z.infer<typeof DepositPayloadSchema>;
export type CallPayload = z.infer<typeof CallPayloadSchema>;
export type FetchDepositAddressesPayload = z.infer<
	typeof FetchDepositAddressesPayloadSchema
>;
export type WithdrawPayload = z.infer<typeof WithdrawPayloadSchema>;
export type CreateOrderPayload = z.infer<typeof CreateOrderPayloadSchema>;
export type GetOrderDetailsPayload = z.infer<
	typeof GetOrderDetailsPayloadSchema
>;
export type CancelOrderPayload = z.infer<typeof CancelOrderPayloadSchema>;
export type FetchFeesPayload = z.infer<typeof FetchFeesPayloadSchema>;
