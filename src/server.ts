import * as grpc from "@grpc/grpc-js";
import ccxt, { type Exchange } from "@usherlabs/ccxt";
import type { z } from "zod";
import {
	authenticateRequest,
	BrokerAccountPreconditionError,
	type BrokerPoolEntry,
	buildHttpClientOverrideFromMetadata,
	createBroker,
	getCurrentBrokerSelector,
	normalizeBrokerNetworkId,
	resolveBrokerAccount,
	resolveOrderExecution,
	selectBroker,
	selectBrokerAccount,
	transferBinanceInternal,
	validateDeposit,
	validateWithdraw,
	verityHttpClientOverridePredicate,
} from "./helpers";
import {
	Action,
	type ActionName,
	type Action as ActionType,
	getActionName,
	getSubscriptionTypeName,
	resolveAction,
	resolveSubscriptionType,
	SubscriptionType,
	type SubscriptionTypeName,
	type SubscriptionType as SubscriptionTypeValue,
} from "./helpers/constants";
import { log } from "./helpers/logger";
import {
	emitOrderExecutionTelemetry,
	extractOrderTelemetryIds,
	type OrderTelemetryContext,
} from "./helpers/order-telemetry";
import type { OtelMetrics } from "./helpers/otel";
import { CEX_BROKER_PACKAGE_DEFINITION } from "./proto-package-definition";
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

type ActionRequest = {
	action?: ActionType | ActionName;
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
	type?: SubscriptionTypeValue | SubscriptionTypeName;
	options?: Record<string, string>;
};

type SubscribeResponse = {
	data: string;
	timestamp: number;
	symbol: string;
	type: SubscriptionTypeValue;
};

type ExchangeWithDiscovery = Exchange & {
	has?: Record<string, unknown>;
	markets?: Record<string, unknown>;
	currencies?: Record<string, unknown>;
	fetchMarkets?: (...args: unknown[]) => Promise<unknown>;
	fetchCurrencies?: (...args: unknown[]) => Promise<Record<string, unknown>>;
	fetchDeposits?: (
		code?: string,
		since?: number,
		limit?: number,
		params?: Record<string, unknown>,
	) => Promise<Array<Record<string, unknown>>>;
};

const grpcObj = grpc.loadPackageDefinition(
	CEX_BROKER_PACKAGE_DEFINITION,
) as unknown as {
	cex_broker: {
		cex_service: {
			service: grpc.ServiceDefinition<grpc.UntypedServiceImplementation>;
		};
	};
};
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

function stableGrpcErrorCode(message: string): grpc.status | undefined {
	if (message.startsWith("venue_discovery_unavailable:")) {
		return grpc.status.UNIMPLEMENTED;
	}
	if (message.startsWith("network_alias_unresolved:")) {
		return grpc.status.INVALID_ARGUMENT;
	}
	if (
		message.startsWith("deposit_observation_unavailable:") ||
		message.startsWith("deposit_not_found:")
	) {
		return grpc.status.UNIMPLEMENTED;
	}
	if (message.startsWith("deposit_amount_mismatch:")) {
		return grpc.status.FAILED_PRECONDITION;
	}
	if (
		message.startsWith("policy_withdrawal_denied:") ||
		message.startsWith("policy_deposit_denied:")
	) {
		return grpc.status.PERMISSION_DENIED;
	}
	return undefined;
}

function callArgs(
	args: unknown[] | undefined,
	params: Record<string, unknown> | undefined,
): unknown[] {
	const argsArray = Array.isArray(args) ? [...args] : [];
	if (params && Object.keys(params).length > 0) {
		argsArray.push(params);
	}
	return argsArray;
}

