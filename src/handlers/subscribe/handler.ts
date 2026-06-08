import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { authenticateRequest } from "../../helpers/auth";
import {
	BinanceSpotUserDataStream,
	type BinanceUserDataEvent,
	isBinanceBalanceUserDataEvent,
	isBinanceOrderUserDataEvent,
} from "../../helpers/binance-user-data-stream";
import {
	type BrokerPoolEntry,
	createBroker,
	createPublicBroker,
	selectBroker,
} from "../../helpers/broker";
import {
	getSubscriptionTypeName,
	resolveSubscriptionType,
	SubscriptionType,
	type SubscriptionType as SubscriptionTypeValue,
} from "../../helpers/constants";
import { log } from "../../helpers/logger";
import {
	parseMarketType,
	resolveSubscriptionSymbol,
} from "../../helpers/market-type";
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

type SubscribeCall = grpc.ServerWritableStream<
	SubscribeRequest,
	SubscribeResponse
>;

function isBinanceSpotAccountSubscription(
	cex: string,
	subscriptionType: SubscriptionTypeValue,
	marketTypeInput: unknown,
): boolean {
	return (
		cex === "binance" &&
		parseMarketType(marketTypeInput) === "spot" &&
		(subscriptionType === SubscriptionType.BALANCE ||
			subscriptionType === SubscriptionType.ORDERS)
	);
}

function writeSubscribeFrame(
	call: SubscribeCall,
	isClosed: () => boolean,
	frame: SubscribeResponse,
): boolean {
	if (isClosed() || call.destroyed) {
		return false;
	}
	call.write(frame);
	return true;
}

function writeSubscribeError(
	call: SubscribeCall,
	isClosed: () => boolean,
	frame: SubscribeResponse,
): void {
	writeSubscribeFrame(call, isClosed, frame);
	if (!isClosed() && !call.destroyed) {
		call.end();
	}
}

function getBinanceEventMarketId(
	event: Record<string, unknown>,
): string | null {
	const value = event.s;
	return typeof value === "string" ? value : null;
}

async function getBinanceMarketId(
	broker: Exchange,
	symbol: string,
): Promise<string> {
	const loadMarkets = (broker as unknown as { loadMarkets?: unknown })
		.loadMarkets;
	if (typeof loadMarkets === "function") {
		await loadMarkets.call(broker);
	}
	const market = (broker as unknown as { market?: unknown }).market;
	if (typeof market === "function") {
		const resolvedMarket = market.call(broker, symbol) as
			| { id?: unknown }
			| undefined;
		if (typeof resolvedMarket?.id === "string") {
			return resolvedMarket.id;
		}
	}
	return symbol.replace("/", "").toUpperCase();
}

async function streamBinanceUserData(
	call: SubscribeCall,
	broker: Exchange,
	symbol: string,
	subscriptionType: SubscriptionTypeValue,
	isClosed: () => boolean,
): Promise<void> {
	const userDataStream = new BinanceSpotUserDataStream(broker);
	call.once("close", () => userDataStream.close());
	call.once("cancelled", () => userDataStream.close());
	call.once("error", () => userDataStream.close());

	const marketId =
		subscriptionType === SubscriptionType.ORDERS
			? await getBinanceMarketId(broker, symbol)
			: null;

	try {
		for await (const message of userDataStream) {
			if (isClosed()) {
				break;
			}
			const event = message.event;
			if (subscriptionType === SubscriptionType.BALANCE) {
				if (!isBinanceBalanceUserDataEvent(event)) {
					continue;
				}
			} else {
				if (!isBinanceOrderUserDataEvent(event)) {
					continue;
				}
				const eventMarketId = getBinanceEventMarketId(event);
				if (eventMarketId && marketId && eventMarketId !== marketId) {
					continue;
				}
			}

			if (
				!writeSubscribeFrame(call, isClosed, {
					data: JSON.stringify({
						subscriptionId: message.subscriptionId,
						event,
					} satisfies BinanceUserDataEvent),
					timestamp: Date.now(),
					symbol,
					type: subscriptionType,
				})
			) {
				break;
			}
		}
	} finally {
		userDataStream.close();
	}
}

