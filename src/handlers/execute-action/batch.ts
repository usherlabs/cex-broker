import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { redactSecretLiterals } from "../../helpers/broker-execution-archive/redact";
import {
	type Action as ActionType,
	getActionName,
	resolveAction,
} from "../../helpers/constants";
import { resolveGrpcError } from "../../helpers/grpc/status";
import { sanitizeErrorDetail } from "../../helpers/shared/errors";
import { exchangeSecretLiterals } from "../../helpers/venue-evidence";
import {
	type BatchResponseEntry,
	BatchResponseEnvelopeSchema,
} from "../../schemas/action-evidence";
import {
	type BatchChildRequest,
	BatchPayloadSchema,
	MAX_BATCH_REQUEST_BYTES,
} from "../../schemas/action-payloads";
import type { ActionRequest, ActionResponse } from "../types";
import {
	type ActionDescriptor,
	type ExecuteActionContext,
	parsePayloadForAction,
} from "./context";

const FORBIDDEN_ROUTING_KEYS = new Set([
	"account",
	"accountid",
	"accountselector",
	"apikey",
	"apisecret",
	"auth",
	"authorization",
	"cex",
	"credential",
	"credentials",
	"exchange",
	"metadata",
	"password",
	"secret",
	"signature",
	"usesecondarykey",
]);

function normalizeRoutingKey(key: string): string {
	return key.replace(/[-_]/g, "").toLowerCase();
}

function hasForbiddenRoutingKey(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some(hasForbiddenRoutingKey);
	}
	if (value === null || typeof value !== "object") {
		return false;
	}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_ROUTING_KEYS.has(normalizeRoutingKey(key))) {
			return true;
		}
		if (hasForbiddenRoutingKey(entry)) {
			return true;
		}
	}
	return false;
}

function childContainsRoutingOverride(child: BatchChildRequest): boolean {
	for (const [key, value] of Object.entries(child.payload)) {
		if (FORBIDDEN_ROUTING_KEYS.has(normalizeRoutingKey(key))) {
			return true;
		}
		try {
			if (hasForbiddenRoutingKey(JSON.parse(value))) {
				return true;
			}
		} catch {
			// Ordinary payload strings are not required to contain JSON.
		}
	}
	return false;
}

function stableBatchErrorCode(message: string, grpcStatus: number): string {
	const prefix = message.match(/^([A-Za-z][A-Za-z0-9_]*):/)?.[1];
	if (prefix) {
		return prefix;
	}
	return grpc.status[grpcStatus] ?? "UNKNOWN";
}

function batchErrorEntry(
	child: BatchChildRequest,
	error: unknown,
	broker: Exchange,
): BatchResponseEntry {
	const resolved = resolveGrpcError(error);
	const errorRecord =
		error !== null && typeof error === "object"
			? (error as { code?: unknown; message?: unknown })
			: undefined;
	const grpcStatus =
		typeof errorRecord?.code === "number" ? errorRecord.code : resolved.code;
	const rawMessage =
		typeof errorRecord?.message === "string"
			? errorRecord.message
			: resolved.message;
	const sanitizedMessage = redactSecretLiterals(
		sanitizeErrorDetail(rawMessage),
		exchangeSecretLiterals(broker),
	);
	return {
		id: child.id,
		action: child.action,
		symbol: child.symbol,
		response: null,
		error: {
			code: stableBatchErrorCode(rawMessage, grpcStatus),
			grpcStatus,
			message: sanitizedMessage,
		},
	};
}

function childCall(
	ctx: ExecuteActionContext,
	request: ActionRequest,
): ExecuteActionContext["call"] {
	return {
		...ctx.call,
		request,
	} as ExecuteActionContext["call"];
}

