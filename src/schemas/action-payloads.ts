import { z } from "zod";

type JsonPreprocessResult =
	| object
	| string
	| number
	| boolean
	| null
	| undefined;

const parseJsonString = (value: unknown): JsonPreprocessResult => {
	if (typeof value !== "string") {
		if (
			value === null ||
			value === undefined ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			typeof value === "object"
		) {
			return value;
		}
		return String(value);
	}
	try {
		return JSON.parse(value) as JsonPreprocessResult;
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
	orderAuthor: z.string().min(1).optional(),
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

export const InternalTransferPayloadSchema = z.object({
	amount: z.coerce.number().positive(),
	fromAccount: z.string().min(1).optional(),
	toAccount: z.string().min(1).optional(),
});

const marketTypeSchema = z
	.enum(["spot", "swap", "perp", "future", "futures"])
	.optional();

const unknownParamsSchema = z.preprocess(
	parseJsonString,
	z.record(z.string(), z.unknown()),
);

export const CreateOrderPayloadSchema = z.object({
	orderType: z.enum(["market", "limit"]).default("limit"),
	orderIntent: z.enum(["passive_only"]).optional(),
	amount: z.coerce.number().positive(),
	fromToken: z.string().min(1),
	toToken: z.string().min(1),
	price: z.coerce.number().positive(),
	marketType: marketTypeSchema,
	clientOrderId: z.string().min(1).optional(),
	orderAuthor: z.string().min(1).optional(),
	params: z.preprocess(parseJsonString, stringNumberRecordSchema).default({}),
});

export const GetPerpConfigStatePayloadSchema = z.object({
	symbol: z.string().min(1).optional(),
	params: unknownParamsSchema.default({}),
});

export const SetPerpConfigStatePayloadSchema = z.object({
	symbol: z.string().min(1),
	leverage: z.coerce.number().positive(),
	marginMode: z.enum(["cross", "isolated"]).optional(),
	params: unknownParamsSchema.default({}),
});

export const GetOrderDetailsPayloadSchema = z.object({
	orderId: z.string().min(1),
	params: z.preprocess(parseJsonString, stringNumberRecordSchema).default({}),
});

export const CancelOrderPayloadSchema = z.object({
	orderId: z.string().min(1),
	params: z.preprocess(parseJsonString, stringNumberRecordSchema).default({}),
});

export const EmptyActionPayloadSchema = z.object({}).strict();

export const FetchFeesPayloadSchema = EmptyActionPayloadSchema;

export const FetchCurrencyPayloadSchema = z
	.object({
		network: z.string().trim().min(1),
	})
	.strict();

export const MAX_BATCH_CHILDREN = 32;
export const MAX_BATCH_REQUEST_BYTES = 256 * 1024;

export const BatchChildRequestSchema = z
	.object({
		id: z.string().trim().min(1),
		action: z.number().int().nonnegative(),
		symbol: z.string(),
		payload: z.record(z.string(), z.string()),
	})
	.strict();

export const BatchPayloadSchema = z
	.object({
		requests: z.preprocess(
			parseJsonString,
			z.array(BatchChildRequestSchema).min(1).max(MAX_BATCH_CHILDREN),
		),
	})
	.strict();

export type DepositPayload = z.infer<typeof DepositPayloadSchema>;
export type CallPayload = z.infer<typeof CallPayloadSchema>;
export type FetchDepositAddressesPayload = z.infer<
	typeof FetchDepositAddressesPayloadSchema
>;
export type WithdrawPayload = z.infer<typeof WithdrawPayloadSchema>;
export type InternalTransferPayload = z.infer<
	typeof InternalTransferPayloadSchema
>;
export type CreateOrderPayload = z.infer<typeof CreateOrderPayloadSchema>;
export type GetPerpConfigStatePayload = z.infer<
	typeof GetPerpConfigStatePayloadSchema
>;
export type SetPerpConfigStatePayload = z.infer<
	typeof SetPerpConfigStatePayloadSchema
>;
export type GetOrderDetailsPayload = z.infer<
	typeof GetOrderDetailsPayloadSchema
>;
export type CancelOrderPayload = z.infer<typeof CancelOrderPayloadSchema>;
export type FetchFeesPayload = z.infer<typeof FetchFeesPayloadSchema>;
export type FetchCurrencyPayload = z.infer<typeof FetchCurrencyPayloadSchema>;
export type BatchChildRequest = z.infer<typeof BatchChildRequestSchema>;
export type BatchPayload = z.infer<typeof BatchPayloadSchema>;
