import ccxt from "@usherlabs/ccxt";
import { getErrorMessage } from "./shared/errors";

export const PASSIVE_ORDER_ERROR_CODES = {
	unsupported: "passive_order_unsupported",
	rejected: "passive_order_rejected",
	wouldCross: "passive_order_would_cross",
	unknown: "passive_order_unknown",
} as const;

export type PassiveOrderErrorCode =
	(typeof PASSIVE_ORDER_ERROR_CODES)[keyof typeof PASSIVE_ORDER_ERROR_CODES];

export type PassiveOrderSubmissionErrorCode =
	| PassiveOrderErrorCode
	| "AuthenticationError"
	| "InsufficientFunds";

function identifiesWouldCross(message: string): boolean {
	const normalized = message.toLowerCase();
	// Post-only venues reject a crossing limit instead of resting it. Binance
	// says it "would immediately match and take"; Hyperliquid and other venues
	// use equivalent explicit immediate-execution wording.
	return (
		normalized.includes("would immediately match and take") ||
		/post[\s-]?only\b.*\bwould\b.*\bimmediately\b.*\b(?:execute|fill|match)/.test(
			normalized,
		) ||
		/post[\s-]?only\b.*\bwould\b.*\b(?:execute|fill|match)\w*\b.*\bimmediately/.test(
			normalized,
		)
	);
}

function identifiesUnsupported(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		/post[\s-]?only\b.*\b(?:not supported|unsupported|does not support)\b/.test(
			normalized,
		) ||
		/\b(?:not supported|unsupported|does not support)\b.*\bpost[\s-]?only\b/.test(
			normalized,
		)
	);
}

function identifiesPostOnlyRejection(message: string): boolean {
	return /post[\s-]?only\b(?: order)?(?: was)? (?:rejected|refused|rejection)\b/i.test(
		message,
	);
}

export function classifyPassiveOrderError(
	error: unknown,
): PassiveOrderSubmissionErrorCode {
	// Transport failures can occur after acceptance, even when their detail
	// mentions post-only. Only an explicit venue refusal permits re-placement.
	if (error instanceof ccxt.NetworkError) {
		return PASSIVE_ORDER_ERROR_CODES.unknown;
	}
	// Balance and credential failures are not post-only refusals; retrying at a
	// new price does not fix them. Preserve their existing stable codes.
	if (error instanceof ccxt.InsufficientFunds) {
		return "InsufficientFunds";
	}
	// PermissionDenied extends AuthenticationError, so this covers both.
	if (error instanceof ccxt.AuthenticationError) {
		return "AuthenticationError";
	}
	const message = getErrorMessage(error);
	if (
		error instanceof ccxt.OrderImmediatelyFillable ||
		identifiesWouldCross(message)
	) {
		return PASSIVE_ORDER_ERROR_CODES.wouldCross;
	}
	if (error instanceof ccxt.NotSupported || identifiesUnsupported(message)) {
		return PASSIVE_ORDER_ERROR_CODES.unsupported;
	}
	if (identifiesPostOnlyRejection(message)) {
		return PASSIVE_ORDER_ERROR_CODES.rejected;
	}
	return PASSIVE_ORDER_ERROR_CODES.unknown;
}
