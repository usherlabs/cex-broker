import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import ccxt, { type Exchange } from "@usherlabs/ccxt";
import path from "path";
import { fileURLToPath } from "url";
import type { z } from "zod";
import {
	authenticateRequest,
	BrokerAccountPreconditionError,
	type BrokerPoolEntry,
	buildHttpClientOverrideFromMetadata,
	createBroker,
	getCurrentBrokerSelector,
	resolveBrokerAccount,
	resolveOrderExecution,
	selectBroker,
	transferBinanceInternal,
	validateDeposit,
	validateWithdraw,
	verityHttpClientOverridePredicate,
} from "./helpers";
import { log } from "./helpers/logger";
import type { OtelMetrics } from "./helpers/otel";
import {
	CallPayloadSchema,
	CancelOrderPayloadSchema,
	CreateOrderPayloadSchema,
	DepositPayloadSchema,
	FetchDepositAddressesPayloadSchema,
	FetchFeesPayloadSchema,
	GetOrderDetailsPayloadSchema,
	InternalTransferPayloadSchema,
	WithdrawPayloadSchema,
} from "./schemas/action-payloads";
import type { PolicyConfig } from "./types";

// Keep these values in sync with src/proto/node.proto.
const Action = {
	NoAction: 0,
	Deposit: 1,
	Withdraw: 2,
	CreateOrder: 3,
	GetOrderDetails: 4,
	CancelOrder: 5,
	FetchBalances: 6,
	FetchDepositAddresses: 7,
	FetchTicker: 8,
	FetchCurrency: 9,
	Call: 10,
	FetchAccountId: 11,
	FetchFees: 12,
	InternalTransfer: 13,
} as const;

const ActionNames: Record<number, string> = {
	0: "NoAction",
	1: "Deposit",
	2: "Withdraw",
	3: "CreateOrder",
	4: "GetOrderDetails",
	5: "CancelOrder",
	6: "FetchBalances",
	7: "FetchDepositAddresses",
	8: "FetchTicker",
	9: "FetchCurrency",
	10: "Call",
	11: "FetchAccountId",
	12: "FetchFees",
	13: "InternalTransfer",
};

const SubscriptionType = {
	NO_ACTION: 0,
	ORDERBOOK: 1,
	TRADES: 2,
	TICKER: 3,
	OHLCV: 4,
	BALANCE: 5,
	ORDERS: 6,
} as const;

const SubscriptionTypeNames: Record<number, string> = {
	0: "NO_ACTION",
	1: "ORDERBOOK",
	2: "TRADES",
	3: "TICKER",
	4: "OHLCV",
	5: "BALANCE",
	6: "ORDERS",
};

type Action = (typeof Action)[keyof typeof Action];
type SubscriptionType =
	(typeof SubscriptionType)[keyof typeof SubscriptionType];

type ActionRequest = {
	action?: Action;
	payload?: Record<string, string>;
	cex?: string;
	symbol?: string;
};

type ActionResponse = {
	result: string;
	proof?: string;
};

type SubscribeRequest = {
	cex?: string;
	symbol?: string;
	type?: SubscriptionType;
	options?: Record<string, string>;
};

