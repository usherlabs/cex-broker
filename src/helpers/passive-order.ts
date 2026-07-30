import ccxt from "@usherlabs/ccxt";
import { getErrorMessage } from "./shared/errors";

export const PASSIVE_ORDER_ERROR_CODES = {
	unsupported: "passive_order_unsupported",
	rejected: "passive_order_rejected",
	wouldCross: "passive_order_would_cross",
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

export function classifyPassiveOrderError(
	error: unknown,
): PassiveOrderSubmissionErrorCode {
	// A passive_* code tells the client the venue refused to REST the order for a
	// post-only reason, so the rung may be re-placed at a new price. Balance and
	// credential faults fail that promise: re-placing repeats them verbatim, and
	// labelling them passive turns a shortfall into an unbounded repost loop.
	// Both carry a typed ccxt class, so classify them before the post-only checks
	// and report their own stable code — never the passive catch-all below.
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
	return PASSIVE_ORDER_ERROR_CODES.rejected;
}
