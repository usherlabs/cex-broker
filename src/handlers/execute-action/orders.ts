import * as grpc from "@grpc/grpc-js";
import { resolveOrderExecution } from "../../helpers";
import {
	archiveOrderExecutionInBackground,
	captureMarketMetadataSnapshot,
	rethrowArchiveDurabilityError,
} from "../../helpers/broker-execution-archive";
import { Action } from "../../helpers/constants";
import {
	emitOrderExecutionTelemetryInBackground,
	extractOrderTelemetryIds,
} from "../../helpers/order-telemetry";
import { classifyPassiveOrderError } from "../../helpers/passive-order";
import {
	safeLogError,
	safeLogRedactedError,
	sanitizeErrorDetail,
} from "../../helpers/shared/errors";
import {
	CancelOrderPayloadSchema,
	CreateOrderPayloadSchema,
	GetOrderDetailsPayloadSchema,
} from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import { parsePayloadForAction, rejectWithGrpcError } from "./context";

async function handleCreateOrder(ctx: ExecuteActionContext): Promise<void> {
	const {
		call,
		wrappedCallback,
		policy,
		brokers,
		metadata,
		normalizedCex,
		cex,
		symbol,
		selectedBrokerAccount,
		broker,
		verity,
		applyVerityToBroker,
		useVerity,
		verityProverUrl,
		otelMetrics,
		brokerArchiver,
		orderActivityTracker,
	} = ctx;
	const verityProof = verity.proof;

	const orderValue = parsePayloadForAction(ctx, CreateOrderPayloadSchema);
	if (orderValue === null) return;
	const isPassiveOrder = orderValue.orderIntent === "passive_only";
	if (isPassiveOrder && orderValue.orderType !== "limit") {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message:
					"ValidationError: passive_only order intent requires a limit order",
			},
			null,
		);
	}
	const createOrderParams = {
		...orderValue.params,
		...(orderValue.clientOrderId !== undefined && {
			clientOrderId: orderValue.clientOrderId,
		}),
		...(isPassiveOrder && { postOnly: true }),
	};
	let resolvedOrderTelemetry: {
		symbol?: string;
		side?: string;
		requestedQuantity?: number;
	} = {};
	let marketMetadataHash: string | undefined;
	// A passive error code is a statement about what the VENUE did with our
	// submission. Failures before the call (policy resolution, metadata capture)
	// never reached the venue, and failures after it leave a real order resting —
	// reporting either as a passive rejection would tell the client its rung was
	// never placed and invite a duplicate repost.
	let submission: "not_attempted" | "in_flight" | "placed" = "not_attempted";
	try {
		if (!broker) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
				},
				null,
			);
		}
		const resolution = await resolveOrderExecution(
			policy,
			broker,
			cex,
			orderValue.fromToken,
			orderValue.toToken,
			orderValue.amount,
			orderValue.price,
			orderValue.marketType,
		);
		if (!resolution.valid || !resolution.symbol || !resolution.side) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message:
						resolution.error ??
						"Order rejected by policy: market or limits not satisfied",
				},
				null,
			);
		}
		resolvedOrderTelemetry = {
			symbol: resolution.symbol,
			side: resolution.side,
			requestedQuantity: resolution.amountBase ?? orderValue.amount,
		};
		// Mark this (account, symbol) so the fill poller scans it for trade history.
		if (selectedBrokerAccount?.label) {
			orderActivityTracker?.record(
				cex,
				selectedBrokerAccount.label,
				resolution.symbol,
			);
		}
		const telemetryIds = extractOrderTelemetryIds(createOrderParams);
		const submissionTimestamp = new Date().toISOString();
		marketMetadataHash = await captureMarketMetadataSnapshot(
			brokerArchiver,
			broker,
			{
				exchange: cex,
				accountSelector: selectedBrokerAccount?.label,
				symbol: resolution.symbol,
				action: "CreateOrder",
				brokerObservedTimestamp: submissionTimestamp,
				...telemetryIds,
			},
		);
		submission = "in_flight";
		const order = await broker.createOrder(
			resolution.symbol,
			orderValue.orderType,
			resolution.side,
			resolution.amountBase ?? orderValue.amount,
			orderValue.price,
			createOrderParams,
		);
		submission = "placed";
		const createOrderContext = {
			action: "CreateOrder" as const,
			cex,
			accountLabel: selectedBrokerAccount?.label,
			symbol: resolvedOrderTelemetry.symbol,
			side: resolvedOrderTelemetry.side,
			orderType: orderValue.orderType,
			requestedQuantity: resolvedOrderTelemetry.requestedQuantity,
			requestedNotional: orderValue.amount * orderValue.price,
			brokerObservedTimestamp: submissionTimestamp,
			...telemetryIds,
		};
		emitOrderExecutionTelemetryInBackground(
			otelMetrics,
			createOrderContext,
			order,
		);
		archiveOrderExecutionInBackground(
			brokerArchiver,
			createOrderContext,
			order,
			undefined,
			{ marketMetadataHash },
		);
		ctx.wrappedCallback(null, {
			result: JSON.stringify({
				...order,
				...(isPassiveOrder && {
					passivePlacementOutcome: "accepted_passive",
				}),
			}),
		});
	} catch (error) {
		rethrowArchiveDurabilityError(error);
		safeLogRedactedError("Order Creation failed", error);
		const failedCreateContext = {
			action: "CreateOrder" as const,
			cex,
			accountLabel: selectedBrokerAccount?.label,
			symbol: resolvedOrderTelemetry.symbol ?? symbol,
			side: resolvedOrderTelemetry.side,
			orderType: orderValue.orderType,
			requestedQuantity:
				resolvedOrderTelemetry.requestedQuantity ?? orderValue.amount,
			requestedNotional: orderValue.amount * orderValue.price,
			...extractOrderTelemetryIds(createOrderParams),
		};
		emitOrderExecutionTelemetryInBackground(
			otelMetrics,
			failedCreateContext,
			undefined,
			error,
		);
		archiveOrderExecutionInBackground(
			brokerArchiver,
			failedCreateContext,
			undefined,
			error,
			{ marketMetadataHash },
		);
		if (isPassiveOrder && submission === "in_flight") {
			const passiveErrorCode = classifyPassiveOrderError(error);
			return rejectWithGrpcError(ctx, error, {
				message: `${passiveErrorCode}: ${sanitizeErrorDetail(error)}`,
				preferStableMessageOnly: true,
			});
		}
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: `Order Creation failed: ${sanitizeErrorDetail(error)}`,
			},
			null,
		);
	}
}

