import type * as grpc from "@grpc/grpc-js";
import type { Metadata } from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import type { z } from "zod";
import type { BrokerAccount, BrokerPoolEntry } from "../../helpers";
import type {
	BrokerExecutionArchiver,
	WithdrawalObservationTracker,
} from "../../helpers/broker-execution-archive";
import type { Action as ActionType } from "../../helpers/constants";
import {
	invalidArgumentError,
	parseActionPayload,
} from "../../helpers/grpc/callbacks";
import {
	resolveGrpcError,
	stableGrpcErrorCode,
} from "../../helpers/grpc/status";
import type { OrderActivityTracker } from "../../helpers/order-activity-tracker";
import type { OtelMetrics } from "../../helpers/otel";
import { errorClassName, getErrorMessage } from "../../helpers/shared/errors";
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
	otelMetrics?: OtelMetrics;
	brokerArchiver?: BrokerExecutionArchiver;
	orderActivityTracker?: OrderActivityTracker;
	withdrawalObservationTracker: WithdrawalObservationTracker;
};

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
		/** Append the caught error's class name (e.g. InsufficientFunds) as a
		 * suffix. It goes last, not in front, because the gRPC status code is
		 * derived from the raw message via stableGrpcErrorCode; prepending the
		 * class name would break that prefix match. */
		appendClassName?: boolean;
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
	if (options?.appendClassName) {
		const className = errorClassName(error);
		if (className && !finalMessage.includes(className)) {
			finalMessage = `${finalMessage} (${className})`;
		}
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
