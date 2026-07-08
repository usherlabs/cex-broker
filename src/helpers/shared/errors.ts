import { log } from "../logger";

/** Upper bound for a surfaced error detail. Long enough for a full ccxt venue
 * message, short enough to keep gRPC trailers small. */
const MAX_ERROR_DETAIL_LENGTH = 512;

export function getErrorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === "string"
			? error
			: "Unknown error";
}

/** Constructor/class name of a caught error (ccxt classes like InsufficientFunds,
 * BadSymbol, OrderNotFound carry the actionable signal). The generic `Error` name
 * adds nothing, so it is dropped; returns undefined for non-Error values. */
export function errorClassName(error: unknown): string | undefined {
	if (!(error instanceof Error)) {
		return undefined;
	}
	const name = error.constructor?.name || error.name;
	return name && name !== "Error" ? name : undefined;
}

/** Sanitized, single-line, length-capped detail for a caught error: the venue
 * error class name plus its message. Safe to return to gRPC callers — it carries
 * only the exchange's own error text (class + message), never a stack or payload,
 * so downstream consumers can distinguish e.g. InsufficientFunds from BadSymbol
 * instead of an opaque "<action> failed". */
export function sanitizeErrorDetail(error: unknown): string {
	const className = errorClassName(error);
	const message = getErrorMessage(error);
	const detail = className ? `${className}: ${message}` : message;
	return detail.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_DETAIL_LENGTH);
}

export function safeLogError(context: string, error: unknown): void {
	try {
		log.error(context, { error });
	} catch {
		console.error(context, error);
	}
}