async function handleTreasuryDiscoveryCall(
	broker: Exchange,
	functionName: string,
	args: unknown[],
	params: Record<string, unknown>,
): Promise<{ handled: true; result: unknown } | { handled: false }> {
	const discoveryBroker = broker as ExchangeWithDiscovery;

	if (functionName === "fetchMarkets") {
		if (
			typeof discoveryBroker.fetchMarkets === "function" &&
			discoveryBroker.has?.fetchMarkets !== false
		) {
			return {
				handled: true,
				result: await discoveryBroker.fetchMarkets(...callArgs(args, params)),
			};
		}
		if (typeof discoveryBroker.loadMarkets === "function") {
			const loaded = await discoveryBroker.loadMarkets(false, params);
			const markets =
				loaded && typeof loaded === "object" && !Array.isArray(loaded)
					? Object.values(loaded as Record<string, unknown>)
					: Object.values(discoveryBroker.markets ?? {});
			return { handled: true, result: markets };
		}
		throw new Error(
			"venue_discovery_unavailable: fetchMarkets unavailable on broker",
		);
	}

	if (functionName === "fetchCurrencies") {
		if (
			typeof discoveryBroker.fetchCurrencies === "function" &&
			discoveryBroker.has?.fetchCurrencies !== false
		) {
			return {
				handled: true,
				result: await discoveryBroker.fetchCurrencies(
					...callArgs(args, params),
				),
			};
		}
		if (
			discoveryBroker.currencies &&
			Object.keys(discoveryBroker.currencies).length > 0
		) {
			return { handled: true, result: discoveryBroker.currencies };
		}
		throw new Error(
			"venue_discovery_unavailable: fetchCurrencies unavailable on broker",
		);
	}

	return { handled: false };
}

async function fetchCurrencyMetadata(
	broker: Exchange,
	assetCode: string,
): Promise<Record<string, unknown> | undefined> {
	const discoveryBroker = broker as ExchangeWithDiscovery;
	const normalizedAsset = assetCode.trim().toUpperCase();
	if (
		typeof discoveryBroker.fetchCurrencies === "function" &&
		discoveryBroker.has?.fetchCurrencies !== false
	) {
		const currencies = await discoveryBroker.fetchCurrencies();
		return currencies[normalizedAsset] as Record<string, unknown> | undefined;
	}
	return discoveryBroker.currencies?.[normalizedAsset] as
		| Record<string, unknown>
		| undefined;
}

