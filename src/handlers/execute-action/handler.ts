import type { Metadata } from "@grpc/grpc-js";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { authenticateRequest } from "../../helpers/auth";
import {
	type BrokerPoolEntry,
	createBroker,
	createPublicBroker,
} from "../../helpers/broker";
import {
	type BrokerExecutionArchiver,
	WithdrawalObservationTracker,
} from "../../helpers/broker-execution-archive";
import { Action, getActionName, resolveAction } from "../../helpers/constants";
import {
	type CredentialPolicy,
	CredentialPolicyConfigurationError,
	hasRequestCredentialMetadata,
	loadCredentialPolicyFromEnv,
	resolveCredentialSelection,
} from "../../helpers/credential-policy";
import { selectBrokerAccountForCex } from "../../helpers/grpc/broker";
import { log } from "../../helpers/logger";
import type { OrderActivityTracker } from "../../helpers/order-activity-tracker";
import { isOrderBookCallMethod } from "../../helpers/order-book";
import type { OtelMetrics } from "../../helpers/otel";
import { safeLogError } from "../../helpers/shared/errors";
import {
	buildHttpClientOverrideFromMetadata,
	verityHttpClientOverridePredicate,
} from "../../helpers/verity";
import type { PolicyConfig } from "../../types";
import type { ActionRequest, ActionResponse } from "../types";
import type { ExecuteActionContext } from "./context";
import { handleOrderBookCall } from "./order-book-call";
import { dispatchExecuteAction } from "./registry";

export type ExecuteActionDeps = {
	policy: PolicyConfig;
	brokers: Record<string, BrokerPoolEntry>;
	whitelistIps: string[];
	useVerity: boolean;
	verityProverUrl: string;
	otelMetrics?: OtelMetrics;
	brokerArchiver?: BrokerExecutionArchiver;
	orderActivityTracker?: OrderActivityTracker;
	withdrawalObservationTracker?: WithdrawalObservationTracker;
	credentialPolicy?: CredentialPolicy;
};

function isPublicMarketDataAction(
	action: ReturnType<typeof resolveAction>,
	payload: Record<string, string> | undefined,
): boolean {
	if (action !== Action.Call) return false;
	return isOrderBookCallMethod(payload?.method ?? payload?.functionName);
}

export function createExecuteActionHandler(deps: ExecuteActionDeps) {
	const {
		policy,
		brokers,
		whitelistIps,
		useVerity,
		verityProverUrl,
		otelMetrics,
		brokerArchiver,
		orderActivityTracker,
	} = deps;
	const withdrawalObservationTracker =
		deps.withdrawalObservationTracker ?? new WithdrawalObservationTracker();
	const credentialPolicy =
		deps.credentialPolicy ?? loadCredentialPolicyFromEnv({});

	return async (
		call: grpc.ServerUnaryCall<ActionRequest, ActionResponse>,
		callback: grpc.sendUnaryData<ActionResponse>,
	) => {
		const startTime = Date.now();
		const { action: rawAction, cex, symbol } = call.request;
		const action = resolveAction(rawAction);
		let actionCompleted = false;

		const wrappedCallback: grpc.sendUnaryData<ActionResponse> = (
			error,
			value,
		) => {
			if (!actionCompleted) {
				actionCompleted = true;
				const latency = Date.now() - startTime;
				const actionName = getActionName(action);
				otelMetrics?.recordHistogram("execute_action_duration_ms", latency, {
					action: actionName,
					cex: cex || "unknown",
				});
				if (error) {
					otelMetrics?.recordCounter("execute_action_errors_total", 1, {
						action: actionName,
						cex: cex || "unknown",
						error_type: error.code
							? grpc.status[error.code] || "unknown"
							: "unknown",
					});
				} else {
					otelMetrics?.recordCounter("execute_action_success_total", 1, {
						action: actionName,
						cex: cex || "unknown",
					});
				}
			}
			callback(error, value);
		};

		try {
			log.info(`Request - ExecuteAction:`, { action, cex, symbol });
			otelMetrics?.recordCounter("execute_action_requests_total", 1, {
				action: getActionName(action),
				cex: cex || "unknown",
			});

			if (!authenticateRequest(call, whitelistIps)) {
				return wrappedCallback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: "Access denied: Unauthorized IP",
					},
					null,
				);
			}

			if (!action || !cex) {
				return wrappedCallback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: "`action` AND `cex` fields are required",
					},
					null,
				);
			}

			if (
				credentialPolicy.sourcePolicy === "provisioned_only" &&
				hasRequestCredentialMetadata(call.metadata)
			) {
				void otelMetrics?.recordCounter(
					"cex_request_credentials_rejected_total",
					1,
					{ rpc: "ExecuteAction" },
				);
				return wrappedCallback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message:
							"Request-supplied exchange credentials are forbidden by deployment policy",
					},
					null,
				);
			}

			const normalizedCex = cex.trim().toLowerCase();
			const metadata: Metadata = call.metadata;
			const selectedBrokerAccount = selectBrokerAccountForCex(
				normalizedCex,
				brokers,
				metadata,
			);
			let broker: Exchange | null;
			try {
				const credentialSelection = resolveCredentialSelection({
					policy: credentialPolicy,
					selectedProvisionedBroker: selectedBrokerAccount?.exchange,
					publicOperation: isPublicMarketDataAction(
						action,
						call.request.payload,
					),
				});
				if (credentialSelection.mode === "public") {
					broker = createPublicBroker(normalizedCex);
				} else if (credentialSelection.mode === "provisioned") {
					broker = credentialSelection.broker;
				} else {
					broker =
						selectedBrokerAccount?.exchange ??
						createBroker(normalizedCex, call.metadata) ??
						(isPublicMarketDataAction(action, call.request.payload)
							? createPublicBroker(normalizedCex)
							: null);
				}
			} catch (error) {
				if (error instanceof CredentialPolicyConfigurationError) {
					return wrappedCallback(
						{
							code:
								error.kind === "missing_provisioned_broker"
									? grpc.status.UNAUTHENTICATED
									: grpc.status.PERMISSION_DENIED,
							message: error.message,
						},
						null,
					);
				}
				throw error;
			}
			if (!broker) {
				return wrappedCallback(
					{
						code: grpc.status.UNAUTHENTICATED,
						message: `This Exchange is not registered and No API metadata was found`,
					},
					null,
				);
			}

			const verity = { proof: "" };
			const applyVerityToBroker = (targetBroker: Exchange) => {
				if (!useVerity) return;
				const override = buildHttpClientOverrideFromMetadata(
					metadata,
					verityProverUrl,
					(proof, notaryPubKey) => {
						verity.proof = proof;
						log.debug(`Verity proof:`, { proof, notaryPubKey });
					},
				);
				targetBroker.setHttpClientOverride(
					override,
					verityHttpClientOverridePredicate,
				);
			};

			const preludeCtx: ExecuteActionContext = {
				call,
				wrappedCallback,
				action,
				policy,
				brokers,
				metadata,
				normalizedCex,
				cex,
				symbol,
				selectedBrokerAccount,
				broker,
				verity,
				applyVerityToBroker,
				useVerity,
				verityProverUrl,
				otelMetrics,
				brokerArchiver,
				orderActivityTracker,
				withdrawalObservationTracker,
			};

			if (action === Action.Call) {
				const handled = await handleOrderBookCall(preludeCtx);
				if (handled) return;
			}

			applyVerityToBroker(broker);

			const ctx: ExecuteActionContext = { ...preludeCtx, broker };
			await dispatchExecuteAction(ctx);
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
	};
}
