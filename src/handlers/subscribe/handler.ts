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
	selectBrokerAccount,
} from "../../helpers/broker";
import type { BrokerExecutionArchiver } from "../../helpers/broker-execution-archive";
import { archiveSubscribeStreamInBackground } from "../../helpers/broker-execution-archive";
import {
	getSubscriptionTypeName,
	resolveSubscriptionType,
	SubscriptionType,
	type SubscriptionType as SubscriptionTypeValue,
} from "../../helpers/constants";
import {
	type CredentialPolicy,
	CredentialPolicyConfigurationError,
	hasRequestCredentialMetadata,
	loadCredentialPolicyFromEnv,
	resolveCredentialSelection,
} from "../../helpers/credential-policy";
import { log } from "../../helpers/logger";
import {
	archiveCexStreamEventInBackground,
	archiveOhlcvInBackground,
	archiveOrderbookInBackground,
	archiveTickerInBackground,
	archiveTradesInBackground,
	bootstrapOhlcvHistory,
	createOhlcvBarTracker,
	createOrderbookSampler,
} from "../../helpers/market-data-archive";
import {
	type BrokerMarketType,
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
import { SubscribeBrokerLifecycle } from "./broker-lifecycle";

export type SubscribeDeps = {
	brokers: Record<string, BrokerPoolEntry>;
	whitelistIps: string[];
	otelMetrics?: OtelMetrics;
	brokerArchiver?: BrokerExecutionArchiver;
	brokerLifecycle?: SubscribeBrokerLifecycle;
	credentialPolicy?: CredentialPolicy;
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

function waitForSubscribeDrain(
	call: SubscribeCall,
	isClosed: () => boolean,
): Promise<boolean> {
	if (isClosed() || call.destroyed) {
		return Promise.resolve(false);
	}

	return new Promise((resolve) => {
		let settled = false;
		const cleanup = () => {
			call.off("drain", onDrain);
			call.off("close", onClosed);
			call.off("cancelled", onClosed);
			call.off("end", onClosed);
			call.off("error", onClosed);
		};
		const settle = (drained: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve(drained && !isClosed() && !call.destroyed);
		};
		const onDrain = () => settle(true);
		const onClosed = () => settle(false);

		call.once("drain", onDrain);
		call.once("close", onClosed);
		call.once("cancelled", onClosed);
		call.once("end", onClosed);
		call.once("error", onClosed);
	});
}

async function writeSubscribeFrame(
	call: SubscribeCall,
	isClosed: () => boolean,
	frame: SubscribeResponse,
): Promise<boolean> {
	if (isClosed() || call.destroyed) {
		return false;
	}
	const canContinue = call.write(frame);
	if (canContinue) {
		return true;
	}
	return waitForSubscribeDrain(call, isClosed);
}

async function writeSubscribeError(
	call: SubscribeCall,
	isClosed: () => boolean,
	frame: SubscribeResponse,
): Promise<void> {
	const frameWritten = await writeSubscribeFrame(call, isClosed, frame);
	if (frameWritten && !isClosed() && !call.destroyed) {
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
	archiveContext?: {
		archiver?: BrokerExecutionArchiver;
		otelMetrics?: OtelMetrics;
		exchange: string;
		accountSelector?: string;
		deploymentId: string;
		assetType: BrokerMarketType;
	},
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

			const receivedTimestamp = Date.now();
			if (
				!(await writeSubscribeFrame(call, isClosed, {
					data: JSON.stringify({
						subscriptionId: message.subscriptionId,
						event,
					} satisfies BinanceUserDataEvent),
					timestamp: receivedTimestamp,
					symbol,
					type: subscriptionType,
				}))
			) {
				break;
			}
			const archiveSubscriptionType =
				subscriptionType === SubscriptionType.BALANCE ? "BALANCE" : "ORDERS";
			archiveSubscribeStreamInBackground(archiveContext?.archiver, {
				exchange: archiveContext?.exchange ?? "binance",
				accountSelector: archiveContext?.accountSelector,
				symbol,
				subscriptionType: archiveSubscriptionType,
				streamPayload: event,
			});
			if (archiveContext) {
				archiveCexStreamEventInBackground(
					archiveContext.archiver,
					archiveContext.otelMetrics,
					{
						deploymentId: archiveContext.deploymentId,
						exchange: archiveContext.exchange,
						symbol,
						assetType: archiveContext.assetType,
						accountSelector: archiveContext.accountSelector,
						streamType: archiveSubscriptionType,
						payload: event,
						receivedTimestamp,
					},
				);
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
	archiveContext?: {
		archiver?: BrokerExecutionArchiver;
		otelMetrics?: OtelMetrics;
		exchange: string;
		accountSelector?: string;
		deploymentId: string;
		assetType: BrokerMarketType;
		archiveSubscriptionType?: "ORDERS" | "BALANCE";
	},
): Promise<void> {
	while (!isClosed()) {
		const data = await watch();
		const receivedTimestamp = Date.now();
		if (
			!(await writeSubscribeFrame(call, isClosed, {
				data: JSON.stringify(data),
				timestamp: receivedTimestamp,
				symbol,
				type: subscriptionType,
			}))
		) {
			break;
		}
		if (archiveContext?.archiveSubscriptionType) {
			archiveSubscribeStreamInBackground(archiveContext.archiver, {
				exchange: archiveContext.exchange,
				accountSelector: archiveContext.accountSelector,
				symbol,
				subscriptionType: archiveContext.archiveSubscriptionType,
				streamPayload: data,
			});
			archiveCexStreamEventInBackground(
				archiveContext.archiver,
				archiveContext.otelMetrics,
				{
					deploymentId: archiveContext.deploymentId,
					exchange: archiveContext.exchange,
					symbol,
					assetType: archiveContext.assetType,
					accountSelector: archiveContext.accountSelector,
					streamType: archiveContext.archiveSubscriptionType,
					payload: data,
					receivedTimestamp,
				},
			);
		}
	}
}

export function createSubscribeHandler(deps: SubscribeDeps) {
	const { brokers, whitelistIps, otelMetrics, brokerArchiver } = deps;
	const brokerLifecycle =
		deps.brokerLifecycle ?? new SubscribeBrokerLifecycle();
	const credentialPolicy =
		deps.credentialPolicy ?? loadCredentialPolicyFromEnv({});

	return async (call: SubscribeCall) => {
		const subscribeStartTime = Date.now();
		let streamClosed = false;
		let ownedBroker: Exchange | null = null;
		let ownedBrokerClosePromise: Promise<unknown> | undefined;
		const markStreamClosed = () => {
			streamClosed = true;
		};
		const isStreamClosed = () =>
			streamClosed || call.cancelled || call.writableEnded;
		const closeOwnedBroker = (): Promise<unknown> => {
			if (ownedBrokerClosePromise) {
				return ownedBrokerClosePromise;
			}
			if (!ownedBroker) {
				return Promise.resolve();
			}
			const broker = ownedBroker;
			ownedBroker = null;
			ownedBrokerClosePromise = brokerLifecycle.close(broker);
			return ownedBrokerClosePromise;
		};
		const closeOwnedBrokerOnCallEnd = () => {
			void closeOwnedBroker();
		};

		call.once("cancelled", markStreamClosed);
		call.once("cancelled", closeOwnedBrokerOnCallEnd);
		call.once("error", closeOwnedBrokerOnCallEnd);
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
		if (
			credentialPolicy.sourcePolicy === "provisioned_only" &&
			hasRequestCredentialMetadata(metadata)
		) {
			void otelMetrics?.recordCounter(
				"cex_request_credentials_rejected_total",
				1,
				{ rpc: "Subscribe" },
			);
			call.emit(
				"error",
				{
					code: grpc.status.PERMISSION_DENIED,
					message:
						"Request-supplied exchange credentials are forbidden by deployment policy",
				},
				null,
			);
			call.destroy();
			return;
		}
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
				await writeSubscribeError(call, isStreamClosed, {
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
			const brokerPool = brokers[normalizedCex as keyof typeof brokers];
			let selectedBrokerAccount = selectBrokerAccount(brokerPool, metadata);
			const publicOperation =
				subscriptionType === SubscriptionType.ORDERBOOK ||
				subscriptionType === SubscriptionType.TRADES ||
				subscriptionType === SubscriptionType.TICKER ||
				subscriptionType === SubscriptionType.OHLCV;
			const credentialSelection = resolveCredentialSelection({
				policy: credentialPolicy,
				selectedProvisionedBroker: selectedBrokerAccount?.exchange,
				publicOperation,
			});
			let selectedBroker: Exchange | null | undefined;
			let broker: Exchange | null;
			if (credentialSelection.mode === "public") {
				selectedBrokerAccount = null;
				selectedBroker = undefined;
				broker = createPublicBroker(normalizedCex);
			} else if (credentialSelection.mode === "provisioned") {
				selectedBroker = credentialSelection.broker;
				broker = credentialSelection.broker;
			} else {
				selectedBroker =
					selectedBrokerAccount?.exchange ??
					createBroker(normalizedCex, metadata);
				broker = selectedBroker ?? createPublicBroker(normalizedCex);
			}

			if (!broker) {
				await writeSubscribeError(call, isStreamClosed, {
					data: JSON.stringify({
						error: "Exchange not registered and no API metadata found",
					}),
					timestamp: Date.now(),
					symbol,
					type: subscriptionType,
				});
				return;
			}
			if (!selectedBrokerAccount) {
				ownedBroker = broker;
				brokerLifecycle.register(broker, {
					cex: normalizedCex,
					symbol,
				});
				if (isStreamClosed()) {
					await closeOwnedBroker();
					return;
				}
			}

			const resolvedSymbol = await resolveSubscriptionSymbol(
				broker,
				symbol,
				options?.marketType,
			);
			const assetType = parseMarketType(options?.marketType);
			const deploymentId = brokerArchiver?.getDeploymentId() ?? "unknown";
			const streamArchiveContext = {
				archiver: brokerArchiver,
				otelMetrics,
				exchange: normalizedCex,
				accountSelector: selectedBrokerAccount?.label,
				deploymentId,
				assetType,
			};

			if (
				isBinanceSpotAccountSubscription(
					normalizedCex,
					subscriptionType,
					options?.marketType,
				)
			) {
				const accountBroker = selectedBrokerAccount?.exchange ?? selectedBroker;
				if (!accountBroker) {
					await writeSubscribeError(call, isStreamClosed, {
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
					accountBroker,
					resolvedSymbol,
					subscriptionType,
					isStreamClosed,
					streamArchiveContext,
				);
				return;
			}

			switch (subscriptionType) {
				case SubscriptionType.ORDERBOOK:
					try {
						const orderbookSampler = createOrderbookSampler();
						while (!isStreamClosed()) {
							const depthLimit = parseOptionalDepthLimit(
								options?.depthLimit ?? options?.limit,
							);
							const orderbook =
								depthLimit === undefined
									? await broker.watchOrderBook(resolvedSymbol)
									: await broker.watchOrderBook(resolvedSymbol, depthLimit);
							const receivedTimestamp = Date.now();
							const normalizedSnapshot = normalizeOrderBookSnapshot(orderbook, {
								exchange: normalizedCex,
								symbol: resolvedSymbol,
								depthLimit:
									depthLimit ??
									Math.max(
										Array.isArray(orderbook?.bids) ? orderbook.bids.length : 0,
										Array.isArray(orderbook?.asks) ? orderbook.asks.length : 0,
									),
								receivedTimestamp,
							});
							if (
								!(await writeSubscribeFrame(call, isStreamClosed, {
									data: JSON.stringify(normalizedSnapshot),
									timestamp: receivedTimestamp,
									symbol: resolvedSymbol,
									type: subscriptionType,
								}))
							) {
								break;
							}
							const shouldArchive =
								orderbookSampler.shouldEmit(receivedTimestamp);
							archiveOrderbookInBackground(
								brokerArchiver,
								otelMetrics,
								{
									deploymentId,
									exchange: normalizedCex,
									symbol: resolvedSymbol,
									assetType,
									accountSelector: selectedBrokerAccount?.label,
									snapshot: normalizedSnapshot,
								},
								{
									sampledOut: !shouldArchive,
								},
							);
						}
					} catch (error: unknown) {
						log.error(
							`Error fetching orderbook for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						const message = getErrorMessage(error);
						await writeSubscribeError(call, isStreamClosed, {
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
						while (!isStreamClosed()) {
							const data = await broker.watchTrades(resolvedSymbol);
							const receivedTimestamp = Date.now();
							if (
								!(await writeSubscribeFrame(call, isStreamClosed, {
									data: JSON.stringify(data),
									timestamp: receivedTimestamp,
									symbol: resolvedSymbol,
									type: subscriptionType,
								}))
							) {
								break;
							}
							archiveTradesInBackground(brokerArchiver, otelMetrics, {
								deploymentId,
								exchange: normalizedCex,
								symbol: resolvedSymbol,
								assetType,
								accountSelector: selectedBrokerAccount?.label,
								payload: data,
								receivedTimestamp,
							});
						}
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						log.error(
							`Error fetching trades for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						await writeSubscribeError(call, isStreamClosed, {
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
						while (!isStreamClosed()) {
							const data = await broker.watchTicker(resolvedSymbol);
							const receivedTimestamp = Date.now();
							if (
								!(await writeSubscribeFrame(call, isStreamClosed, {
									data: JSON.stringify(data),
									timestamp: receivedTimestamp,
									symbol: resolvedSymbol,
									type: subscriptionType,
								}))
							) {
								break;
							}
							archiveTickerInBackground(brokerArchiver, otelMetrics, {
								deploymentId,
								exchange: normalizedCex,
								symbol: resolvedSymbol,
								assetType,
								accountSelector: selectedBrokerAccount?.label,
								payload: data,
								receivedTimestamp,
							});
						}
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						log.error(
							`Error fetching ticker for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						await writeSubscribeError(call, isStreamClosed, {
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
						const ohlcvBarTracker = createOhlcvBarTracker();
						const ohlcvArchiveInput = {
							deploymentId,
							exchange: normalizedCex,
							symbol: resolvedSymbol,
							assetType,
							timeframe,
							accountSelector: selectedBrokerAccount?.label,
							receivedTimestamp: Date.now(),
							payload: [],
						};
						const bootstrapPayload = await bootstrapOhlcvHistory(
							broker,
							brokerArchiver,
							otelMetrics,
							ohlcvBarTracker,
							ohlcvArchiveInput,
							{ bootstrapLimit: options?.bootstrapLimit },
						);
						let ohlcvStreamActive = true;
						if (bootstrapPayload) {
							const bootstrapTimestamp = Date.now();
							const bootstrapSent = await writeSubscribeFrame(
								call,
								isStreamClosed,
								{
									data: JSON.stringify(bootstrapPayload),
									timestamp: bootstrapTimestamp,
									symbol: resolvedSymbol,
									type: subscriptionType,
								},
							);
							if (!bootstrapSent) {
								ohlcvStreamActive = false;
							}
						}
						while (ohlcvStreamActive && !isStreamClosed()) {
							const data = await broker.watchOHLCV(resolvedSymbol, timeframe);
							const receivedTimestamp = Date.now();
							if (
								!(await writeSubscribeFrame(call, isStreamClosed, {
									data: JSON.stringify(data),
									timestamp: receivedTimestamp,
									symbol: resolvedSymbol,
									type: subscriptionType,
								}))
							) {
								break;
							}
							archiveOhlcvInBackground(
								brokerArchiver,
								otelMetrics,
								ohlcvBarTracker,
								{
									deploymentId,
									exchange: normalizedCex,
									symbol: resolvedSymbol,
									assetType,
									timeframe,
									accountSelector: selectedBrokerAccount?.label,
									payload: data,
									receivedTimestamp,
								},
							);
						}
					} catch (error: unknown) {
						log.error(
							`Error fetching OHLCV for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						const message = getErrorMessage(error);
						await writeSubscribeError(call, isStreamClosed, {
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
							{
								...streamArchiveContext,
								archiveSubscriptionType: "BALANCE",
							},
						);
					} catch (error: unknown) {
						const message = getErrorMessage(error);
						log.error(`Error fetching balance for ${cex}:`, error);
						await writeSubscribeError(call, isStreamClosed, {
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
							{
								...streamArchiveContext,
								archiveSubscriptionType: "ORDERS",
							},
						);
					} catch (error: unknown) {
						log.error(
							`Error fetching orders for ${resolvedSymbol} on ${cex}:`,
							error,
						);
						const message = getErrorMessage(error);
						await writeSubscribeError(call, isStreamClosed, {
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
					await writeSubscribeError(call, isStreamClosed, {
						data: JSON.stringify({ error: "Invalid subscription type" }),
						timestamp: Date.now(),
						symbol,
						type: subscriptionType,
					});
			}
		} catch (error) {
			if (error instanceof CredentialPolicyConfigurationError) {
				call.emit(
					"error",
					{
						code:
							error.kind === "missing_provisioned_broker"
								? grpc.status.UNAUTHENTICATED
								: grpc.status.PERMISSION_DENIED,
						message: error.message,
					},
					null,
				);
				call.destroy();
				return;
			}
			log.error("Error in Subscribe stream:", error);
			const message = getErrorMessage(error);
			await writeSubscribeError(call, isStreamClosed, {
				data: JSON.stringify({ error: `Internal server error: ${message}` }),
				timestamp: Date.now(),
				symbol: "",
				type: subscriptionType,
			});
		} finally {
			call.off("cancelled", closeOwnedBrokerOnCallEnd);
			call.off("error", closeOwnedBrokerOnCallEnd);
			await closeOwnedBroker();
		}
	};
}
