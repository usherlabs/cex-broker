import { authenticateRequest, validateDeposit, validateOrder, validateWithdraw } from "./helpers";
import type { PolicyConfig } from "./types";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "../proto/node";
import path from "path";
import type { Exchange } from "@usherlabs/ccxt";
import type {
	ActionRequest,
} from "../proto/cexBroker/ActionRequest";
import type { ActionResponse } from "../proto/cexBroker/ActionResponse";
import { Action } from "../proto/cexBroker/Action";
import type { SubscribeRequest } from "../proto/cexBroker/SubscribeRequest";
import type { SubscribeResponse } from "../proto/cexBroker/SubscribeResponse";
import { SubscriptionType } from "../proto/cexBroker/SubscriptionType";
import Joi from "joi";
import ccxt from "@usherlabs/ccxt";
import { log } from "./helpers/logger";

const PROTO_FILE = "../proto/node.proto";

const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_FILE));
const grpcObj = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;
const cexNode = grpcObj.cexBroker;



export function getServer(
	policy: PolicyConfig,
	brokers: Record<string, { primary: Exchange; secondaryBrokers: Exchange[] }>,
	whitelistIps: string[],
	useVerity: boolean,
	verityProverUrl: string,
) {
	const server = new grpc.Server();
	function createBroker(cex: string, metadata: grpc.Metadata, secondaryBrokers: Exchange[]): Exchange | null {
		const api_key = metadata.get("api-key");
		const api_secret = metadata.get("api-secret");
		const use_secondary_key = metadata.get("use-secondary-key");
		if (use_secondary_key.length > 0) {
			const keyIndex = Number.isInteger(+(use_secondary_key[use_secondary_key.length - 1] ?? "0"))
			return secondaryBrokers[+keyIndex] ?? null
		}

		const ExchangeClass = (ccxt.pro as any)[cex];

		metadata.remove("api-key");
		metadata.remove("api-secret");
		if (api_secret.length == 0 || api_key.length == 0) {
			return null;
		}
		const exchange = new ExchangeClass({
			apiKey: api_key[0],
			secret: api_secret[0],
			enableRateLimit: true,
			defaultType: "spot",
			useVerity: useVerity,
			verityProverUrl: verityProverUrl,
			timeout: 150 * 1000,
			options: {
				adjustForTimeDifference: true,
				recvWindow: 60000
			}
		});
		exchange.options['recvWindow'] = 60000;
		return exchange;
	}
	server.addService(cexNode.CexService.service, {
		ExecuteAction: async (
			call: grpc.ServerUnaryCall<ActionRequest, ActionResponse>,
			callback: grpc.sendUnaryData<ActionResponse>,
		) => {
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
			const { action, payload, cex, symbol } = call.request;
			// Validate required fields
			if (!action || !cex || !symbol) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: "action, cex, symbol, and cex are required",
					},
					null,
				);
			}

			const broker =
				brokers[cex as keyof typeof brokers]?.primary ?? createBroker(cex, metadata, brokers[cex as keyof typeof brokers]?.secondaryBrokers ?? []);


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
					});
					const { value, error } = transactionSchema.validate(
						call.request.payload ?? {},
					);
					if (error) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: "ValidationError:" + error.message,
							},
							null,
						);
					}
					try {
						const deposits = await broker.fetchDeposits(symbol, 50);
						const deposit = deposits.find(
							(deposit) =>
								deposit.id == value.transactionHash ||
								deposit.txid == value.transactionHash,
						);

						if (deposit) {
							log.info(
								`Amount ${value.amount} at ${value.transactionHash} . Paid to ${value.recipientAddress}`,
							);
							return callback(null, { result: useVerity ? broker.last_proof : JSON.stringify({ ...deposit }) });
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
					})
					const { value: fetchDepositAddresses, error: errorFetchDepositAddresses } = fetchDepositAddressesSchema.validate(
						call.request.payload ?? {},
					);
					if (errorFetchDepositAddresses) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: "ValidationError: " + errorFetchDepositAddresses?.message,
							},
							null,
						);
					}
					try {
						const depositAddresses = broker.has.fetchDepositAddress == true ? await broker.fetchDepositAddress(symbol, { network: fetchDepositAddresses.chain }) : await broker.fetchDepositAddressesByNetwork(symbol, { network: fetchDepositAddresses.chain });

						if (depositAddresses) {
							return callback(null, { result: useVerity ? broker.last_proof : JSON.stringify({ ...depositAddresses }) });
						}
						callback(
							{
								code: grpc.status.INTERNAL,
								message: "Deposit confirmation failed",
							},
							null,
						);
					} catch (error: any) {
						log.error({ error });
						callback(
							{
								code: grpc.status.INTERNAL,
								message: "Fetch Deposit Addresses confirmation failed: " + error.message,
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
					});
					const { value: transferValue, error: transferError } =
						transferSchema.validate(call.request.payload ?? {})
					if (transferError) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: "ValidationError:" + transferError?.message,
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
						log.info("Transfer Transfer" + JSON.stringify(transaction)
						);

						callback(null, { result: useVerity ? broker.last_proof : JSON.stringify({ ...transaction }) });
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
					});
					const { value: orderValue, error: orderError } =
						createOrderSchema.validate(call.request.payload ?? {});
					if (orderError) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: "ValidationError:" + orderError.message,
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
					});
					const { value: getOrderValue, error: getOrderError } =
						getOrderSchema.validate(call.request.payload ?? {})
					// Validate required fields
					if (getOrderError) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: "ValidationError:" + getOrderError.message,
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

						const orderDetails = await broker.fetchOrder(getOrderValue.orderId);

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
					});
					const { value: cancelOrderValue, error: cancelOrderError } =
						cancelOrderSchema.validate(call.request.payload ?? {});
					// Validate required fields
					if (cancelOrderError) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: "ValidationError:" + cancelOrderError.message,
							},
							null,
						);
					}

					const cancelledOrder = await broker.cancelOrder(
						cancelOrderValue.orderId,
					);

					callback(null, {
						result: JSON.stringify({ ...cancelledOrder }),
					});
					break;
				}
				case Action.FetchBalance:
					try {
						// Fetch balance from the specified CEX
						const balance = (await broker.fetchFreeBalance()) as any;
						const currencyBalance = balance[symbol];

						callback(null, {
							result: useVerity ? broker.last_proof : JSON.stringify({
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
				call.emit('error',
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

				// Validate required fields
				if (!cex || !symbol || type === undefined) {
					call.write({
						data: JSON.stringify({
							error: "cex, symbol, and type are required",
						}),
						timestamp: Date.now(),
						symbol: symbol || "",
						type: type || SubscriptionType.ORDERBOOK,
					});
					call.end();
					return;
				}

				// Get or create broker
				broker =
					brokers[cex as keyof typeof brokers]?.primary ?? createBroker(cex, metadata, brokers[cex as keyof typeof brokers]?.secondaryBrokers ?? []);

				if (!broker) {
					call.write({
						data: JSON.stringify({
							error: "Exchange not registered and no API metadata found",
						}),
						timestamp: Date.now(),
						symbol,
						type,
					});
					call.end();
					return;
				}

				// Handle different subscription types
				switch (type) {
					case SubscriptionType.ORDERBOOK:
						try {
							while (true) {
								const orderbook = await broker.watchOrderBook(symbol);
								call.write({
									data: JSON.stringify(orderbook),
									timestamp: Date.now(),
									symbol,
									type,
								});
							}
						} catch (error: any) {
							log.error(
								`Error fetching orderbook for ${symbol} on ${cex}:`,
								error,
							);
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch orderbook: ${error.message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type,
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
									type,
								});
							}
						} catch (error: any) {
							log.error(
								`Error fetching trades for ${symbol} on ${cex}:`,
								error.message,
							);
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch trades: ${error.message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type,
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
						} catch (error: any) {
							log.error(
								`Error fetching ticker for ${symbol} on ${cex}:`,
								error.message,
							);
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch ticker: ${error.message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type,
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
						} catch (error: any) {
							log.error(
								`Error fetching OHLCV for ${symbol} on ${cex}:`,
								error.message,
							);
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch OHLCV: ${error.message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type,
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
						} catch (error: any) {
							log.error(`Error fetching balance for ${cex}:`, error.message);
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch balance: ${error.message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type,
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
						} catch (error: any) {
							log.error(
								`Error fetching orders for ${symbol} on ${cex}:`,
								error,
							);
							call.write({
								data: JSON.stringify({
									error: `Failed to fetch orders: ${error.message}`,
								}),
								timestamp: Date.now(),
								symbol,
								type,
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
				call.write({
					data: JSON.stringify({ error: `Internal server error: ${error}` }),
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
