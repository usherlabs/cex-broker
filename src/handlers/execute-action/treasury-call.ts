import * as grpc from "@grpc/grpc-js";
import { getErrorMessage, safeLogError } from "../../helpers/shared/errors";
import {
	callArgs,
	handleTreasuryDiscoveryCall,
} from "../../helpers/treasury-discovery";
import { CallPayloadSchema } from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import { parsePayloadForAction, rejectWithGrpcError } from "./context";

export async function handleTreasuryCall(
	ctx: ExecuteActionContext,
): Promise<void> {
	const { broker } = ctx;
	const callValue = parsePayloadForAction(ctx, CallPayloadSchema);
	if (callValue === null) return;
	try {
		// Prevent access to dangerous names
		if (
			callValue.functionName.startsWith("_") ||
			callValue.functionName.includes("constructor") ||
			callValue.functionName.includes("prototype")
		) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.PERMISSION_DENIED,
					message: "Access to the requested function is denied",
				},
				null,
			);
		}
		// Prepare arguments
		const argsArray = callArgs(callValue.args, callValue.params ?? {});
		const treasuryDiscovery = await handleTreasuryDiscoveryCall(
			broker,
			callValue.functionName,
			callValue.args,
			callValue.params ?? {},
		);
		if (treasuryDiscovery.handled) {
			return ctx.wrappedCallback(null, {
				proof: ctx.verity.proof,
				result: JSON.stringify(treasuryDiscovery.result),
			});
		}
		// Ensure function exists and is callable on the broker.
		const fn = (broker as unknown as Record<string, unknown>)[
			callValue.functionName
		];
		if (
			typeof fn !== "function" ||
			broker.has?.[callValue.functionName] === false
		) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: `Function not found on broker: ${callValue.functionName}`,
				},
				null,
			);
		}
		// Invoke
		// biome-ignore lint/suspicious/noExplicitAny: dynamic call required for generic broker methods
		const result = await (fn as any).apply(broker, argsArray);
		ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify(result),
		});
	} catch (error: unknown) {
		safeLogError("Call failed", error);
		rejectWithGrpcError(ctx, error, {
			message: getErrorMessage(error),
			preferStableMessageOnly: true,
			appendClassName: true,
		});
	}
}
