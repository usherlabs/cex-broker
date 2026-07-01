import * as grpc from "@grpc/grpc-js";
import {
	resolveTravelRuleDecision,
	validateWithdraw,
	withdrawViaLocalEntity,
} from "../../helpers";
import {
	mapCcxtErrorToGrpcStatus,
	stableGrpcErrorCode,
} from "../../helpers/grpc/status";
import { log } from "../../helpers/logger";
import { getErrorMessage, safeLogError } from "../../helpers/shared/errors";
import {
	resolveTransferNetwork,
	type TransferNetworkResolution,
} from "../../helpers/transfer-network";
import { WithdrawPayloadSchema } from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import { parsePayloadForAction, rejectWithGrpcError } from "./context";

export async function handleWithdraw(ctx: ExecuteActionContext): Promise<void> {
	const {
		call,
		wrappedCallback,
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
	} = ctx;
	const verityProof = verity.proof;

	if (!symbol) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `ValidationError: Symbol required`,
			},
			null,
		);
	}
	const transferValue = parsePayloadForAction(ctx, WithdrawPayloadSchema);
	if (transferValue === null) return;
	let withdrawNetwork: TransferNetworkResolution;
	try {
		withdrawNetwork = await resolveTransferNetwork(
			broker,
			symbol,
			transferValue.chain,
		);
	} catch (error) {
		const message = getErrorMessage(error);
		return ctx.wrappedCallback(
			{
				code: stableGrpcErrorCode(message) ?? grpc.status.INVALID_ARGUMENT,
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
		return ctx.wrappedCallback(
			{
				code: grpc.status.PERMISSION_DENIED,
				message: `policy_withdrawal_denied: ${transferValidation.error}`,
			},
			null,
		);
	}

	const travelRule = resolveTravelRuleDecision(
		policy,
		cex,
		transferValue.recipientAddress,
	);
	if (travelRule.mode === "denied") {
		return ctx.wrappedCallback(
			{
				code: grpc.status.FAILED_PRECONDITION,
				message: `travel_rule_denied: ${travelRule.error}`,
			},
			null,
		);
	}

	try {
		const transaction =
			travelRule.mode === "localentity"
				? await withdrawViaLocalEntity(broker, {
						code: symbol,
						amount: transferValue.amount,
						address: transferValue.recipientAddress,
						network: withdrawNetwork.exchangeNetworkId,
						questionnaire: travelRule.questionnaire,
						params: transferValue.params,
					})
				: await broker.withdraw(
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
		ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
			result: JSON.stringify({
				...transaction,
				operatorAlias: withdrawNetwork.operatorAlias,
				brokerNetworkId: withdrawNetwork.brokerNetworkId,
				exchangeNetworkId: withdrawNetwork.exchangeNetworkId,
			}),
		});
	} catch (error) {
		safeLogError("Withdraw failed", error);
		const code = mapCcxtErrorToGrpcStatus(error) ?? grpc.status.INTERNAL;
		ctx.wrappedCallback(
			{
				code,
				message: `Withdraw failed: ${getErrorMessage(error)}`,
			},
			null,
		);
	}
}
