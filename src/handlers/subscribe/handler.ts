import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import {
	authenticateRequest,
	type BrokerPoolEntry,
	createBroker,
	createPublicBroker,
	selectBroker,
} from "../../helpers";
import {
	getSubscriptionTypeName,
	resolveSubscriptionType,
	SubscriptionType,
	type SubscriptionType as SubscriptionTypeValue,
} from "../../helpers/constants";
import { log } from "../../helpers/logger";
import { resolveSubscriptionSymbol } from "../../helpers/market-type";
import {
	normalizeOrderBookSnapshot,
	parseOptionalDepthLimit,
} from "../../helpers/order-book";
import type { OtelMetrics } from "../../helpers/otel";
import { getErrorMessage } from "../../helpers/shared/errors";
import type { SubscribeRequest, SubscribeResponse } from "../types";

export type SubscribeDeps = {
	brokers: Record<string, BrokerPoolEntry>;
	whitelistIps: string[];
	otelMetrics?: OtelMetrics;
};

export function createSubscribeHandler(deps: SubscribeDeps) {
	const { brokers, whitelistIps, otelMetrics } = deps;

	return async (
		call: grpc.ServerWritableStream<SubscribeRequest, SubscribeResponse>,
	) => {
		const subscribeStartTime = Date.now();
		// IP Authentication
		if (!authenticateRequest(call, whitelistIps)) {
			otelMetrics?.recordCounter("subscribe_errors_total", 1, {
				error_type: "permission_denied",
			});
			call.emit(
				"error",
				{
					code: grpc.status.PERMISSION_DENIED,
					message: "Access denied: Unauthorized IP",
				},
				null,
			);
			call.destroy(new Error("Access denied: Unauthorized IP"));
			return;
		}
		// Read incoming metadata
		const metadata = call.metadata;
		let broker: Exchange | null = null;
		let subscriptionType: SubscriptionTypeValue = SubscriptionType.ORDERBOOK;

		try {
			// For ServerWritableStream, we need to get the request from the call
			// The request should be available in the call object
			const request = call.request as SubscribeRequest;
			const { cex, symbol, type, options } = request;

			// proto-loader with defaults:true materializes omitted enums as NO_ACTION.
			subscriptionType = resolveSubscriptionType(type);

			log.info(`Request - Subscribe:`, {
				cex: request.cex,
				symbol: request.symbol,
				type: subscriptionType,
			});

			// Record subscription request
			const subscriptionTypeName = getSubscriptionTypeName(subscriptionType);
			otelMetrics?.recordCounter("subscribe_requests_total", 1, {
				cex: cex || "unknown",
				symbol: symbol || "unknown",
				type: subscriptionTypeName,
			});

			// Validate required fields
			if (!cex || !symbol) {
				call.write({
					data: JSON.stringify({
						error: "cex, symbol, and type are required",
					}),
					timestamp: Date.now(),
					symbol: symbol || "",
					type: subscriptionType,
				});
				call.end();
				return;
			}
			const normalizedCex = cex.trim().toLowerCase();

			// Get or create broker (no Verity override in Subscribe)
			broker =
				selectBroker(
					brokers[normalizedCex as keyof typeof brokers],
					metadata,
				) ??
				createBroker(normalizedCex, metadata) ??
				createPublicBroker(normalizedCex);

			if (!broker) {
				call.write({
					data: JSON.stringify({
						error: "Exchange not registered and no API metadata found",
					}),
					timestamp: Date.now(),
					symbol,
					type: subscriptionType,
				});
				call.end();
				return;
			}

			const resolvedSymbol = await resolveSubscriptionSymbol(
				broker,
				symbol,
				options?.marketType,
			);

			// Handle different subscription types
			switch (subscriptionType) {
				case SubscriptionType.ORDERBOOK:
					try {
						while (true) {
							const depthLimit = parseOptionalDepthLimit(
								options?.depthLimit ?? options?.limit,
							);
							const orderbook =
								depthLimit === undefined
									? await broker.watchOrderBook(resolvedSymbol)
									: await broker.watchOrderBook(resolvedSymbol, depthLimit);
							const receivedTimestamp = Date.now();
							call.write({
								data: JSON.stringify(
									normalizeOrderBookSnapshot(orderbook, {
										exchange: normalizedCex,
										symbol: resolvedSymbol,
										depthLimit:
											depthLimit ??
											Math.max(
												Array.isArray(orderbook?.bids)
													? orderbook.bids.length
													: 0,
												Array.isArray(orderbook?.asks)
													? orderbook.asks.length
													: 0,
											),
										receivedTimestamp,
									}),
								),
								timestamp: receivedTimestamp,
								symbol: resolvedSymbol,
								type: subscriptionType,
							});
						}
					} catch (error: unknown) {
						log.error(
							`Error fetching orderbook for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						const message = getErrorMessage(error);
						call.write({
							data: JSON.stringify({
								error: `Failed to fetch orderbook: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
						call.end();
					}
					break;

				case SubscriptionType.TRADES:
					try {
						while (true) {
							const trades = await broker.watchTrades(resolvedSymbol);
							call.write({
								data: JSON.stringify(trades),
								timestamp: Date.now(),
								symbol: resolvedSymbol,
								type: subscriptionType,
							});
						}
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						log.error(
							`Error fetching trades for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						call.write({
							data: JSON.stringify({
								error: `Failed to fetch trades: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
						call.end();
					}
					break;

				case SubscriptionType.TICKER:
					try {
						while (true) {
							const ticker = await broker.watchTicker(resolvedSymbol);
							call.write({
								data: JSON.stringify(ticker),
								timestamp: Date.now(),
								symbol: resolvedSymbol,
								type: subscriptionType,
							});
						}
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						log.error(
							`Error fetching ticker for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						call.write({
							data: JSON.stringify({
								error: `Failed to fetch ticker: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
						call.end();
					}
					break;

				case SubscriptionType.OHLCV:
					try {
						while (true) {
							const timeframe = options?.timeframe || "1m";
							const ohlcv = await broker.fetchOHLCVWs(
								resolvedSymbol,
								timeframe,
							);
							call.write({
								data: JSON.stringify(ohlcv),
								timestamp: Date.now(),
								symbol: resolvedSymbol,
								type: subscriptionType,
							});
						}
					} catch (error: unknown) {
						log.error(
							`Error fetching OHLCV for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						const message = getErrorMessage(error);
						call.write({
							data: JSON.stringify({
								error: `Failed to fetch OHLCV: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
						call.end();
					}
					break;

				case SubscriptionType.BALANCE:
					try {
						while (true) {
							const balance = await broker.watchBalance();
							call.write({
								data: JSON.stringify(balance),
								timestamp: Date.now(),
								symbol,
								type: subscriptionType,
							});
						}
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						log.error(`Error fetching balance for ${cex}:`, error);
						call.write({
							data: JSON.stringify({
								error: `Failed to fetch balance: ${message}`,
							}),
							timestamp: Date.now(),
							symbol,
							type: subscriptionType,
						});
						call.end();
					}
					break;

				case SubscriptionType.ORDERS:
					try {
						while (true) {
							const orders = await broker.watchOrders(resolvedSymbol);
							call.write({
								data: JSON.stringify(orders),
								timestamp: Date.now(),
								symbol: resolvedSymbol,
								type: subscriptionType,
							});
						}
					} catch (error: unknown) {
						log.error(
							`Error fetching orders for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						const message = getErrorMessage(error);
						call.write({
							data: JSON.stringify({
								error: `Failed to fetch orders: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
						call.end();
					}
					break;

				default:
					call.write({
						data: JSON.stringify({ error: "Invalid subscription type" }),
						timestamp: Date.now(),
						symbol,
						type: subscriptionType,
					});
			}
		} catch (error) {
			log.error("Error in Subscribe stream:", error);
			const message = getErrorMessage(error);
			call.write({
				data: JSON.stringify({ error: `Internal server error: ${message}` }),
				timestamp: Date.now(),
				symbol: "",
				type: subscriptionType,
			});
			call.end();
		}

		call.on("end", () => {
			log.info("Subscribe stream ended");
			const duration = Date.now() - subscribeStartTime;
			otelMetrics?.recordHistogram("subscribe_duration_ms", duration, {
				cex: call.request?.cex || "unknown",
				symbol: call.request?.symbol || "unknown",
			});
		});

		call.on("error", (error) => {
			log.error("Subscribe stream error:", error);
			otelMetrics?.recordCounter("subscribe_errors_total", 1, {
				error_type: error instanceof Error ? error.message : "unknown",
			});
		});
	};
}