type TransferNetworkResolution = {
	operatorAlias: string;
	brokerNetworkId: string;
	exchangeNetworkId: string;
	networkKey: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function networkAliasSet(
	brokerNetworkId: string,
	networkKey: string,
): string[] {
	const aliases = new Set<string>([
		brokerNetworkId,
		networkKey.trim().toUpperCase(),
	]);
	if (brokerNetworkId === "BNB") {
		aliases.add("BNB");
		aliases.add("BSC");
		aliases.add("BEP20");
	}
	return [...aliases].filter((alias) => alias.length > 0);
}

function buildTransferNetworkEvidence(currencyInfo: Record<string, unknown>) {
	const rawNetworks = isRecord(currencyInfo.networks)
		? currencyInfo.networks
		: {};
	const networks: Record<string, unknown> = {};
	const aliases: Record<string, TransferNetworkResolution> = {};

	for (const [networkKey, networkValue] of Object.entries(rawNetworks)) {
		const networkRecord = isRecord(networkValue) ? networkValue : {};
		const exchangeNetworkId = String(
			networkRecord.id ?? networkRecord.network ?? networkKey,
		);
		const brokerNetworkId = normalizeBrokerNetworkId(
			String(networkRecord.network ?? networkKey),
		);
		const evidence = {
			operatorAlias: networkKey,
			brokerNetworkId,
			exchangeNetworkId,
			networkKey,
		};
		networks[networkKey] = {
			...networkRecord,
			operatorAlias: networkKey,
			brokerNetworkId,
			exchangeNetworkId,
		};
		for (const alias of networkAliasSet(brokerNetworkId, networkKey)) {
			aliases[alias] = { ...evidence, operatorAlias: alias };
		}
	}

	return { networks, aliases };
}

async function resolveTransferNetwork(
	broker: Exchange,
	assetCode: string,
	operatorAlias: string,
): Promise<TransferNetworkResolution> {
	const requestedAlias = operatorAlias.trim().toUpperCase();
	const brokerNetworkId = normalizeBrokerNetworkId(requestedAlias);
	let currencyInfo: Record<string, unknown> | null | undefined = null;
	try {
		currencyInfo = await fetchCurrencyMetadata(broker, assetCode);
	} catch (error) {
		safeLogError(
			`Network discovery failed for ${assetCode}/${operatorAlias}; using operator alias as exchange network id`,
			error,
		);
	}
	if (currencyInfo) {
		const evidence = buildTransferNetworkEvidence(currencyInfo);
		const resolved =
			evidence.aliases[requestedAlias] ?? evidence.aliases[brokerNetworkId];
		if (resolved) {
			return { ...resolved, operatorAlias: requestedAlias, brokerNetworkId };
		}
		throw new Error(
			`network_alias_unresolved: ${assetCode}/${requestedAlias} is not available in discovered transfer networks`,
		);
	}
	return {
		operatorAlias: requestedAlias,
		brokerNetworkId,
		exchangeNetworkId: requestedAlias,
		networkKey: null,
	};
}

function depositField(deposit: Record<string, unknown>, fields: string[]) {
	for (const field of fields) {
		const value = deposit[field];
		if (value !== undefined && value !== null && String(value).length > 0) {
			return value;
		}
	}
	return undefined;
}

function normalizeDepositStatus(
	status: unknown,
):
	| "unsupported"
	| "not_found"
	| "pending"
	| "credited"
	| "failed"
	| "timed_out" {
	const normalized = String(status ?? "")
		.trim()
		.toLowerCase();
	if (
		["ok", "credited", "complete", "completed", "success"].includes(normalized)
	) {
		return "credited";
	}
	if (
		["failed", "failure", "canceled", "cancelled", "rejected"].includes(
			normalized,
		)
	) {
		return "failed";
	}
	if (["timeout", "timed_out", "timedout", "expired"].includes(normalized)) {
		return "timed_out";
	}
	if (["pending", "processing", "confirming", "waiting"].includes(normalized)) {
		return "pending";
	}
	return normalized ? "pending" : "credited";
}

function depositMatchesTransaction(
	deposit: Record<string, unknown>,
	transactionHash: string,
): boolean {
	const candidates = [
		depositField(deposit, [
			"txid",
			"txId",
			"tx_hash",
			"txHash",
			"transactionHash",
		]),
		depositField(deposit, ["id"]),
	];
	return candidates.some((candidate) => String(candidate) === transactionHash);
}

function stringAmountEquals(left: unknown, right: unknown): boolean {
	const leftNum = Number(left);
	const rightNum = Number(right);
	if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
		return Math.abs(leftNum - rightNum) < 1e-12;
	}
	return String(left) === String(right);
}

function normalizeAddress(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	return String(value).trim().toLowerCase();
}

