import {
	authenticateRequest,
	createBroker,
	selectBroker,
	validateOrder,
	validateWithdraw,
} from "./helpers";
import type { PolicyConfig } from "./types";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "./proto/node";
import type { Exchange } from "@usherlabs/ccxt";
import type { ActionRequest } from "./proto/cex_broker/ActionRequest";
import type { ActionResponse } from "./proto/cex_broker/ActionResponse";
import { Action } from "./proto/cex_broker/Action";
import type { SubscribeRequest } from "./proto/cex_broker/SubscribeRequest";
import type { SubscribeResponse } from "./proto/cex_broker/SubscribeResponse";
import { SubscriptionType } from "./proto/cex_broker/SubscriptionType";
import Joi from "joi";
import { log } from "./helpers/logger";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Safe absolute path to proto
const protoPath = path.join(__dirname, ".", "proto", "node.proto");

const packageDef = protoLoader.loadSync(protoPath);
const grpcObj = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;
const cexNode = grpcObj.cex_broker;

export function getServer(
	policy: PolicyConfig,
	brokers: Record<string, { primary: Exchange; secondaryBrokers: Exchange[] }>,
	whitelistIps: string[],
	useVerity: boolean,
	verityProverUrl: string,
) {
	const server = new grpc.Server();

	server.addService(cexNode.cex_service.service, {
		ExecuteAction: async (
			call: grpc.ServerUnaryCall<ActionRequest, ActionResponse>,
			callback: grpc.sendUnaryData<ActionResponse>,
		) => {
			// Log incoming request
			log.info(
				`Request - ExecuteAction: ${JSON.stringify({
					action: call.request.action,
					cex: call.request.cex,
					symbol: call.request.symbol,
				})}`,
			);

			// IP Authentication
			if (!authenticateRequest(call, whitelistIps)) {
				return callback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: "Access denied: Unauthorized IP",
					},
					null,
				);
			}
			// Read incoming metadata
			const metadata = call.metadata;
			const { action, cex, symbol } = call.request;
			// Validate required fields
			if (!action || !cex) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: "action, cex, symbol, and cex are required",
					},
					null,
				);
			}

			const broker =
				selectBroker(brokers[cex as keyof typeof brokers], metadata) ??
				createBroker(cex, metadata, useVerity, verityProverUrl);

			if (!broker) {
				return callback(
					{
						code: grpc.status.UNAUTHENTICATED,
						message: `This Exchange is not registered and No API metadata ws found`,
					},
					null,
				);
			}

			switch (action) {
				case Action.Deposit: {
					const transactionSchema = Joi.object({
						recipientAddress: Joi.string().required(),
						amount: Joi.number().positive().required(), // Must be a positive number
						transactionHash: Joi.string().required(),
						since: Joi.number(),
						params: Joi.object()
							.pattern(Joi.string(), Joi.string())
							.default({}),
					});
					const { value, error } = transactionSchema.validate(
						call.request.payload ?? {},
					);
					if (error) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError: ${error.message}`,
							},
							null,
						);
					}
					try {
						const deposits = await broker.fetchDeposits(
							symbol,
							value.since,
							50,
							{ ...(value.params ?? {}) },
						);
						const deposit = deposits.find(
							(deposit) =>
								deposit.id === value.transactionHash ||
								deposit.txid === value.transactionHash,
						);

						if (deposit) {
							log.info(
								`Amount ${value.amount} at ${value.transactionHash} . Paid to ${value.recipientAddress}`,
							);
							return callback(null, {
								proof: broker.last_proof || "",
								result: JSON.stringify({ ...deposit }),
							});
						}
						callback(
							{
								code: grpc.status.INTERNAL,
								message: "Deposit confirmation failed",
							},
							null,
						);
					} catch (error) {
						log.error({ error });
						callback(
							{
								code: grpc.status.INTERNAL,
								message: "Deposit confirmation failed",
							},
							null,
						);
					}
					break;
				}

				case Action.FetchDepositAddresses: {
					const fetchDepositAddressesSchema = Joi.object({
						chain: Joi.string().required(),
						params: Joi.object()
							.pattern(Joi.string(), Joi.string())
							.default({}),
					});
					const {
						value: fetchDepositAddresses,
						error: errorFetchDepositAddresses,
					} = fetchDepositAddressesSchema.validate(call.request.payload ?? {});
					if (errorFetchDepositAddresses) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError: ${errorFetchDepositAddresses?.message}`,
							},
							null,
						);
					}
					try {
						const depositAddresses =
							broker.has.fetchDepositAddress === true
								? await broker.fetchDepositAddress(symbol, {
										network: fetchDepositAddresses.chain,
										...(fetchDepositAddresses.params ?? {}),
									})
								: await broker.fetchDepositAddressesByNetwork(symbol, {
										network: fetchDepositAddresses.chain,
										...(fetchDepositAddresses.params ?? {}),
									});

						if (depositAddresses) {
							return callback(null, {
								proof: broker.last_proof || "",
								result: JSON.stringify({ ...depositAddresses }),
							});
						}
						callback(
							{
								code: grpc.status.INTERNAL,
								message: "Deposit confirmation failed",
							},
							null,
						);
					} catch (error: unknown) {
						log.error({ error });
						const message =
							error instanceof Error
								? error.message
								: typeof error === "string"
									? error
									: "Unknown error";
						callback(
							{
								code: grpc.status.INTERNAL,
								message:
									"Fetch Deposit Addresses confirmation failed: " + message,
							},
							null,
						);
					}
					break;
				}
				case Action.Transfer: {
					const transferSchema = Joi.object({
						recipientAddress: Joi.string().required(),
						amount: Joi.number().positive().required(), // Must be a positive number
						chain: Joi.string().required(),
						params: Joi.object()
							.pattern(Joi.string(), Joi.string())
							.default({}),
					});
					const { value: transferValue, error: transferError } =
						transferSchema.validate(call.request.payload ?? {});
					if (transferError) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError:" ${transferError?.message}`,
							},
							null,
						);
					}
					// Validate against policy
					const transferValidation = validateWithdraw(
						policy,
						transferValue.chain,
						transferValue.recipientAddress,
						Number(transferValue.amount),
						symbol,
					);
					if (!transferValidation.valid) {
						return callback(
							{
								code: grpc.status.PERMISSION_DENIED,
								message: transferValidation.error,
							},
							null,
						);
					}
					try {
						const data = await broker.fetchCurrencies("USDT");
						const networks = Object.keys(
							(data[symbol] ?? { networks: [] }).networks,
						);

						if (!networks.includes(transferValue.chain)) {
							return callback(
								{
									code: grpc.status.INTERNAL,
									message: `Broker ${cex} doesnt support this ${transferValue.chain} for token ${symbol}`,
								},
								null,
							);
						}
						const transaction = await broker.withdraw(
							symbol,
							Number(transferValue.amount),
							transferValue.recipientAddress,
							undefined,
							{ network: transferValue.chain },
						);
						log.info(`Transfer Transfer: ${JSON.stringify(transaction)}`);

						callback(null, {
							proof: broker.last_proof || "",
							result: JSON.stringify({ ...transaction }),
						});
					} catch (error) {
						log.error({ error });
						callback(
							{
								code: grpc.status.INTERNAL,
								message: "Transfer failed",
							},
							null,
						);
					}
					break;
				}

				case Action.CreateOrder: {
					const createOrderSchema = Joi.object({
						orderType: Joi.string().valid("market", "limit").default("limit"),
						amount: Joi.number().positive().required(), // Must be a positive number
						fromToken: Joi.string().required(),
						toToken: Joi.string().required(),
						price: Joi.number().positive().required(),
						params: Joi.object()
							.pattern(Joi.string(), Joi.string())
							.default({}),
					});
					const { value: orderValue, error: orderError } =
						createOrderSchema.validate(call.request.payload ?? {});
					if (orderError) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError:" ${orderError.message}`,
							},
							null,
						);
					}
					const validation = validateOrder(
						policy,
						orderValue.fromToken,
						orderValue.toToken,
						Number(orderValue.amount),
						cex,
					);
					if (!validation.valid) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: validation.error,
							},
							null,
						);
					}

					try {
						const market = policy.order.rule.markets.find(
							(market) =>
								market.includes(
									`${orderValue.fromToken}/${orderValue.toToken}`,
								) ||
								market.includes(
									`${orderValue.toToken}/${orderValue.fromToken}`,
								),
						);
						const symbol = market?.split(":")[1] ?? "";
						const [from, _to] = symbol.split("/");

						if (!broker) {
							return callback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
								},
								null,
							);
						}

						const order = await broker.createOrder(
							symbol,
							orderValue.orderType,
							from === orderValue.fromToken ? "sell" : "buy",
							Number(orderValue.amount),
							Number(orderValue.price),
							orderValue.params ?? {},
						);

						callback(null, { result: JSON.stringify({ ...order }) });
					} catch (error) {
						log.error({ error });
						callback(
							{
								code: grpc.status.INTERNAL,
								message: "Order Creation failed",
							},
							null,
						);
					}

					break;
				}

				case Action.GetOrderDetails: {
					const getOrderSchema = Joi.object({
						orderId: Joi.string().required(),
						params: Joi.object()
							.pattern(Joi.string(), Joi.string())
							.default({}),
					});
					const { value: getOrderValue, error: getOrderError } =
						getOrderSchema.validate(call.request.payload ?? {});
					// Validate required fields
					if (getOrderError) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError: ${getOrderError.message}`,
							},
							null,
						);
					}

					try {
						// Validate CEX key
						if (!broker) {
							return callback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
								},
								null,
							);
						}

						const orderDetails = await broker.fetchOrder(
							getOrderValue.orderId,
							{ ...getOrderValue.params },
						);

						callback(null, {
							result: JSON.stringify({
								orderId: orderDetails.id,
								status: orderDetails.status,
								originalAmount: orderDetails.amount,
								filledAmount: orderDetails.filled,
								symbol: orderDetails.symbol,
								mode: orderDetails.side,
								price: orderDetails.price,
							}),
						});
					} catch (error) {
						log.error(`Error fetching order details from ${cex}:`, error);
						callback(
							{
								code: grpc.status.INTERNAL,
								message: `Failed to fetch order details from ${cex}`,
							},
							null,
						);
					}
					break;
				}
				case Action.CancelOrder: {
					const cancelOrderSchema = Joi.object({
						orderId: Joi.string().required(),
						params: Joi.object()
							.pattern(Joi.string(), Joi.string())
							.default({}),
					});
					const { value: cancelOrderValue, error: cancelOrderError } =
						cancelOrderSchema.validate(call.request.payload ?? {});
					// Validate required fields
					if (cancelOrderError) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError:  ${cancelOrderError.message}`,
							},
							null,
						);
					}

					const cancelledOrder = await broker.cancelOrder(
						cancelOrderValue.orderId,
						cancelOrderValue.params ?? {},
					);

					callback(null, {
						result: JSON.stringify({ ...cancelledOrder }),
					});
					break;
				}
				case Action.FetchBalance:
					try {
						// Fetch balance from the specified CEX
						const balance = (await broker.fetchFreeBalance({
							...(call.request.payload ?? {}),
							// biome-ignore lint/suspicious/noExplicitAny: invalid typing
						})) as any;
						const currencyBalance = balance[symbol];

						callback(null, {
							proof: broker.last_proof || "",
							result: JSON.stringify({
								balance: currencyBalance || 0,
								currency: symbol,
							}),
						});
					} catch (error) {
						log.error(`Error fetching balance from ${cex}:`, error);
						callback(
							{
								code: grpc.status.INTERNAL,
								message: `Failed to fetch balance from ${cex}`,
							},
							null,
						);
					}
					break;

				case Action.FetchBalances:
					try {
						// Fetch balance from the specified CEX
						const balance = (await broker.fetchFreeBalance({
							...(call.request.payload ?? {}),
							// biome-ignore lint/suspicious/noExplicitAny: invalid typing
						})) as any;

						callback(null, {
							proof: broker.last_proof || "",
							result: JSON.stringify(balance),
						});
					} catch (error) {
						log.error(`Error fetching balance from ${cex}:`, error);
						callback(
							{
								code: grpc.status.INTERNAL,
								message: `Failed to fetch balance from ${cex}`,
							},
							null,
						);
					}
					break;

				case Action.FetchTicker:
					try {
						const ticker = await broker.fetchTicker(symbol);
						callback(null, {
							proof: broker.last_proof || "",
							result: JSON.stringify(ticker),
						});
					} catch (error) {
						log.error(`Error fetching ticker from ${cex}:`, error);
						callback(
							{
								code: grpc.status.INTERNAL,
								message: `Failed to fetch ticker from ${cex}`,
							},
							null,
						);
					}
					break;

				default:
					return callback({
						code: grpc.status.INVALID_ARGUMENT,
						message: "Invalid Action",
					});
			}
		},

		Subscribe: async (
			call: grpc.ServerWritableStream<SubscribeRequest, SubscribeResponse>,
		) => {
			// IP Authentication
			if (!authenticateRequest(call, whitelistIps)) {
				call.emit(
					"error",
					{
						code: grpc.status.PERMISSION_DENIED,
						message: "Access denied: Unauthorized IP",
					},
					null,
				);
				call.destroy(new Error("Access denied: Unauthorized IP"));
			}
			// Read incoming metadata
			const metadata = call.metadata;
			let broker: Exchange | null = null;

			try {
				// For ServerWritableStream, we need to get the request from the call
				// The request should be available in the call object
				const request = call.request as SubscribeRequest;
				const { cex, symbol, type, options } = request;

				// Handle protobuf default value issue: type=0 (ORDERBOOK) gets omitted during serialization
				const subscriptionType =
					type !== undefined ? type : SubscriptionType.ORDERBOOK;

				log.info(
					`Request - Subscribe: ${JSON.stringify({
						cex: request.cex,
						symbol: request.symbol,
						type: subscriptionType,
					})}`,
				);

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

				// Get or create broker
				broker =
					selectBroker(brokers[cex as keyof typeof brokers], metadata) ??
					createBroker(cex, metadata, useVerity, verityProverUrl);

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

				// Handle different subscription types
				switch (subscriptionType) {
					case SubscriptionType.ORDERBOOK:
						try {
							while (true) {
								const orderbook = await broker.watchOrderBook(symbol);
								call.write({
									data: JSON.stringify(orderbook),
									timestamp: Date.now(),
									symbol,
									type: subscriptionType,
								});
							}
						} catch (error: unknown) {
							log.error(
								`Error fetching orderbook for ${symbol} on ${cex}:`,
								error,
							);
							const message =
								error instanceof Error
									? error.message
									: typeof error === "string"
										? error
										: "Unknown error";
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch orderbook: ${message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type: subscriptionType,
							});
						}
						break;

					case SubscriptionType.TRADES:
						try {
							while (true) {
								const trades = await broker.watchTrades(symbol);
								call.write({
									data: JSON.stringify(trades),
									timestamp: Date.now(),
									symbol,
									type: subscriptionType,
								});
							}
						} catch (error: unknown) {
							const message =
								error instanceof Error
									? error.message
									: typeof error === "string"
										? error
										: "Unknown error";
							log.error(
								`Error fetching trades for ${symbol} on ${cex}:`,
								error,
							);
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch trades: ${message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type: subscriptionType,
							});
						}
						break;

					case SubscriptionType.TICKER:
						try {
							while (true) {
								const ticker = await broker.watchTicker(symbol);
								call.write({
									data: JSON.stringify(ticker),
									timestamp: Date.now(),
									symbol,
									type,
								});
							}
						} catch (error: unknown) {
							const message =
								error instanceof Error
									? error.message
									: typeof error === "string"
										? error
										: "Unknown error";
							log.error(
								`Error fetching ticker for ${symbol} on ${cex}:`,
								error,
							);
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch ticker: ${message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type: subscriptionType,
							});
						}
						break;

					case SubscriptionType.OHLCV:
						try {
							while (true) {
								const timeframe = options?.timeframe || "1m";
								const ohlcv = await broker.fetchOHLCVWs(symbol, timeframe);
								call.write({
									data: JSON.stringify(ohlcv),
									timestamp: Date.now(),
									symbol,
									type,
								});
							}
						} catch (error: unknown) {
							log.error(`Error fetching OHLCV for ${symbol} on ${cex}:`, error);
							const message =
								error instanceof Error
									? error.message
									: typeof error === "string"
										? error
										: "Unknown error";
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch OHLCV: ${message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type: subscriptionType,
							});
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
									type,
								});
							}
						} catch (error: unknown) {
							const message =
								error instanceof Error
									? error.message
									: typeof error === "string"
										? error
										: "Unknown error";
							log.error(`Error fetching balance for ${cex}:`, error);
							call.write({
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
							while (true) {
								const orders = await broker.watchOrders(symbol);
								call.write({
									data: JSON.stringify(orders),
									timestamp: Date.now(),
									symbol,
									type,
								});
							}
						} catch (error: unknown) {
							log.error(
								`Error fetching orders for ${symbol} on ${cex}:`,
								error,
							);
							const message =
								error instanceof Error
									? error.message
									: typeof error === "string"
										? error
										: "Unknown error";
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch orders: ${message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type: subscriptionType,
							});
						}
						break;

					default:
						call.write({
							data: JSON.stringify({ error: "Invalid subscription type" }),
							timestamp: Date.now(),
							symbol,
							type,
						});
				}
			} catch (error) {
				log.error("Error in Subscribe stream:", error);
				const message =
					error instanceof Error
						? error.message
						: typeof error === "string"
							? error
							: "Unknown error";
				call.write({
					data: JSON.stringify({ error: `Internal server error: ${message}` }),
					timestamp: Date.now(),
					symbol: "",
					type: SubscriptionType.ORDERBOOK,
				});
			}

			call.on("end", () => {
				log.info("Subscribe stream ended");
			});

			call.on("error", (error) => {
				log.error("Subscribe stream error:", error);
			});
		},
	});
	return server;
}
