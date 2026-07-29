import * as grpc from "@grpc/grpc-js";
import {
	archiveOrderExecutionInBackground,
	archiveWithdrawalObservationsInBackground,
	captureMarketMetadataSnapshot,
	rethrowArchiveDurabilityError,
} from "../../helpers/broker-execution-archive";
import {
	emitOrderExecutionTelemetryInBackground,
	extractOrderTelemetryIds,
	type OrderTelemetryContext,
} from "../../helpers/order-telemetry";
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
	let createOrderContext: OrderTelemetryContext | undefined;
	let marketMetadataHash: string | undefined;
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
		if (callValue.functionName === "createOrder") {
			const [symbol, orderType, side, quantity, price] = callValue.args;
			const requestedQuantity = asFiniteNumber(quantity);
			const requestedPrice = asFiniteNumber(price);
			const requestedNotional =
				requestedQuantity !== undefined && requestedPrice !== undefined
					? asFiniteNumber(requestedQuantity * requestedPrice)
					: undefined;
			const telemetryIds = extractOrderTelemetryIds(callValue.params);
			const submissionTimestamp = new Date().toISOString();
			createOrderContext = {
				action: "CreateOrder",
				cex: ctx.cex,
				accountLabel: ctx.selectedBrokerAccount?.label,
				symbol: asNonEmptyString(symbol),
				orderType: asNonEmptyString(orderType),
				side: asNonEmptyString(side),
				requestedQuantity,
				requestedNotional,
				orderAuthor: callValue.orderAuthor,
				brokerObservedTimestamp: submissionTimestamp,
				...telemetryIds,
			};
			if (createOrderContext.symbol !== undefined) {
				marketMetadataHash = await captureMarketMetadataSnapshot(
					ctx.brokerArchiver,
					broker,
					{
						exchange: ctx.cex,
						accountSelector: ctx.selectedBrokerAccount?.label,
						symbol: createOrderContext.symbol,
						action: "CreateOrder",
						brokerObservedTimestamp: submissionTimestamp,
						...telemetryIds,
					},
				);
			}
		}
		// Invoke
		// biome-ignore lint/suspicious/noExplicitAny: dynamic call required for generic broker methods
		const result = await (fn as any).apply(broker, argsArray);
		if (createOrderContext !== undefined) {
			emitOrderExecutionTelemetryInBackground(
				ctx.otelMetrics,
				createOrderContext,
				result,
			);
			archiveOrderExecutionInBackground(
				ctx.brokerArchiver,
				createOrderContext,
				result,
				undefined,
				{ marketMetadataHash },
			);
		} else if (callValue.functionName === "fetchWithdrawals") {
			archiveWithdrawalObservationsInBackground(
				ctx.brokerArchiver,
				ctx.withdrawalObservationTracker,
				{
					exchange: ctx.normalizedCex,
					accountSelector: ctx.selectedBrokerAccount?.label,
					transactions: result,
				},
			);
		}
		ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify(result),
		});
	} catch (error: unknown) {
		if (createOrderContext !== undefined) {
			rethrowArchiveDurabilityError(error);
			emitOrderExecutionTelemetryInBackground(
				ctx.otelMetrics,
				createOrderContext,
				undefined,
				error,
			);
			archiveOrderExecutionInBackground(
				ctx.brokerArchiver,
				createOrderContext,
				undefined,
				error,
				{ marketMetadataHash },
			);
		}
		safeLogError("Call failed", error);
		rejectWithGrpcError(ctx, error, {
			message: getErrorMessage(error),
			preferStableMessageOnly: true,
			appendClassName: true,
		});
	}
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value !== "string" || !value.trim()) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