async function handleGetOrderDetails(ctx: ExecuteActionContext): Promise<void> {
	const {
		call,
		wrappedCallback,
		policy,
		brokers,
		metadata,
		normalizedCex,
		cex,
		symbol,
		selectedBrokerAccount,
		broker,
		verity,
		applyVerityToBroker,
		useVerity,
		verityProverUrl,
		otelMetrics,
		brokerArchiver,
		orderActivityTracker,
	} = ctx;
	const verityProof = verity.proof;

	const getOrderValue = parsePayloadForAction(
		ctx,
		GetOrderDetailsPayloadSchema,
	);
	if (getOrderValue === null) return;
	try {
		// Validate CEX key
		if (!broker) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
				},
				null,
			);
		}
		const orderDetails = await broker.fetchOrder(
			getOrderValue.orderId,
			symbol,
			{ ...getOrderValue.params },
		);
		if (selectedBrokerAccount?.label && symbol) {
			orderActivityTracker?.record(cex, selectedBrokerAccount.label, symbol);
		}
		const getOrderContext = {
			action: "GetOrderDetails" as const,
			cex,
			accountLabel: selectedBrokerAccount?.label,
			symbol,
			...extractOrderTelemetryIds(getOrderValue.params),
		};
		emitOrderExecutionTelemetryInBackground(
			otelMetrics,
			getOrderContext,
			orderDetails,
		);
		archiveOrderExecutionInBackground(
			brokerArchiver,
			getOrderContext,
			orderDetails,
		);
		ctx.wrappedCallback(null, {
			result: JSON.stringify({
				orderId: orderDetails.id,
				status: orderDetails.status,
				amount: orderDetails.amount,
				filled: orderDetails.filled,
				remaining: orderDetails.remaining,
				symbol: orderDetails.symbol,
				side: orderDetails.side,
				price: orderDetails.price,
			}),
		});
	} catch (error) {
		safeLogError(`Error fetching order details from ${cex}`, error);
		const failedGetOrderContext = {
			action: "GetOrderDetails" as const,
			cex,
			accountLabel: selectedBrokerAccount?.label,
			symbol,
			...extractOrderTelemetryIds(getOrderValue.params),
		};
		emitOrderExecutionTelemetryInBackground(
			otelMetrics,
			failedGetOrderContext,
			undefined,
			error,
		);
		archiveOrderExecutionInBackground(
			brokerArchiver,
			failedGetOrderContext,
			undefined,
			error,
		);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: `Failed to fetch order details from ${cex}: ${sanitizeErrorDetail(error)}`,
			},
			null,
		);
	}
}

