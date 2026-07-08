import * as grpc from "@grpc/grpc-js";
import {
	BrokerAccountPreconditionError,
	buildHttpClientOverrideFromMetadata,
	getCurrentBrokerSelector,
	resolveBrokerAccount,
	transferBinanceInternal,
	verityHttpClientOverridePredicate,
} from "../../helpers";
import {
	archiveTransferEventInBackground,
	normalizeCcxtTransactionForArchive,
} from "../../helpers/broker-execution-archive";
import { mapCcxtErrorToGrpcStatus } from "../../helpers/grpc/status";
import { log } from "../../helpers/logger";
import {
	getErrorMessage,
	safeLogError,
	sanitizeErrorDetail,
} from "../../helpers/shared/errors";
import { InternalTransferPayloadSchema } from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import { parsePayloadForAction } from "./context";

export async function handleInternalTransfer(
	ctx: ExecuteActionContext,
): Promise<void> {
	const {
		brokers,
		metadata,
		normalizedCex,
		symbol,
		verity,
		useVerity,
		verityProverUrl,
		brokerArchiver,
	} = ctx;

	if (!symbol) {
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `ValidationError: Symbol required`,
			},
			null,
		);
	}
	const transferPayload = parsePayloadForAction(
		ctx,
		InternalTransferPayloadSchema,
	);
	if (transferPayload === null) return;
	if (normalizedCex !== "binance") {
		return ctx.wrappedCallback(
			{
				code: grpc.status.UNIMPLEMENTED,
				message: `InternalTransfer is only supported for Binance`,
			},
			null,
		);
	}
	const pool = brokers[normalizedCex as keyof typeof brokers];
	if (!pool) {
		return ctx.wrappedCallback(
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
		return ctx.wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `Source account "${fromSelector}" is not configured`,
			},
			null,
		);
	}
	const destAccount = resolveBrokerAccount(pool, toSelector);
	if (!destAccount) {
		return ctx.wrappedCallback(
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
						verity.proof = proof;
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
		// account_selector is the source; the destination is kept in payload_json.
		const normalized = normalizeCcxtTransactionForArchive(result);
		archiveTransferEventInBackground(brokerArchiver, {
			exchange: normalizedCex,
			accountSelector: fromSelector,
			assetSymbol: symbol,
			transfer: {
				eventKind: "internal_transfer",
				lifecycleAction: "submit_internal_transfer",
				status: normalized.status ?? "ok",
				amount: normalized.amount ?? String(transferPayload.amount),
				network: "internal",
				externalId: normalized.externalId,
				payload: { from: fromSelector, to: toSelector, result },
			},
		});
		ctx.wrappedCallback(null, {
			proof: verity.proof,
			result: JSON.stringify(result),
		});
	} catch (error) {
		safeLogError("InternalTransfer failed", error);
		if (error instanceof BrokerAccountPreconditionError) {
			return ctx.wrappedCallback(
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
		ctx.wrappedCallback(
			{
				code,
				message: `InternalTransfer failed: ${sanitizeErrorDetail(error)}`,
			},
			null,
		);
	}
}