async function runCcxtSubscribeLoop(
	call: SubscribeCall,
	isClosed: () => boolean,
	symbol: string,
	subscriptionType: SubscriptionTypeValue,
	watch: () => Promise<unknown>,
): Promise<void> {
	while (!isClosed()) {
		const data = await watch();
		if (
			!writeSubscribeFrame(call, isClosed, {
				data: JSON.stringify(data),
				timestamp: Date.now(),
				symbol,
				type: subscriptionType,
			})
		) {
			break;
		}
	}
}

export function createSubscribeHandler(deps: SubscribeDeps) {
	const { brokers, whitelistIps, otelMetrics } = deps;

	return async (call: SubscribeCall) => {
		const subscribeStartTime = Date.now();
		let streamClosed = false;
		const markStreamClosed = () => {
			streamClosed = true;
		};
		const isStreamClosed = () => streamClosed || call.destroyed;

		call.once("close", markStreamClosed);
		call.once("cancelled", markStreamClosed);
		call.once("end", () => {
			markStreamClosed();
			log.info("Subscribe stream ended");
			const duration = Date.now() - subscribeStartTime;
			otelMetrics?.recordHistogram("subscribe_duration_ms", duration, {
				cex: call.request?.cex || "unknown",
				symbol: call.request?.symbol || "unknown",
			});
		});
		call.once("error", (error) => {
			markStreamClosed();
			log.error("Subscribe stream error:", error);
			otelMetrics?.recordCounter("subscribe_errors_total", 1, {
				error_type: error instanceof Error ? error.message : "unknown",
			});
		});

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

		const metadata = call.metadata;
		let subscriptionType: SubscriptionTypeValue = SubscriptionType.ORDERBOOK;

		try {
			const request = call.request as SubscribeRequest;
			const { cex, symbol, type, options } = request;

			// proto-loader with defaults:true materializes omitted enums as NO_ACTION.
			subscriptionType = resolveSubscriptionType(type);

			log.info(`Request - Subscribe:`, {
				cex: request.cex,
				symbol: request.symbol,
				type: subscriptionType,
			});

			const subscriptionTypeName = getSubscriptionTypeName(subscriptionType);
			otelMetrics?.recordCounter("subscribe_requests_total", 1, {
				cex: cex || "unknown",
				symbol: symbol || "unknown",
				type: subscriptionTypeName,
			});

			if (!cex || !symbol) {
				writeSubscribeError(call, isStreamClosed, {
					data: JSON.stringify({
						error: "cex, symbol, and type are required",
					}),
					timestamp: Date.now(),
					symbol: symbol || "",
					type: subscriptionType,
				});
				return;
			}

			const normalizedCex = cex.trim().toLowerCase();
			const selectedBroker =
				selectBroker(
					brokers[normalizedCex as keyof typeof brokers],
					metadata,
				) ?? createBroker(normalizedCex, metadata);
			const broker = selectedBroker ?? createPublicBroker(normalizedCex);

			if (!broker) {
				writeSubscribeError(call, isStreamClosed, {
					data: JSON.stringify({
						error: "Exchange not registered and no API metadata found",
					}),
					timestamp: Date.now(),
					symbol,
					type: subscriptionType,
				});
				return;
			}

			const resolvedSymbol = await resolveSubscriptionSymbol(
				broker,
				symbol,
				options?.marketType,
			);

			if (
				isBinanceSpotAccountSubscription(
					normalizedCex,
					subscriptionType,
					options?.marketType,
				)
			) {
				if (!selectedBroker) {
					writeSubscribeError(call, isStreamClosed, {
						data: JSON.stringify({
							error: "Binance account subscriptions require API credentials",
						}),
						timestamp: Date.now(),
						symbol: resolvedSymbol,
						type: subscriptionType,
					});
					return;
				}
				await streamBinanceUserData(
					call,
					selectedBroker,
					resolvedSymbol,
					subscriptionType,
					isStreamClosed,
				);
				return;
			}

			switch (subscriptionType) {
				case SubscriptionType.ORDERBOOK:
					try {
						while (!isStreamClosed()) {
							const depthLimit = parseOptionalDepthLimit(
								options?.depthLimit ?? options?.limit,
							);
							const orderbook =
								depthLimit === undefined
									? await broker.watchOrderBook(resolvedSymbol)
									: await broker.watchOrderBook(resolvedSymbol, depthLimit);
							const receivedTimestamp = Date.now();
							if (
								!writeSubscribeFrame(call, isStreamClosed, {
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
								})
							) {
								break;
							}
						}
					} catch (error: unknown) {
						log.error(
							`Error fetching orderbook for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						const message = getErrorMessage(error);
						writeSubscribeError(call, isStreamClosed, {
							data: JSON.stringify({
								error: `Failed to fetch orderbook: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
					}
					break;

				case SubscriptionType.TRADES:
					try {
						await runCcxtSubscribeLoop(
							call,
							isStreamClosed,
							resolvedSymbol,
							subscriptionType,
							() => broker.watchTrades(resolvedSymbol),
						);
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						log.error(
							`Error fetching trades for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						writeSubscribeError(call, isStreamClosed, {
							data: JSON.stringify({
								error: `Failed to fetch trades: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
					}
					break;

				case SubscriptionType.TICKER:
					try {
						await runCcxtSubscribeLoop(
							call,
							isStreamClosed,
							resolvedSymbol,
							subscriptionType,
							() => broker.watchTicker(resolvedSymbol),
						);
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						log.error(
							`Error fetching ticker for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						writeSubscribeError(call, isStreamClosed, {
							data: JSON.stringify({
								error: `Failed to fetch ticker: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
					}
					break;

				case SubscriptionType.OHLCV:
					try {
						const timeframe = options?.timeframe || "1m";
						await runCcxtSubscribeLoop(
							call,
							isStreamClosed,
							resolvedSymbol,
							subscriptionType,
							() => broker.fetchOHLCVWs(resolvedSymbol, timeframe),
						);
					} catch (error: unknown) {
						log.error(
							`Error fetching OHLCV for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						const message = getErrorMessage(error);
						writeSubscribeError(call, isStreamClosed, {
							data: JSON.stringify({
								error: `Failed to fetch OHLCV: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
					}
					break;

				case SubscriptionType.BALANCE:
					try {
						await runCcxtSubscribeLoop(
							call,
							isStreamClosed,
							symbol,
							subscriptionType,
							() => broker.watchBalance(),
						);
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						log.error(`Error fetching balance for ${cex}:`, error);
						writeSubscribeError(call, isStreamClosed, {
							data: JSON.stringify({
								error: `Failed to fetch balance: ${message}`,
							}),
							timestamp: Date.now(),
							symbol,
							type: subscriptionType,
						});
					}
					break;

				case SubscriptionType.ORDERS:
					try {
						await runCcxtSubscribeLoop(
							call,
							isStreamClosed,
							resolvedSymbol,
							subscriptionType,
							() => broker.watchOrders(resolvedSymbol),
						);
					} catch (error: unknown) {
						log.error(
							`Error fetching orders for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						const message = getErrorMessage(error);
						writeSubscribeError(call, isStreamClosed, {
							data: JSON.stringify({
								error: `Failed to fetch orders: ${message}`,
							}),
							timestamp: Date.now(),
							symbol: resolvedSymbol,
							type: subscriptionType,
						});
					}
					break;

				default:
					writeSubscribeError(call, isStreamClosed, {
						data: JSON.stringify({ error: "Invalid subscription type" }),
						timestamp: Date.now(),
						symbol,
						type: subscriptionType,
					});
			}
		} catch (error) {
			log.error("Error in Subscribe stream:", error);
			const message = getErrorMessage(error);
			writeSubscribeError(call, isStreamClosed, {
				data: JSON.stringify({ error: `Internal server error: ${message}` }),
				timestamp: Date.now(),
				symbol: "",
				type: subscriptionType,
			});
		}
	};
}
