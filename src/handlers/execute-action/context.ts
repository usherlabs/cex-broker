import type * as grpc from "@grpc/grpc-js";
import type { Metadata } from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import type { z } from "zod";
import type { BrokerAccount, BrokerPoolEntry } from "../../helpers";
import type { BrokerExecutionArchiver } from "../../helpers/broker-execution-archive";
import type { BrokerSurface } from "../../helpers/broker-surface";
import {
	buildBrokerSurfaceDeniedError,
	isReadSurfaceEnabled,
	isWriteSurfaceEnabled,
} from "../../helpers/broker-surface";
import type { Action as ActionType } from "../../helpers/constants";
import {
	invalidArgumentError,
	parseActionPayload,
} from "../../helpers/grpc/callbacks";
import {
	resolveGrpcError,
	stableGrpcErrorCode,
} from "../../helpers/grpc/status";
import type { OtelMetrics } from "../../helpers/otel";
import { getErrorMessage } from "../../helpers/shared/errors";
import type { PolicyConfig } from "../../types";
import type { ActionRequest, ActionResponse } from "../types";

export type ActionHandler = (ctx: ExecuteActionContext) => Promise<void>;

export type ExecuteActionContext = {
	call: grpc.ServerUnaryCall<ActionRequest, ActionResponse>;
	wrappedCallback: grpc.sendUnaryData<ActionResponse>;
	action: ActionType;
	policy: PolicyConfig;
	brokers: Record<string, BrokerPoolEntry>;
	metadata: Metadata;
	normalizedCex: string;
	cex: string;
	symbol?: string;
	selectedBrokerAccount?: BrokerAccount;
	broker: Exchange;
	verity: { proof: string };
	applyVerityToBroker: (target: Exchange) => void;
	useVerity: boolean;
	verityProverUrl: string;
	brokerSurface: BrokerSurface;
	otelMetrics?: OtelMetrics;
	brokerArchiver?: BrokerExecutionArchiver;
};

export function rejectUnlessWriteSurface(ctx: ExecuteActionContext): boolean {
	if (!isWriteSurfaceEnabled(ctx.brokerSurface)) {
		ctx.wrappedCallback(buildBrokerSurfaceDeniedError("write"), null);
		return false;
	}
	return true;
}

export function rejectUnlessReadSurface(ctx: ExecuteActionContext): boolean {
	if (!isReadSurfaceEnabled(ctx.brokerSurface)) {
		ctx.wrappedCallback(buildBrokerSurfaceDeniedError("read"), null);
		return false;
	}
	return true;
}

export function requireSymbol(
	ctx: ExecuteActionContext,
	message = "ValidationError: Symbol required",
): ctx is ExecuteActionContext & { symbol: string } {
	if (!ctx.symbol) {
		ctx.wrappedCallback(invalidArgumentError(message), null);
		return false;
	}
	return true;
}

export function parsePayloadForAction<T>(
	ctx: ExecuteActionContext,
	schema: z.ZodType<T>,
): T | null {
	return parseActionPayload(
		schema,
		ctx.call.request.payload,
		ctx.wrappedCallback,
	);
}

export function rejectWithGrpcError(
	ctx: ExecuteActionContext,
	error: unknown,
	options?: {
		message?: string;
		prefix?: string;
		preferStableMessageOnly?: boolean;
	},
): void {
	const resolvedMessage = options?.message ?? getErrorMessage(error);
	const { code, message } = resolveGrpcError(error, resolvedMessage);
	let finalMessage: string;
	if (
		options?.preferStableMessageOnly &&
		stableGrpcErrorCode(resolvedMessage) !== undefined
	) {
		finalMessage = resolvedMessage;
	} else if (options?.prefix) {
		finalMessage = `${options.prefix}${message}`;
	} else {
		finalMessage = message;
	}
	ctx.wrappedCallback({ code, message: finalMessage }, null);
}

export function successWithProof(
	ctx: ExecuteActionContext,
	result: unknown,
): void {
	ctx.wrappedCallback(null, {
		proof: ctx.verity.proof,
		result: JSON.stringify(result),
	});
}