function emitOrderExecutionTelemetryInBackground(
	otelMetrics: OtelMetrics | undefined,
	context: OrderTelemetryContext,
	order: unknown,
	error?: unknown,
): void {
	void emitOrderExecutionTelemetry(otelMetrics, context, order, error).catch(
		(telemetryError) => {
			try {
				log.warn("Telemetry emit failed", { error: telemetryError });
			} catch {
				console.warn("Telemetry emit failed", telemetryError);
			}
		},
	);
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
			const { action: rawAction, cex, symbol } = call.request;
			const action = resolveAction(rawAction);
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
				const selectedBrokerAccount = selectBrokerAccount(
					brokers[normalizedCex as keyof typeof brokers],
					metadata,
				);
				const broker =
					selectedBrokerAccount?.exchange ??
					createBroker(normalizedCex, metadata);

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
						if (!symbol) {
							return wrappedCallback(
								{
									code: grpc.status.INVALID_ARGUMENT,
									message: "ValidationError: Symbol required",
								},
								null,
							);
						}
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
						let depositNetwork: TransferNetworkResolution | undefined;
						try {
							const depositBroker = broker as ExchangeWithDiscovery;
							const requestedNetwork =
								typeof value.params.network === "string"
									? value.params.network
									: typeof value.params.chain === "string"
										? value.params.chain
										: undefined;
							depositNetwork = requestedNetwork
								? await resolveTransferNetwork(broker, symbol, requestedNetwork)
								: undefined;
							const depositParams: Record<string, unknown> = {
								...(value.params ?? {}),
							};
							if (depositNetwork) {
								depositParams.network = depositNetwork.exchangeNetworkId;
							}
							if (
								typeof depositBroker.fetchDeposits !== "function" ||
								depositBroker.has?.fetchDeposits === false
							) {
								return wrappedCallback(null, {
									proof: verityProof,
									result: JSON.stringify({
										status: "unsupported",
										exchange: normalizedCex,
										accountSelector: selectedBrokerAccount?.label,
										asset: symbol,
										operatorAlias: depositNetwork?.operatorAlias ?? null,
										brokerNetworkId: depositNetwork?.brokerNetworkId ?? null,
										exchangeNetworkId:
											depositNetwork?.exchangeNetworkId ?? null,
										txid: value.transactionHash,
										transactionId: value.transactionHash,
										address: value.recipientAddress,
										expectedAmount: value.amount,
										raw: null,
									}),
								});
							}

							const deposits = (await depositBroker.fetchDeposits(
								symbol,
								value.since,
								50,
								depositParams,
							)) as unknown as Array<Record<string, unknown>>;
							const deposit = deposits.find((deposit) =>
								depositMatchesTransaction(deposit, value.transactionHash),
							);

							if (deposit) {
								const observedAmount = depositField(deposit, ["amount"]);
								if (
									observedAmount !== undefined &&
									!stringAmountEquals(observedAmount, value.amount)
								) {
									return wrappedCallback(
										{
											code: grpc.status.FAILED_PRECONDITION,
											message: `deposit_amount_mismatch: expected ${value.amount}, observed ${observedAmount}`,
										},
										null,
									);
								}
								const observedAddress = depositField(deposit, [
									"address",
									"recipientAddress",
									"to",
									"destination",
								]);
								if (
									normalizeAddress(observedAddress) !== undefined &&
									normalizeAddress(observedAddress) !==
										normalizeAddress(value.recipientAddress)
								) {
									return wrappedCallback(
										{
											code: grpc.status.FAILED_PRECONDITION,
											message: `deposit_amount_mismatch: expected address ${value.recipientAddress}, observed ${String(observedAddress)}`,
										},
										null,
									);
								}
								const status = normalizeDepositStatus(
									depositField(deposit, ["status", "state"]),
								);
								log.info(
									`Amount ${value.amount} at ${value.transactionHash} . Paid to ${value.recipientAddress}`,
								);
								return wrappedCallback(null, {
									proof: verityProof,
									result: JSON.stringify({
										status,
										exchange: normalizedCex,
										accountSelector: selectedBrokerAccount?.label,
										asset: symbol,
										operatorAlias: depositNetwork?.operatorAlias ?? null,
										brokerNetworkId: depositNetwork?.brokerNetworkId ?? null,
										exchangeNetworkId:
											depositNetwork?.exchangeNetworkId ?? null,
										txid:
											depositField(deposit, [
												"txid",
												"txId",
												"tx_hash",
												"txHash",
											]) ?? value.transactionHash,
										transactionId: value.transactionHash,
										amount: observedAmount,
										observedAmount,
										expectedAmount: value.amount,
										address: value.recipientAddress,
										observedAddress,
										confirmations: depositField(deposit, ["confirmations"]),
										creditedAt: depositField(deposit, [
											"creditedAt",
											"credited_at",
											"updated",
											"updatedAt",
											"timestamp",
											"datetime",
										]),
										raw: deposit,
									}),
								});
							}
							return wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify({
									status: "not_found",
									exchange: normalizedCex,
									accountSelector: selectedBrokerAccount?.label,
									asset: symbol,
									operatorAlias: depositNetwork?.operatorAlias ?? null,
									brokerNetworkId: depositNetwork?.brokerNetworkId ?? null,
									exchangeNetworkId: depositNetwork?.exchangeNetworkId ?? null,
									txid: value.transactionHash,
									transactionId: value.transactionHash,
									address: value.recipientAddress,
									expectedAmount: value.amount,
									raw: null,
								}),
							});
						} catch (error) {
							safeLogError("Deposit confirmation failed", error);
							const message = getErrorMessage(error);
							if (error instanceof ccxt.NotSupported) {
								return wrappedCallback(null, {
									proof: verityProof,
									result: JSON.stringify({
										status: "unsupported",
										exchange: normalizedCex,
										accountSelector: selectedBrokerAccount?.label,
										asset: symbol,
										operatorAlias: depositNetwork?.operatorAlias ?? null,
										brokerNetworkId: depositNetwork?.brokerNetworkId ?? null,
										exchangeNetworkId:
											depositNetwork?.exchangeNetworkId ?? null,
										txid: value.transactionHash,
										transactionId: value.transactionHash,
										address: value.recipientAddress,
										expectedAmount: value.amount,
										raw: { error: message },
									}),
								});
							}
							const code =
								stableGrpcErrorCode(message) ??
								mapCcxtErrorToGrpcStatus(error) ??
								grpc.status.INTERNAL;
							wrappedCallback(
								{
									code,
									message: `deposit_observation_unavailable: ${message}`,
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
							const assetCode = symbol.trim().toUpperCase();
							const currencyInfo = await fetchCurrencyMetadata(
								broker,
								assetCode,
							);
							if (!currencyInfo) {
								return wrappedCallback(
									{
										code: grpc.status.NOT_FOUND,
										message: `venue_discovery_unavailable: currency not found for ${assetCode}`,
									},
									null,
								);
							}
							const networkEvidence =
								buildTransferNetworkEvidence(currencyInfo);
							wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify({
									...currencyInfo,
									exchange: normalizedCex,
									asset: assetCode,
									code: currencyInfo.code ?? assetCode,
									id: currencyInfo.id ?? null,
									networks: networkEvidence.networks,
									networkAliases: networkEvidence.aliases,
									raw: currencyInfo,
								}),
							});
						} catch (error) {
							safeLogError(
								`Error fetching currency ${symbol} from ${cex}`,
								error,
							);
							const message = getErrorMessage(error);
							wrappedCallback(
								{
									code:
										stableGrpcErrorCode(message) ??
										mapCcxtErrorToGrpcStatus(error) ??
										grpc.status.INTERNAL,
									message: message.startsWith("venue_discovery_unavailable:")
										? message
										: `venue_discovery_unavailable: ${message}`,
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
							const argsArray = callArgs(
								callValue.args,
								callValue.params ?? {},
							);
							const treasuryDiscovery = await handleTreasuryDiscoveryCall(
								broker,
								callValue.functionName,
								callValue.args,
								callValue.params ?? {},
							);
							if (treasuryDiscovery.handled) {
								return wrappedCallback(null, {
									proof: verityProof,
									result: JSON.stringify(treasuryDiscovery.result),
								});
							}

							// Ensure function exists and is callable on the broker.
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
									code:
										stableGrpcErrorCode(message) ??
										mapCcxtErrorToGrpcStatus(error) ??
										grpc.status.INTERNAL,
									message:
										stableGrpcErrorCode(message) !== undefined
											? message
											: `Call failed: ${message}`,
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
						let depositNetwork: TransferNetworkResolution;
						try {
							depositNetwork = await resolveTransferNetwork(
								broker,
								symbol,
								fetchDepositAddresses.chain,
							);
						} catch (error) {
							const message = getErrorMessage(error);
							return wrappedCallback(
								{
									code:
										stableGrpcErrorCode(message) ??
										grpc.status.INVALID_ARGUMENT,
									message,
								},
								null,
							);
						}
						const depositValidation = validateDeposit(
							policy,
							cex,
							depositNetwork.brokerNetworkId,
							symbol,
						);
						if (!depositValidation.valid) {
							return wrappedCallback(
								{
									code: grpc.status.PERMISSION_DENIED,
									message: `policy_deposit_denied: ${depositValidation.error}`,
								},
								null,
							);
						}
						try {
							const depositAddresses =
								broker.has.fetchDepositAddress === true
									? [
											await broker.fetchDepositAddress(symbol, {
												network: depositNetwork.exchangeNetworkId,
												...(fetchDepositAddresses.params ?? {}),
											}),
										]
									: await broker.fetchDepositAddressesByNetwork(symbol, {
											network: depositNetwork.exchangeNetworkId,
											...(fetchDepositAddresses.params ?? {}),
										});

							if (depositAddresses.length > 0) {
								return wrappedCallback(null, {
									proof: verityProof,
									result: JSON.stringify(
										depositAddresses.map((depositAddress) => ({
											...depositAddress,
											operatorAlias: depositNetwork.operatorAlias,
											brokerNetworkId: depositNetwork.brokerNetworkId,
											exchangeNetworkId: depositNetwork.exchangeNetworkId,
										})),
									),
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
						let withdrawNetwork: TransferNetworkResolution;
						try {
							withdrawNetwork = await resolveTransferNetwork(
								broker,
								symbol,
								transferValue.chain,
							);
						} catch (error) {
							const message = getErrorMessage(error);
							return wrappedCallback(
								{
									code:
										stableGrpcErrorCode(message) ??
										grpc.status.INVALID_ARGUMENT,
									message,
								},
								null,
							);
						}
						const transferValidation = validateWithdraw(
							policy,
							cex,
							withdrawNetwork.brokerNetworkId,
							transferValue.recipientAddress,
							transferValue.amount,
							symbol,
						);
						if (!transferValidation.valid) {
							return wrappedCallback(
								{
									code: grpc.status.PERMISSION_DENIED,
									message: `policy_withdrawal_denied: ${transferValidation.error}`,
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
									network: withdrawNetwork.exchangeNetworkId,
								},
							);
							log.info(`Withdraw Result: ${JSON.stringify(transaction)}`);

							wrappedCallback(null, {
								proof: verityProof,
								result: JSON.stringify({
									...transaction,
									operatorAlias: withdrawNetwork.operatorAlias,
									brokerNetworkId: withdrawNetwork.brokerNetworkId,
									exchangeNetworkId: withdrawNetwork.exchangeNetworkId,
								}),
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
						let resolvedOrderTelemetry: {
							symbol?: string;
							side?: string;
							requestedQuantity?: number;
						} = {};

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
							resolvedOrderTelemetry = {
								symbol: resolution.symbol,
								side: resolution.side,
								requestedQuantity: resolution.amountBase ?? orderValue.amount,
							};

							const order = await broker.createOrder(
								resolution.symbol,
								orderValue.orderType,
								resolution.side,
								resolution.amountBase ?? orderValue.amount,
								orderValue.price,
								orderValue.params ?? {},
							);

							emitOrderExecutionTelemetryInBackground(
								otelMetrics,
								{
									action: "CreateOrder",
									cex,
									accountLabel: selectedBrokerAccount?.label,
									symbol: resolvedOrderTelemetry.symbol,
									side: resolvedOrderTelemetry.side,
									orderType: orderValue.orderType,
									requestedQuantity: resolvedOrderTelemetry.requestedQuantity,
									requestedNotional: orderValue.amount * orderValue.price,
									...extractOrderTelemetryIds(orderValue.params),
								},
								order,
							);

							wrappedCallback(null, { result: JSON.stringify({ ...order }) });
						} catch (error) {
							safeLogError("Order Creation failed", error);
							emitOrderExecutionTelemetryInBackground(
								otelMetrics,
								{
									action: "CreateOrder",
									cex,
									accountLabel: selectedBrokerAccount?.label,
									symbol: resolvedOrderTelemetry.symbol ?? symbol,
									side: resolvedOrderTelemetry.side,
									orderType: orderValue.orderType,
									requestedQuantity:
										resolvedOrderTelemetry.requestedQuantity ??
										orderValue.amount,
									requestedNotional: orderValue.amount * orderValue.price,
									...extractOrderTelemetryIds(orderValue.params),
								},
								undefined,
								error,
							);
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

							emitOrderExecutionTelemetryInBackground(
								otelMetrics,
								{
									action: "GetOrderDetails",
									cex,
									accountLabel: selectedBrokerAccount?.label,
									symbol,
									...extractOrderTelemetryIds(getOrderValue.params),
								},
								orderDetails,
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

				// proto-loader with defaults:true materializes omitted enums as NO_ACTION.
				const subscriptionType = resolveSubscriptionType(type);

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