type SubscribeResponse = {
	data: string;
	timestamp: number;
	symbol: string;
	type: SubscriptionType;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const protoPath = path.join(__dirname, "proto", "node.proto");

const packageDef = protoLoader.loadSync(protoPath, {
	keepCase: true,
	longs: String,
	defaults: true,
	oneofs: true,
});
const grpcObj = grpc.loadPackageDefinition(packageDef) as unknown as {
	cex_broker: {
		cex_service: {
			service: grpc.ServiceDefinition<grpc.UntypedServiceImplementation>;
		};
	};
};
const cexNode = grpcObj.cex_broker;

function getActionName(action: unknown): string {
	return typeof action === "number"
		? ActionNames[action] ?? `unknown_${action}`
		: `unknown_${action ?? "undefined"}`;
}

function getSubscriptionTypeName(subscriptionType: number): string {
	return SubscriptionTypeNames[subscriptionType] ?? `unknown_${subscriptionType}`;
}

function parsePayload<T>(
	schema: z.ZodType<T>,
	rawPayload: Record<string, string> | undefined,
): { success: true; data: T } | { success: false; message: string } {
	const parsed = schema.safeParse(rawPayload ?? {});
	if (parsed.success) {
		return { success: true, data: parsed.data };
	}
	const firstIssue = parsed.error.issues[0];
	const path =
		firstIssue && firstIssue.path.length > 0
			? `${firstIssue.path.join(".")}: `
			: "";
	return {
		success: false,
		message: `ValidationError: ${path}${firstIssue?.message ?? "Invalid payload"}`,
	};
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === "string"
			? error
			: "Unknown error";
}

function safeLogError(context: string, error: unknown): void {
	try {
		log.error(context, { error });
	} catch {
		console.error(context, error);
	}
}

/** Maps CCXT typed errors to appropriate gRPC status codes. Returns undefined for unrecognized errors. */
function mapCcxtErrorToGrpcStatus(error: unknown): grpc.status | undefined {
	if (error instanceof ccxt.AuthenticationError)
		return grpc.status.UNAUTHENTICATED;
	if (error instanceof ccxt.PermissionDenied)
		return grpc.status.PERMISSION_DENIED;
	if (error instanceof ccxt.InsufficientFunds)
		return grpc.status.FAILED_PRECONDITION;
	if (error instanceof ccxt.InvalidAddress) return grpc.status.INVALID_ARGUMENT;
	if (error instanceof ccxt.BadSymbol) return grpc.status.NOT_FOUND;
	if (error instanceof ccxt.BadRequest) return grpc.status.INVALID_ARGUMENT;
	if (error instanceof ccxt.NotSupported) return grpc.status.UNIMPLEMENTED;
	if (error instanceof ccxt.RateLimitExceeded)
		return grpc.status.RESOURCE_EXHAUSTED;
	if (error instanceof ccxt.OnMaintenance) return grpc.status.UNAVAILABLE;
	if (error instanceof ccxt.ExchangeNotAvailable)
		return grpc.status.UNAVAILABLE;
	if (error instanceof ccxt.NetworkError) return grpc.status.UNAVAILABLE;
	return undefined;
}

export function getServer(
	policy: PolicyConfig,
	brokers: Record<string, BrokerPoolEntry>,
	whitelistIps: string[],
	useVerity: boolean,
	verityProverUrl: string,
	otelMetrics?: OtelMetrics,
) {
	const server = new grpc.Server();

	server.addService(cexNode.cex_service.service, {
		ExecuteAction: async (
			call: grpc.ServerUnaryCall<ActionRequest, ActionResponse>,
			callback: grpc.sendUnaryData<ActionResponse>,
		) => {
			const startTime = Date.now();
			const { action, cex, symbol } = call.request;
			let actionCompleted = false;

			// Wrap callback to track success/failure
			const wrappedCallback: grpc.sendUnaryData<ActionResponse> = (
				error,
				value,
			) => {
				if (!actionCompleted) {
					actionCompleted = true;
					const latency = Date.now() - startTime;

					// Record latency histogram
					const actionName = getActionName(action);
					otelMetrics?.recordHistogram("execute_action_duration_ms", latency, {
						action: actionName,
						cex: cex || "unknown",
					});

					if (error) {
						// Record failure
						otelMetrics?.recordCounter("execute_action_errors_total", 1, {
							action: actionName,
							cex: cex || "unknown",
							error_type: error.code
								? grpc.status[error.code] || "unknown"
								: "unknown",
						});
					} else {
						// Record success
						otelMetrics?.recordCounter("execute_action_success_total", 1, {
							action: actionName,
							cex: cex || "unknown",
						});
					}
				}
				callback(error, value);
			};

			try {
				// Log incoming request
				log.info(`Request - ExecuteAction:`, {
					action,
					cex,
					symbol,
				});

				// Record request counter
				const actionName = getActionName(action);
				otelMetrics?.recordCounter("execute_action_requests_total", 1, {
					action: actionName,
					cex: cex || "unknown",
				});

				// IP Authentication
				if (!authenticateRequest(call, whitelistIps)) {
					return wrappedCallback(
						{
							code: grpc.status.PERMISSION_DENIED,
							message: "Access denied: Unauthorized IP",
						},
						null,
					);
				}
				// Read incoming metadata
				const metadata = call.metadata;
				// Validate required fields
				if (!action || !cex) {
					return wrappedCallback(
						{
							code: grpc.status.INVALID_ARGUMENT,
							message: "`action` AND `cex` fields are required",
						},
						null,
					);
				}

				const normalizedCex = cex.trim().toLowerCase();

				// If the Exchange is not already pre-loaded for preset API credentials via constructor - createBroker for non-gated APIs may be available for other exchanges.
				const broker =
					selectBroker(
						brokers[normalizedCex as keyof typeof brokers],
						metadata,
					) ?? createBroker(normalizedCex, metadata);

				if (!broker) {
					return wrappedCallback(
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
						const parsedPayload = parsePayload(
							DepositPayloadSchema,
							call.request.payload,
						);
						if (!parsedPayload.success) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: parsedPayload.message,
								},
								null,
							);
						}
						const value = parsedPayload.data;
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
								return wrappedCallback(null, {
									proof: verityProof,
									result: JSON.stringify({ ...deposit }),
								});
							}
							wrappedCallback(
								{
									code: grpc.status.INTERNAL,
									message: "Deposit confirmation failed",
								},
								null,
							);
						} catch (error) {
							safeLogError("Deposit confirmation failed", error);
							wrappedCallback(
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
							return wrappedCallback(
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
								return wrappedCallback(
									{
										code: grpc.status.NOT_FOUND,
										message: `Currency not found for ${symbol}`,
									},
									null,
								);
							}
							wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify(currencyInfo),
							});
						} catch (error) {
							safeLogError(
								`Error fetching currency ${symbol} from ${cex}`,
								error,
							);
							wrappedCallback(
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
							const accountId = await broker.fetchAccountId();

							// Return normalized response
							return wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify({ accountId }),
							});
						} catch (error) {
							safeLogError(`Error fetching account ID ${cex}`, error);
							wrappedCallback(
								{
									code: grpc.status.INTERNAL,
									message: `Error fetching account ID from ${cex}`,
								},
								null,
							);
						}
						break;
					}

					case Action.FetchFees: {
						if (!symbol) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `ValidationError: Symbol required`,
								},
								null,
							);
						}
						const parsedPayload = parsePayload(
							FetchFeesPayloadSchema,
							call.request.payload,
						);
						if (!parsedPayload.success) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: parsedPayload.message,
								},
								null,
							);
						}
						const includeAllFees =
							parsedPayload.data.includeAllFees ||
							parsedPayload.data.includeFundingFees === true;
						try {
							await broker.loadMarkets();
							const fetchFundingFees = async (currencyCodes: string[]) => {
								let fundingFeeSource:
									| "fetchDepositWithdrawFees"
									| "currencies"
									| "unavailable" = "unavailable";
								const fundingFeesByCurrency: Record<string, unknown> = {};

								if (broker.has.fetchDepositWithdrawFees) {
									try {
										const feeMap = (await broker.fetchDepositWithdrawFees(
											currencyCodes,
										)) as unknown as Record<
											string,
											{
												deposit?: unknown;
												withdraw?: unknown;
												networks?: unknown;
												fee?: number;
												percentage?: boolean;
											}
										>;
										for (const code of currencyCodes) {
											const feeInfo = feeMap[code];
											if (!feeInfo) {
												continue;
											}
											const fallbackFee =
												feeInfo.fee !== undefined ||
												feeInfo.percentage !== undefined
													? {
															fee: feeInfo.fee ?? null,
															percentage: feeInfo.percentage ?? null,
														}
													: null;
											fundingFeesByCurrency[code] = {
												deposit: feeInfo.deposit ?? fallbackFee,
												withdraw: feeInfo.withdraw ?? fallbackFee,
												networks: feeInfo.networks ?? {},
											};
										}
										if (Object.keys(fundingFeesByCurrency).length > 0) {
											fundingFeeSource = "fetchDepositWithdrawFees";
										}
									} catch (error) {
										safeLogError(
											`Error fetching deposit/withdraw fee map for ${symbol} from ${cex}`,
											error,
										);
									}
								}

								if (fundingFeeSource === "unavailable") {
									try {
										const currencies = await broker.fetchCurrencies();
										for (const code of currencyCodes) {
											const currency = currencies[code];
											if (!currency) {
												continue;
											}
											fundingFeesByCurrency[code] = {
												deposit: {
													enabled: currency.deposit ?? null,
												},
												withdraw: {
													enabled: currency.withdraw ?? null,
													fee: currency.fee ?? null,
													limits: currency.limits?.withdraw ?? null,
												},
												networks: currency.networks ?? {},
											};
										}
										if (Object.keys(fundingFeesByCurrency).length > 0) {
											fundingFeeSource = "currencies";
										}
									} catch (error) {
										safeLogError(
											`Error fetching currency metadata for fees for ${symbol} from ${cex}`,
											error,
										);
									}
								}

								return { fundingFeeSource, fundingFeesByCurrency };
							};

							const isMarketSymbol = symbol.includes("/");
							if (isMarketSymbol) {
								const market = await broker.market(symbol);
								const generalFee = broker.fees ?? null;
								const feeStatus = broker.fees ? "available" : "unknown";

								if (!broker.fees) {
									log.warn(`Fee metadata unavailable for ${cex}`, { symbol });
								}

								if (!includeAllFees) {
									return wrappedCallback(null, {
										proof: verityProof,
										result: JSON.stringify({
											feeScope: "market",
											generalFee,
											feeStatus,
											market,
										}),
									});
								}

								const currencyCodes = Array.from(
									new Set([market.base, market.quote]),
								);
								const { fundingFeeSource, fundingFeesByCurrency } =
									await fetchFundingFees(currencyCodes);
								return wrappedCallback(null, {
									proof: verityProof,
									result: JSON.stringify({
										feeScope: "market+funding",
										generalFee,
										feeStatus,
										market,
										fundingFeeSource,
										fundingFeesByCurrency,
									}),
								});
							}

							const tokenCode = symbol.toUpperCase();
							const { fundingFeeSource, fundingFeesByCurrency } =
								await fetchFundingFees([tokenCode]);
							return wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify({
									feeScope: "token",
									symbol: tokenCode,
									fundingFeeSource,
									fundingFeesByCurrency,
								}),
							});
						} catch (error) {
							safeLogError(
								`Error fetching fees for ${symbol} from ${cex}`,
								error,
							);
							wrappedCallback(
								{
									code: grpc.status.INTERNAL,
									message: `Error fetching fees from ${cex}`,
								},
								null,
							);
						}
						break;
					}

					case Action.Call: {
						const parsedPayload = parsePayload(
							CallPayloadSchema,
							call.request.payload,
						);
						if (!parsedPayload.success) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: parsedPayload.message,
								},
								null,
							);
						}
						const callValue = parsedPayload.data;

						try {
							// Ensure function exists and is callable on the broker
							const fn = (broker as unknown as Record<string, unknown>)[
								callValue.functionName
							];
							if (
								typeof fn !== "function" ||
								!broker.has[callValue.functionName]
							) {
								return wrappedCallback(
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
								return wrappedCallback(
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

							wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify(result),
							});
						} catch (error: unknown) {
							safeLogError("Call failed", error);
							const message = getErrorMessage(error);
							wrappedCallback(
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
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `ValidationError: Symbol requied`,
								},
								null,
							);
						}
						const parsedPayload = parsePayload(
							FetchDepositAddressesPayloadSchema,
							call.request.payload,
						);
						if (!parsedPayload.success) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: parsedPayload.message,
								},
								null,
							);
						}
						const fetchDepositAddresses = parsedPayload.data;
						const depositValidation = validateDeposit(
							policy,
							cex,
							fetchDepositAddresses.chain,
							symbol,
						);
						if (!depositValidation.valid) {
							return wrappedCallback(
								{
									code: grpc.status.PERMISSION_DENIED,
									message: depositValidation.error,
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
								return wrappedCallback(null, {
									proof: verityProof,
									result: JSON.stringify(depositAddresses),
								});
							}
							wrappedCallback(
								{
									code: grpc.status.INTERNAL,
									message: "Deposit confirmation failed",
								},
								null,
							);
						} catch (error: unknown) {
							safeLogError(
								"Fetch Deposit Addresses confirmation failed",
								error,
							);
							const message = getErrorMessage(error);
							wrappedCallback(
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
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `ValidationError: Symbol requied`,
								},
								null,
							);
						}
						const parsedPayload = parsePayload(
							WithdrawPayloadSchema,
							call.request.payload,
						);
						if (!parsedPayload.success) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: parsedPayload.message,
								},
								null,
							);
						}
						const transferValue = parsedPayload.data;
						const transferValidation = validateWithdraw(
							policy,
							cex,
							transferValue.chain,
							transferValue.recipientAddress,
							transferValue.amount,
							symbol,
						);
						if (!transferValidation.valid) {
							return wrappedCallback(
								{
									code: grpc.status.PERMISSION_DENIED,
									message: transferValidation.error,
								},
								null,
							);
						}
						try {
							const transaction = await broker.withdraw(
								symbol,
								transferValue.amount,
								transferValue.recipientAddress,
								undefined,
								{
									...(transferValue.params ?? {}),
									network: transferValue.chain,
								},
							);
							log.info(`Withdraw Result: ${JSON.stringify(transaction)}`);

							wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify({ ...transaction }),
							});
						} catch (error) {
							safeLogError("Withdraw failed", error);
							const code =
								mapCcxtErrorToGrpcStatus(error) ?? grpc.status.INTERNAL;
							wrappedCallback(
								{
									code,
									message: `Withdraw failed: ${getErrorMessage(error)}`,
								},
								null,
							);
						}
						break;
					}

					case Action.CreateOrder: {
						const parsedPayload = parsePayload(
							CreateOrderPayloadSchema,
							call.request.payload,
						);
						if (!parsedPayload.success) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: parsedPayload.message,
								},
								null,
							);
						}
						const orderValue = parsedPayload.data;

						try {
							if (!broker) {
								return wrappedCallback(
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
							);
							if (!resolution.valid || !resolution.symbol || !resolution.side) {
								return wrappedCallback(
									{
										code: grpc.status.INVALID_ARGUMENT,
										message:
											resolution.error ??
											"Order rejected by policy: market or limits not satisfied",
									},
									null,
								);
							}

							const order = await broker.createOrder(
								resolution.symbol,
								orderValue.orderType,
								resolution.side,
								resolution.amountBase ?? orderValue.amount,
								orderValue.price,
								orderValue.params ?? {},
							);

							wrappedCallback(null, { result: JSON.stringify({ ...order }) });
						} catch (error) {
							safeLogError("Order Creation failed", error);
							wrappedCallback(
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
						const parsedPayload = parsePayload(
							GetOrderDetailsPayloadSchema,
							call.request.payload,
						);
						if (!parsedPayload.success) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: parsedPayload.message,
								},
								null,
							);
						}
						const getOrderValue = parsedPayload.data;

						try {
							// Validate CEX key
							if (!broker) {
								return wrappedCallback(
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

							wrappedCallback(null, {
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
							wrappedCallback(
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
						const parsedPayload = parsePayload(
							CancelOrderPayloadSchema,
							call.request.payload,
						);
						if (!parsedPayload.success) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: parsedPayload.message,
								},
								null,
							);
						}
						const cancelOrderValue = parsedPayload.data;

						try {
							const cancelledOrder = await broker.cancelOrder(
								cancelOrderValue.orderId,
								symbol,
								cancelOrderValue.params ?? {},
							);

							wrappedCallback(null, {
								result: JSON.stringify({ ...cancelledOrder }),
							});
						} catch (error) {
							safeLogError(`Error cancelling order from ${cex}`, error);
							wrappedCallback(
								{
									code: grpc.status.INTERNAL,
									message: `Failed to cancel order from ${cex}`,
								},
								null,
							);
						}
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
								return wrappedCallback(
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
									responseBalances = {
										[symbol]: responseBalances[symbol] ?? 0,
									};
								} else {
									responseBalances = {};
								}
							}

							wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify({
									balances: responseBalances,
									balanceType,
								}),
							});
						} catch (error) {
							safeLogError(`Error fetching balance from ${cex}`, error);
							wrappedCallback(
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
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `ValidationError: Symbol requied`,
								},
								null,
							);
						}
						try {
							const ticker = await broker.fetchTicker(symbol);
							wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify(ticker),
							});
						} catch (error) {
							safeLogError(`Error fetching ticker from ${cex}`, error);
							wrappedCallback(
								{
									code: grpc.status.INTERNAL,
									message: `Failed to fetch ticker from ${cex}`,
								},
								null,
							);
						}
						break;

					case Action.InternalTransfer: {
						if (!symbol) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `ValidationError: Symbol required`,
								},
								null,
							);
						}
						const parsedPayload = parsePayload(
							InternalTransferPayloadSchema,
							call.request.payload,
						);
						if (!parsedPayload.success) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: parsedPayload.message,
								},
								null,
							);
						}
						const transferPayload = parsedPayload.data;

						if (normalizedCex !== "binance") {
							return wrappedCallback(
								{
									code: grpc.status.UNIMPLEMENTED,
									message: `InternalTransfer is only supported for Binance`,
								},
								null,
							);
						}

						const pool = brokers[normalizedCex as keyof typeof brokers];
						if (!pool) {
							return wrappedCallback(
								{
									code: grpc.status.FAILED_PRECONDITION,
									message: `No broker accounts configured for ${normalizedCex}`,
								},
								null,
							);
						}

						const fromSelector =
							transferPayload.fromAccount ?? getCurrentBrokerSelector(metadata);
						const toSelector = transferPayload.toAccount ?? "primary";

						const sourceAccount = resolveBrokerAccount(pool, fromSelector);
						if (!sourceAccount) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `Source account "${fromSelector}" is not configured`,
								},
								null,
							);
						}

						const destAccount = resolveBrokerAccount(pool, toSelector);
						if (!destAccount) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: `Destination account "${toSelector}" is not configured`,
								},
								null,
							);
						}

						try {
							if (useVerity) {
								sourceAccount.exchange.setHttpClientOverride(
									buildHttpClientOverrideFromMetadata(
										metadata,
										verityProverUrl,
										(proof, notaryPubKey) => {
											verityProof = proof;
											log.debug(`Verity proof:`, { proof, notaryPubKey });
										},
									),
									verityHttpClientOverridePredicate,
								);
							}
							const result = await transferBinanceInternal(
								sourceAccount,
								destAccount,
								symbol,
								transferPayload.amount,
							);
							wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify(result),
							});
						} catch (error) {
							safeLogError("InternalTransfer failed", error);
							if (error instanceof BrokerAccountPreconditionError) {
								return wrappedCallback(
									{
										code: grpc.status.FAILED_PRECONDITION,
										message: getErrorMessage(error),
									},
									null,
								);
							}
							const msg = getErrorMessage(error);
							let code: grpc.status;
							if (msg.includes("Unsupported transfer direction")) {
								code = grpc.status.INVALID_ARGUMENT;
							} else if (msg.includes("unavailable in this CCXT build")) {
								code = grpc.status.UNIMPLEMENTED;
							} else {
								code = mapCcxtErrorToGrpcStatus(error) ?? grpc.status.INTERNAL;
							}
							wrappedCallback(
								{
									code,
									message: `InternalTransfer failed: ${msg}`,
								},
								null,
							);
						}
						break;
					}

					default:
						return wrappedCallback({
							code: grpc.status.INVALID_ARGUMENT,
							message: "Invalid Action",
						});
				}
			} catch (error) {
				safeLogError("ExecuteAction unhandled error", error);
				return wrappedCallback(
					{
						code: grpc.status.INTERNAL,
						message: "ExecuteAction failed unexpectedly",
					},
					null,
				);
			}
		},

		Subscribe: async (
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
									type: subscriptionType,
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
									type: subscriptionType,
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
							type: subscriptionType,
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
		},
	});
	return server;
}
