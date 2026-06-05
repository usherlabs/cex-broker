import * as grpc from "@grpc/grpc-js";
import ccxt from "@usherlabs/ccxt";
import {
	depositField,
	depositMatchesTransaction,
	normalizeAddress,
	normalizeDepositStatus,
	stringAmountEquals,
} from "../../helpers/deposit";
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
import type { ExchangeWithDiscovery } from "../../helpers/treasury-discovery";
import { DepositPayloadSchema } from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import { parsePayloadForAction, rejectWithGrpcError } from "./context";

export async function handleDeposit(ctx: ExecuteActionContext): Promise<void> {
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
				message: "ValidationError: Symbol required",
			},
			null,
		);
	}
	const value = parsePayloadForAction(ctx, DepositPayloadSchema);
	if (value === null) return;
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
			return ctx.wrappedCallback(null, {
				proof: ctx.verity.proof,
				result: JSON.stringify({
					status: "unsupported",
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
				return ctx.wrappedCallback(
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
				return ctx.wrappedCallback(
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
			return ctx.wrappedCallback(null, {
				proof: ctx.verity.proof,
				result: JSON.stringify({
					status,
					exchange: normalizedCex,
					accountSelector: selectedBrokerAccount?.label,
					asset: symbol,
					operatorAlias: depositNetwork?.operatorAlias ?? null,
					brokerNetworkId: depositNetwork?.brokerNetworkId ?? null,
					exchangeNetworkId: depositNetwork?.exchangeNetworkId ?? null,
					txid:
						depositField(deposit, ["txid", "txId", "tx_hash", "txHash"]) ??
						value.transactionHash,
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
		return ctx.wrappedCallback(null, {
			proof: ctx.verity.proof,
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
			return ctx.wrappedCallback(null, {
				proof: ctx.verity.proof,
				result: JSON.stringify({
					status: "unsupported",
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
					raw: { error: message },
				}),
			});
		}
		rejectWithGrpcError(ctx, error, {
			message,
			prefix: "deposit_observation_unavailable: ",
		});
	}
}
