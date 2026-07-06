import * as grpc from "@grpc/grpc-js";
import { createBroker, createPublicBroker } from "../../helpers";
import {
	buildBrokerSurfaceDeniedError,
	classifyCcxtMethod,
	isBrokerAccessAllowed,
} from "../../helpers/broker-surface";
import { mapCcxtErrorToGrpcStatus } from "../../helpers/grpc/status";
import {
	buildHistoricalOrderBookUnsupported,
	buildOrderBookCapability,
	normalizeOrderBookSnapshot,
	ORDER_BOOK_CALL_METHODS,
	parseOrderBookCallPayload,
} from "../../helpers/order-book";
import { getErrorMessage, safeLogError } from "../../helpers/shared/errors";
import type { ExecuteActionContext } from "./context";

/** Handles Action.Call order-book methods before generic broker dispatch. Returns true when fully handled. */
export async function handleOrderBookCall(
	ctx: ExecuteActionContext,
): Promise<boolean> {
	const parsedOrderBookCall = parseOrderBookCallPayload(
		ctx.call.request.payload,
		{
			exchange: ctx.normalizedCex,
			symbol: ctx.symbol,
		},
	);
	if (parsedOrderBookCall.kind === "error") {
		ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: parsedOrderBookCall.message,
			},
			null,
		);
		return true;
	}
	if (parsedOrderBookCall.kind !== "order_book") {
		return false;
	}

	if (!isBrokerAccessAllowed(ctx.brokerSurface, "read")) {
		ctx.wrappedCallback(buildBrokerSurfaceDeniedError("read"), null);
		return true;
	}

	const orderBookBroker =
		ctx.selectedBrokerAccount?.exchange ??
		createBroker(ctx.normalizedCex, ctx.metadata) ??
		createPublicBroker(ctx.normalizedCex);
	if (!orderBookBroker) {
		ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `Unsupported exchange for order-book market data: ${ctx.normalizedCex}`,
			},
			null,
		);
		return true;
	}
	ctx.applyVerityToBroker(orderBookBroker);

	try {
		const orderBookPayload = parsedOrderBookCall.payload;
		if (orderBookPayload.method === ORDER_BOOK_CALL_METHODS.FETCH_CAPABILITY) {
			ctx.wrappedCallback(null, {
				proof: ctx.verity.proof,
				result: JSON.stringify(
					buildOrderBookCapability(orderBookBroker, orderBookPayload),
				),
			});
			return true;
		}

		if (
			orderBookPayload.method ===
			ORDER_BOOK_CALL_METHODS.FETCH_HISTORICAL_SNAPSHOTS
		) {
			ctx.wrappedCallback(null, {
				proof: ctx.verity.proof,
				result: JSON.stringify(
					buildHistoricalOrderBookUnsupported(orderBookPayload),
				),
			});
			return true;
		}

		const fetchOrderBook = (
			orderBookBroker as unknown as Record<string, unknown>
		).fetchOrderBook;
		const canFetchOrderBook =
			typeof fetchOrderBook === "function" &&
			(orderBookBroker.has as Record<string, unknown> | undefined)
				?.fetchOrderBook !== false;
		if (!canFetchOrderBook) {
			ctx.wrappedCallback(
				{
					code: grpc.status.UNIMPLEMENTED,
					message: `Order-book snapshot unsupported for ${ctx.normalizedCex}`,
				},
				null,
			);
			return true;
		}

		const receivedTimestamp = Date.now();
		const rawOrderBook = await (
			fetchOrderBook as (symbol: string, limit?: number) => Promise<unknown>
		).call(
			orderBookBroker,
			orderBookPayload.symbol,
			orderBookPayload.depthLimit,
		);
		ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify(
				normalizeOrderBookSnapshot(rawOrderBook, {
					exchange: orderBookPayload.exchange,
					symbol: orderBookPayload.symbol,
					depthLimit: orderBookPayload.depthLimit,
					receivedTimestamp,
				}),
			),
		});
	} catch (error: unknown) {
		safeLogError("Order-book Call failed", error);
		const message = getErrorMessage(error);
		ctx.wrappedCallback(
			{
				code: mapCcxtErrorToGrpcStatus(error) ?? grpc.status.INTERNAL,
				message: `Order-book Call failed: ${message}`,
			},
			null,
		);
	}
	return true;
}