async function executeChild(
	ctx: ExecuteActionContext,
	child: BatchChildRequest,
	descriptor: ActionDescriptor,
): Promise<BatchResponseEntry> {
	const action = resolveAction(child.action);
	if (action === undefined) {
		return batchErrorEntry(
			child,
			new Error(`ValidationError: invalid action ${child.action}`),
			ctx.broker,
		);
	}
	const proofState = { proof: "" };
	let completion:
		| {
				error: Parameters<grpc.sendUnaryData<ActionResponse>>[0];
				response: ActionResponse | null;
		  }
		| undefined;
	const localCallback: grpc.sendUnaryData<ActionResponse> = (
		error,
		response,
	) => {
		if (completion === undefined) {
			completion = { error, response: response ?? null };
		}
	};
	const request: ActionRequest = {
		action,
		cex: ctx.cex,
		symbol: child.symbol,
		payload: child.payload,
	};
	const childContext: ExecuteActionContext = {
		...ctx,
		call: childCall(ctx, request),
		wrappedCallback: localCallback,
		action,
		symbol: child.symbol,
		verity: proofState,
		applyVerityToBroker: (target) =>
			ctx.applyVerityToBroker(target, proofState),
	};

	try {
		childContext.applyVerityToBroker(ctx.broker);
		await descriptor.handler(childContext);
	} catch (error) {
		completion ??= {
			error: resolveGrpcError(error),
			response: null,
		};
	}

	if (completion === undefined) {
		return batchErrorEntry(
			child,
			new Error(
				`INTERNAL: ${getActionName(action)} completed without a callback`,
			),
			ctx.broker,
		);
	}
	if (completion.error || !completion.response) {
		return batchErrorEntry(
			child,
			completion.error ?? new Error("INTERNAL: child returned no response"),
			ctx.broker,
		);
	}
	return {
		id: child.id,
		action: child.action,
		symbol: child.symbol,
		response: {
			result: completion.response.result,
			proof: completion.response.proof ?? proofState.proof,
		},
		error: null,
	};
}

export type ActionDescriptorLookup = (
	action: ActionType,
) => ActionDescriptor | undefined;

export async function handleBatch(
	ctx: ExecuteActionContext,
	lookupDescriptor: ActionDescriptorLookup,
): Promise<void> {
	if (ctx.symbol?.trim()) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: "ValidationError: Batch symbol must be empty",
			},
			null,
		);
	}
	const encodedRequests = ctx.call.request.payload?.requests;
	if (
		typeof encodedRequests === "string" &&
		Buffer.byteLength(encodedRequests, "utf8") > MAX_BATCH_REQUEST_BYTES
	) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `ValidationError: Batch requests exceed ${MAX_BATCH_REQUEST_BYTES} bytes`,
			},
			null,
		);
	}
	const payload = parsePayloadForAction(ctx, BatchPayloadSchema);
	if (payload === null) {
		return;
	}

	const seenIds = new Set<string>();
	const prepared: Array<{
		child: BatchChildRequest;
		descriptor: ActionDescriptor;
	}> = [];
	for (const child of payload.requests) {
		if (seenIds.has(child.id)) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: `ValidationError: duplicate batch child id '${child.id}'`,
				},
				null,
			);
		}
		seenIds.add(child.id);
		if (childContainsRoutingOverride(child)) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: `ValidationError: batch child '${child.id}' contains a routing override`,
				},
				null,
			);
		}
		const action = resolveAction(child.action);
		const descriptor =
			action === undefined ? undefined : lookupDescriptor(action);
		if (!descriptor || descriptor.access !== "read" || !descriptor.batchable) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: `ValidationError: batch child '${child.id}' action ${child.action} is not batchable`,
				},
				null,
			);
		}
		const validation = descriptor.validateBatchRequest?.({
			action,
			cex: ctx.cex,
			symbol: child.symbol,
			payload: child.payload,
		});
		if (validation && !validation.valid) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: `ValidationError: batch child '${child.id}': ${validation.message}`,
				},
				null,
			);
		}
		prepared.push({ child, descriptor });
	}

	const responses: BatchResponseEntry[] = [];
	for (const { child, descriptor } of prepared) {
		const response = await executeChild(ctx, child, descriptor);
		responses.push(response);
		ctx.otelMetrics?.recordCounter("execute_action_batch_items_total", 1, {
			action: getActionName(child.action),
			cex: ctx.normalizedCex,
			outcome: response.error ? "error" : "success",
		});
	}

	const envelope = BatchResponseEnvelopeSchema.parse({
		schemaVersion: "cex-broker-action-batch/v1",
		responses,
	});
	ctx.wrappedCallback(null, {
		result: JSON.stringify(envelope),
		proof: "",
	});
}
