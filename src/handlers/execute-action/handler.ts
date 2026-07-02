import type { Metadata } from "@grpc/grpc-js";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { authenticateRequest } from "../../helpers/auth";
import { type BrokerPoolEntry, createBroker } from "../../helpers/broker";
import type { BrokerExecutionArchiver } from "../../helpers/broker-execution-archive";
import { Action, getActionName, resolveAction } from "../../helpers/constants";
import { selectBrokerAccountForCex } from "../../helpers/grpc/broker";
import { log } from "../../helpers/logger";
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
};

export function createExecuteActionHandler(deps: ExecuteActionDeps) {
	const {
		policy,
		brokers,
		whitelistIps,
		useVerity,
		verityProverUrl,
		otelMetrics,
		brokerArchiver,
	} = deps;

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

			const normalizedCex = cex.trim().toLowerCase();
			const metadata: Metadata = call.metadata;
			const selectedBrokerAccount = selectBrokerAccountForCex(
				normalizedCex,
				brokers,
				metadata,
			);

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
				broker:
					selectedBrokerAccount?.exchange ??
					(createBroker(normalizedCex, metadata) as Exchange),
				verity,
				applyVerityToBroker,
				useVerity,
				verityProverUrl,
				otelMetrics,
				brokerArchiver,
			};

			if (action === Action.Call) {
				const handled = await handleOrderBookCall(preludeCtx);
				if (handled) return;
			}

			const broker =
				selectedBrokerAccount?.exchange ??
				createBroker(normalizedCex, metadata);

			if (!broker) {
				return wrappedCallback(
					{
						code: grpc.status.UNAUTHENTICATED,
						message: `This Exchange is not registered and No API metadata was found`,
					},
					null,
				);
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