async function handleCancelOrder(ctx: ExecuteActionContext): Promise<void> {
	const {
		call,
		wrappedCallback,
		policy,
		brokers,
		metadata,
		normalizedCex,
		cex,
		symbol,
		selectedBrokerAccount,
		broker,
		verity,
		applyVerityToBroker,
		useVerity,
		verityProverUrl,
		otelMetrics,
		brokerArchiver,
		orderActivityTracker,
	} = ctx;
	const verityProof = verity.proof;

	const cancelOrderValue = parsePayloadForAction(ctx, CancelOrderPayloadSchema);
	if (cancelOrderValue === null) return;
	try {
		if (!broker) {
			return ctx.wrappedCallback(
				{
					code: grpc.status.INVALID_ARGUMENT,
					message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
				},
				null,
			);
		}
		const cancelOrderContext = {
			action: "CancelOrder" as const,
			cex,
			accountLabel: selectedBrokerAccount?.label,
			symbol,
			...extractOrderTelemetryIds(cancelOrderValue.params),
		};
		const cancelledOrder = await broker.cancelOrder(
			cancelOrderValue.orderId,
			symbol,
			cancelOrderValue.params ?? {},
		);
		if (selectedBrokerAccount?.label && symbol) {
			orderActivityTracker?.record(cex, selectedBrokerAccount.label, symbol);
		}
		emitOrderExecutionTelemetryInBackground(
			otelMetrics,
			cancelOrderContext,
			cancelledOrder,
		);
		archiveOrderExecutionInBackground(
			brokerArchiver,
			cancelOrderContext,
			cancelledOrder,
		);
		ctx.wrappedCallback(null, {
			result: JSON.stringify({ ...cancelledOrder }),
		});
	} catch (error) {
		safeLogError(`Error cancelling order from ${cex}`, error);
		const failedCancelContext = {
			action: "CancelOrder" as const,
			cex,
			accountLabel: selectedBrokerAccount?.label,
			symbol,
			...extractOrderTelemetryIds(cancelOrderValue.params),
		};
		emitOrderExecutionTelemetryInBackground(
			otelMetrics,
			failedCancelContext,
			undefined,
			error,
		);
		archiveOrderExecutionInBackground(
			brokerArchiver,
			failedCancelContext,
			undefined,
			error,
		);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: `Failed to cancel order from ${cex}: ${sanitizeErrorDetail(error)}`,
			},
			null,
		);
	}
}

export async function handleOrders(ctx: ExecuteActionContext): Promise<void> {
	if (ctx.action === Action.CreateOrder) return handleCreateOrder(ctx);
	if (ctx.action === Action.GetOrderDetails) return handleGetOrderDetails(ctx);
	if (ctx.action === Action.CancelOrder) return handleCancelOrder(ctx);
}
