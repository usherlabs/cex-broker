import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Exchange } from "@usherlabs/ccxt";
import type { z } from "zod";
import {
	authenticateRequest,
	buildHttpClientOverrideFromMetadata,
	createBroker,
	resolveOrderExecution,
	selectBroker,
	validateWithdraw,
	verityHttpClientOverridePredicate,
} from "./helpers";
import { log } from "./helpers/logger";
import type { OtelMetrics } from "./helpers/otel";
import { Action } from "./proto/cex_broker/Action";
import type { ActionRequest } from "./proto/cex_broker/ActionRequest";
import type { ActionResponse } from "./proto/cex_broker/ActionResponse";
import type { SubscribeRequest } from "./proto/cex_broker/SubscribeRequest";
import type { SubscribeResponse } from "./proto/cex_broker/SubscribeResponse";
import { SubscriptionType } from "./proto/cex_broker/SubscriptionType";
import type { ProtoGrpcType } from "./proto/node";
import descriptor from "./proto/node.descriptor.ts";
import {
	CallPayloadSchema,
	CancelOrderPayloadSchema,
	CreateOrderPayloadSchema,
	DepositPayloadSchema,
	FetchDepositAddressesPayloadSchema,
	GetOrderDetailsPayloadSchema,
	WithdrawPayloadSchema,
} from "./schemas/action-payloads";
import type { PolicyConfig } from "./types";

const packageDef = protoLoader.fromJSON(
	descriptor as unknown as Record<string, unknown>,
);
const grpcObj = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;
const cexNode = grpcObj.cex_broker;

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

export function getServer(
	policy: PolicyConfig,
	brokers: Record<string, { primary: Exchange; secondaryBrokers: Exchange[] }>,
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
					const actionName =
						action !== undefined && action in Action
							? Action[action as keyof typeof Action]
							: `unknown_${action ?? "undefined"}`;
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
				const actionName =
					action !== undefined && action in Action
						? Action[action as keyof typeof Action]
						: `unknown_${action ?? "undefined"}`;
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

				// If the Exchange is not already pre-loaded for preset API credentials via constructor - createBroker for non-gated APIs may be available for other exchanges.
				const broker =
					selectBroker(brokers[cex as keyof typeof brokers], metadata) ??
					createBroker(cex, metadata);

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
						try {
							await broker.loadMarkets();
							const market = await broker.market(symbol);

							// Address CodeRabbit's concern: explicit handling for missing fees
							const generalFee = broker.fees ?? null;
							const feeStatus = broker.fees ? "available" : "unknown";

							if (!broker.fees) {
								log.warn(`Fee metadata unavailable for ${cex}`, { symbol });
							}

							return wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify({ generalFee, feeStatus, market }),
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
						// Validate against policy
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
							const message = getErrorMessage(error);
							wrappedCallback(
								{
									code: grpc.status.INTERNAL,
									message: `Withdraw failed: ${message}`,
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
								undefined,
								{ ...getOrderValue.params },
							);

							wrappedCallback(null, {
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
								undefined,
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
				const subscriptionTypeName = (() => {
					for (const [key, value] of Object.entries(SubscriptionType)) {
						if (value === subscriptionType && Number.isNaN(Number(key))) {
							return key;
						}
					}
					return `unknown_${subscriptionType}`;
				})();
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
