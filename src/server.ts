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
import descriptor from "./proto/node.descriptor.ts";
import {
	verityHttpClientOverridePredicate,
	buildHttpClientOverrideFromMetadata,
} from "./helpers";

// TODO: remove if https://github.com/usherlabs/verity-dp/pull/85 is approved else keep for FIET-364
process.on("unhandledRejection", (reason) => {
	console.error("[unhandledRejection]", reason);
});

const packageDef = protoLoader.fromJSON(
	descriptor as unknown as Record<string, unknown>,
);
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
			log.info(`Request - ExecuteAction:`, {
				action: call.request.action,
				cex: call.request.cex,
				symbol: call.request.symbol,
			});

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
						message: "`action` AND `cex` fields are required",
					},
					null,
				);
			}

			// If the Exchange is not already pre-loaded for preset API credentials via constructor - createBroker for non-gated APIs may be available for other exchanges.
			const broker =
				selectBroker(brokers[cex as keyof typeof brokers], metadata) ??
				createBroker(cex, metadata);

			if (!broker) {
				return callback(
					{
						code: grpc.status.UNAUTHENTICATED,
						message: `This Exchange is not registered and No API metadata ws found`,
					},
					null,
				);
			}

			// Verity only for ExecuteAction
			let verityProof = "";
			if (useVerity) {
				const override = buildHttpClientOverrideFromMetadata(
					metadata,
					verityProverUrl,
					(proof, notaryPubKey) => {
						verityProof = proof;
						log.debug(`Verity proof:`, { proof, notaryPubKey });
					},
				);
				broker.setHttpClientOverride(
					override,
					verityHttpClientOverridePredicate,
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
								proof: verityProof,
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

				case Action.FetchCurrency: {
					if (!symbol) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError: Symbol requied`,
							},
							null,
						);
					}
					try {
						const currencies = await broker.fetchCurrencies(symbol);
						const currencyInfo = currencies[symbol];
						if (!currencyInfo) {
							return callback(
								{
									code: grpc.status.NOT_FOUND,
									message: `Currency not found for ${symbol}`,
								},
								null,
							);
						}
						callback(null, {
							proof: verityProof,
							result: JSON.stringify(currencyInfo),
						});
					} catch (error) {
						log.error(`Error fetching currency ${symbol} from ${cex}:`, error);
						callback(
							{
								code: grpc.status.INTERNAL,
								message: `Failed to fetch currency for ${symbol} from ${cex}`,
							},
							null,
						);
					}
					break;
				}
				case Action.FetchAccountId: {
					try {
						if (cex.toLowerCase() === "bybit") {
							const query = await (broker as any).privateGetV5UserQueryApi();
							callback(null, {
								proof: verityProof,
								result: JSON.stringify({
									accountId: query.id,
									uid: query.userID,
								}),
							});
						} else if (cex.toLowerCase() === "binance") {
							const query = await (broker as any).privateGetAccount();
							callback(null, {
								proof: verityProof,
								result: JSON.stringify({
									accountId: query.uid,
									uid: query.uid,
								}),
							});
						} else if (cex.toLowerCase() === "mexc") {
							const query = await (broker as any).spotPrivateGetUid();
							callback(null, {
								proof: verityProof,
								result: JSON.stringify({
									accountId: query.uid,
									uid: query.uid,
								}),
							});
						} else {
							log.error(`Error: fetching account ID not supported on ${cex}`);
							callback(
								{
									code: grpc.status.INTERNAL,
									message: `Error: fetching account ID not supported on ${cex}`,
								},
								null,
							);
						}
					} catch (error) {
						log.error(`Error fetching account ID ${cex}:`, error);
						callback(
							{
								code: grpc.status.INTERNAL,
								message: `Error fetching account ID from ${cex}`,
							},
							null,
						);
					}
					break;
				}

				case Action.Call: {
					const callSchema = Joi.object({
						functionName: Joi.string()
							.pattern(/^[A-Za-z][A-Za-z0-9]*$/)
							.required(),
						args: Joi.array()
							.items(
								Joi.alternatives(
									Joi.string(),
									Joi.number(),
									Joi.boolean(),
									Joi.object(),
									Joi.array(),
								),
							)
							.default([]),
						params: Joi.object().default({}),
					});

					// Normalise payload coming from protobuf map<string, string>
					// to support JSON-encoded complex types for args/params
					const rawPayload = (call.request.payload ?? {}) as Record<
						string,
						unknown
					>;
					const preparedPayload: Record<string, unknown> = { ...rawPayload };
					try {
						if (typeof preparedPayload.args === "string") {
							preparedPayload.args = JSON.parse(preparedPayload.args as string);
						}
						if (typeof preparedPayload.params === "string") {
							preparedPayload.params = JSON.parse(
								preparedPayload.params as string,
							);
						}
					} catch {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message:
									"ValidationError: Failed to parse JSON for 'args' or 'params'",
							},
							null,
						);
					}

					const { value: callValue, error: callError } =
						callSchema.validate(preparedPayload);

					if (callError) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError: ${callError.message}`,
							},
							null,
						);
					}

					try {
						// Ensure function exists and is callable on the broker
						const fn = (broker as unknown as Record<string, unknown>)[
							callValue.functionName
						];
						if (
							typeof fn !== "function" ||
							!broker.has[callValue.functionName]
						) {
							return callback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `Function not found on broker: ${callValue.functionName}`,
								},
								null,
							);
						}

						// Prevent access to dangerous names
						if (
							callValue.functionName.startsWith("_") ||
							callValue.functionName.includes("constructor") ||
							callValue.functionName.includes("prototype")
						) {
							return callback(
								{
									code: grpc.status.PERMISSION_DENIED,
									message: "Access to the requested function is denied",
								},
								null,
							);
						}

						// Prepare arguments
						const argsArray: unknown[] = Array.isArray(callValue.args)
							? [...callValue.args]
							: [];
						const paramsObject = callValue.params ?? {};
						if (Object.keys(paramsObject).length > 0) {
							argsArray.push(paramsObject);
						}

						// Invoke
						// biome-ignore lint/suspicious/noExplicitAny: dynamic call required for generic broker methods
						const result = await (fn as any).apply(broker, argsArray);

						callback(null, {
							proof: verityProof,
							result: JSON.stringify(result),
						});
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
								message: `Call failed: ${message}`,
							},
							null,
						);
					}
					break;
				}

				case Action.FetchDepositAddresses: {
					if (!symbol) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError: Symbol requied`,
							},
							null,
						);
					}
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
								? [
										await broker.fetchDepositAddress(symbol, {
											network: fetchDepositAddresses.chain,
											...(fetchDepositAddresses.params ?? {}),
										}),
									]
								: await broker.fetchDepositAddressesByNetwork(symbol, {
										network: fetchDepositAddresses.chain,
										...(fetchDepositAddresses.params ?? {}),
									});

						if (depositAddresses.length > 0) {
							return callback(null, {
								proof: verityProof,
								result: JSON.stringify(depositAddresses),
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
				case Action.Withdraw: {
					if (!symbol) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError: Symbol requied`,
							},
							null,
						);
					}
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
						const tokenData = await broker.fetchCurrencies(symbol);
						const networks = Object.keys(
							(tokenData[symbol] ?? { networks: [] }).networks,
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
						log.info(`Withdraw Result: ${JSON.stringify(transaction)}`);

						callback(null, {
							proof: verityProof,
							result: JSON.stringify({ ...transaction }),
						});
					} catch (error) {
						log.error({ error });
						callback(
							{
								code: grpc.status.INTERNAL,
								message: "Withdraw failed",
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
				case Action.FetchBalances:
					try {
						// Determine balance type: free | used | total (default: total)
						const payload =
							(call.request.payload as Record<string, unknown>) || {};
						const providedBalanceType = payload.balanceType as
							| string
							| undefined;
						const balanceType = (providedBalanceType ?? "total").toString();
						const validBalanceTypes = new Set(["free", "used", "total"]);
						if (!validBalanceTypes.has(balanceType)) {
							return callback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `ValidationError: invalid balanceType '${providedBalanceType}'. Expected one of: free | used | total`,
								},
								null,
							);
						}

						const params = { ...payload } as Record<string, unknown>;
						delete (params as Record<string, unknown>).balanceType; // Remove balanceType from params before passing to CCXT
						// Default market type to spot unless explicitly provided
						if (params.type === undefined) {
							params.type = "spot";
						}

						// Always return the same schema with empty objects when not requested
						let responseBalances: Record<string, number> = {};

						if (balanceType === "free") {
							// biome-ignore lint/suspicious/noExplicitAny: ccxt typing quirk for partial balances
							const partial = (await broker.fetchFreeBalance(params)) as any;
							responseBalances = partial ?? {};
						} else if (balanceType === "used") {
							// biome-ignore lint/suspicious/noExplicitAny: ccxt typing quirk for partial balances
							const partial = (await broker.fetchUsedBalance(params)) as any;
							responseBalances = partial ?? {};
						} else if (balanceType === "total") {
							// biome-ignore lint/suspicious/noExplicitAny: ccxt typing quirk for partial balances
							const partial = (await broker.fetchTotalBalance(params)) as any;
							responseBalances = partial ?? {};
						}

						// Extract and isolate the symbol if it exists.
						if (symbol) {
							if (typeof responseBalances[symbol] === "number") {
								responseBalances = { [symbol]: responseBalances[symbol] ?? 0 };
							} else {
								responseBalances = {};
							}
						}

						callback(null, {
							proof: verityProof,
							result: JSON.stringify({
								balances: responseBalances,
								balanceType,
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

				case Action.FetchTicker:
					if (!symbol) {
						return callback(
							{
								code: grpc.status.INVALID_ARGUMENT,
								message: `ValidationError: Symbol requied`,
							},
							null,
						);
					}
					try {
						const ticker = await broker.fetchTicker(symbol);
						callback(null, {
							proof: verityProof,
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

				log.info(`Request - Subscribe:`, {
					cex: request.cex,
					symbol: request.symbol,
					type: subscriptionType,
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

				// Get or create broker (no Verity override in Subscribe)
				broker =
					selectBroker(brokers[cex as keyof typeof brokers], metadata) ??
					createBroker(cex, metadata);

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
