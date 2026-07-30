import * as grpc from "@grpc/grpc-js";
import ccxt from "@usherlabs/ccxt";
import { getErrorMessage } from "../shared/errors";

export function stableGrpcErrorCode(message: string): grpc.status | undefined {
	if (message.startsWith("AuthenticationError:")) {
		return grpc.status.UNAUTHENTICATED;
	}
	if (message.startsWith("InsufficientFunds:")) {
		return grpc.status.FAILED_PRECONDITION;
	}
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
	if (message.startsWith("passive_order_unsupported:")) {
		return grpc.status.UNIMPLEMENTED;
	}
	if (
		message.startsWith("passive_order_rejected:") ||
		message.startsWith("passive_order_would_cross:")
	) {
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

/** Maps CCXT typed errors to appropriate gRPC status codes. Returns undefined for unrecognized errors. */
export function mapCcxtErrorToGrpcStatus(
	error: unknown,
): grpc.status | undefined {
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

export function resolveGrpcError(
	error: unknown,
	message?: string,
): { code: grpc.status; message: string } {
	const resolvedMessage = message ?? getErrorMessage(error);
	return {
		code:
			stableGrpcErrorCode(resolvedMessage) ??
			mapCcxtErrorToGrpcStatus(error) ??
			grpc.status.INTERNAL,
		message: resolvedMessage,
	};
}
