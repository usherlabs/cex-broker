import * as grpc from "@grpc/grpc-js";
import { resolveOrderExecution } from "../../helpers";
import { Action } from "../../helpers/constants";
import {
	emitOrderExecutionTelemetryInBackground,
	extractOrderTelemetryIds,
} from "../../helpers/order-telemetry";
import { getErrorMessage, safeLogError } from "../../helpers/shared/errors";
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
	} = ctx;
	const verityProof = verity.proof;

	const orderValue = parsePayloadForAction(ctx, CreateOrderPayloadSchema);
	if (orderValue === null) return;
	let resolvedOrderTelemetry: {
		symbol?: string;
		side?: string;
		requestedQuantity?: number;
	} = {};
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
		const order = await broker.createOrder(
			resolution.symbol,
			orderValue.orderType,
			resolution.side,
			resolution.amountBase ?? orderValue.amount,
			orderValue.price,
			orderValue.params ?? {},
		);
		emitOrderExecutionTelemetryInBackground(
			otelMetrics,
			{
				action: "CreateOrder",
				cex,
				accountLabel: selectedBrokerAccount?.label,
				symbol: resolvedOrderTelemetry.symbol,
				side: resolvedOrderTelemetry.side,
				orderType: orderValue.orderType,
				requestedQuantity: resolvedOrderTelemetry.requestedQuantity,
				requestedNotional: orderValue.amount * orderValue.price,
				...extractOrderTelemetryIds(orderValue.params),
			},
			order,
		);
		ctx.wrappedCallback(null, { result: JSON.stringify({ ...order }) });
	} catch (error) {
		safeLogError("Order Creation failed", error);
		emitOrderExecutionTelemetryInBackground(
			otelMetrics,
			{
				action: "CreateOrder",
				cex,
				accountLabel: selectedBrokerAccount?.label,
				symbol: resolvedOrderTelemetry.symbol ?? symbol,
				side: resolvedOrderTelemetry.side,
				orderType: orderValue.orderType,
				requestedQuantity:
					resolvedOrderTelemetry.requestedQuantity ?? orderValue.amount,
				requestedNotional: orderValue.amount * orderValue.price,
				...extractOrderTelemetryIds(orderValue.params),
			},
			undefined,
			error,
		);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: "Order Creation failed",
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
		emitOrderExecutionTelemetryInBackground(
			otelMetrics,
			{
				action: "GetOrderDetails",
				cex,
				accountLabel: selectedBrokerAccount?.label,
				symbol,
				...extractOrderTelemetryIds(getOrderValue.params),
			},
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
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: `Failed to fetch order details from ${cex}`,
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
	} = ctx;
	const verityProof = verity.proof;

	const cancelOrderValue = parsePayloadForAction(ctx, CancelOrderPayloadSchema);
	if (cancelOrderValue === null) return;
	try {
		const cancelledOrder = await broker.cancelOrder(
			cancelOrderValue.orderId,
			symbol,
			cancelOrderValue.params ?? {},
		);
		ctx.wrappedCallback(null, {
			result: JSON.stringify({ ...cancelledOrder }),
		});
	} catch (error) {
		safeLogError(`Error cancelling order from ${cex}`, error);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: `Failed to cancel order from ${cex}`,
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
