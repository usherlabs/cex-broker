import * as grpc from "@grpc/grpc-js";
import { mapCcxtErrorToGrpcStatus } from "../../helpers/grpc/status";
import { archiveOrderbookInBackground } from "../../helpers/market-data-archive/capture";
import { getOrderbookMeasurementBandsBps } from "../../helpers/market-data-archive/orderbook-depth";
import {
	buildHistoricalOrderBookUnsupported,
	buildOrderBookCapability,
	normalizeOrderBookSnapshot,
	ORDER_BOOK_CALL_METHODS,
	parseOrderBookCallPayload,
} from "../../helpers/order-book";
import { safeLogError, sanitizeErrorDetail } from "../../helpers/shared/errors";
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

	const orderBookBroker = ctx.broker;
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

		// SAFETY: CCXT's base Exchange type does not expose every adapter method;
		// the runtime property is checked as a function before it is called.
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
		const snapshot = normalizeOrderBookSnapshot(rawOrderBook, {
			exchange: orderBookPayload.exchange,
			symbol: orderBookPayload.symbol,
			depthLimit: orderBookPayload.depthLimit,
			receivedTimestamp,
		});
		ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify(snapshot),
		});
		archiveOrderbookInBackground(
			ctx.brokerArchiver,
			ctx.otelMetrics,
			{
				exchange: orderBookPayload.exchange,
				symbol: orderBookPayload.symbol,
				assetType: "spot",
				accountSelector: ctx.selectedBrokerAccount?.label,
				deploymentId: ctx.brokerArchiver?.getDeploymentId() ?? "unarchived",
				snapshot,
				archiveMetadata: {
					captureProfileId: `${orderBookPayload.exchange.trim().toLowerCase()}:current-snapshot:requested:${orderBookPayload.depthLimit}`,
					// Summary v2 uses 1ms as the positive sentinel for a one-shot
					// acquisition; it does not claim a periodic sampling cadence.
					effectiveCadenceMs: 1,
					requestedUpstreamDepth: orderBookPayload.depthLimit,
					observedBidCount: snapshot.bids.length,
					observedAskCount: snapshot.asks.length,
					observedFarthestBid: snapshot.bids.at(-1)?.[0] ?? Number.NaN,
					observedFarthestAsk: snapshot.asks.at(-1)?.[0] ?? Number.NaN,
					exhaustionEvidence: {
						bid: {
							exhausted: false,
							validated: true,
							source: "broker:current-snapshot",
						},
						ask: {
							exhausted: false,
							validated: true,
							source: "broker:current-snapshot",
						},
					},
					measurementBandsBps: getOrderbookMeasurementBandsBps(),
				},
			},
			{
				sourceMode: "broker_current_snapshot_v1",
				depthLimit: orderBookPayload.depthLimit,
			},
		);
	} catch (error: unknown) {
		safeLogError("Order-book Call failed", error);
		ctx.wrappedCallback(
			{
				code: mapCcxtErrorToGrpcStatus(error) ?? grpc.status.INTERNAL,
				message: `Order-book Call failed: ${sanitizeErrorDetail(error)}`,
			},
			null,
		);
	}
	return true;
}
