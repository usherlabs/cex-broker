import { log } from "../logger";

/** Upper bound for a surfaced error detail. Long enough for a full ccxt venue
 * message, short enough to keep gRPC trailers small. */
const MAX_ERROR_DETAIL_LENGTH = 512;
export const REDACTED_ERROR_MESSAGE = "redacted_error";

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

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object") {
		return undefined;
	}
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string") {
		return code.trim() || undefined;
	}
	if (typeof code === "number" && Number.isFinite(code)) {
		return String(code);
	}
	if (typeof code === "bigint") {
		return String(code);
	}
	return undefined;
}

/** Sanitized, single-line, length-capped detail for a caught error: the venue
 * error class, optional primitive code, and message. It never includes a stack
 * or attached payload. */
export function sanitizeErrorDetail(
	error: unknown,
	options: { includeCode?: boolean } = {},
): string {
	const className = errorClassName(error);
	const message = getErrorMessage(error);
	const code = options.includeCode ? errorCode(error) : undefined;
	const prefix = [className, code ? `[code=${code}]` : undefined]
		.filter((part): part is string => Boolean(part))
		.join(" ");
	const detail = prefix ? `${prefix}: ${message}` : message;
	return detail.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_DETAIL_LENGTH);
}

export function safeLogError(context: string, error: unknown): void {
	try {
		log.error(context, { error });
	} catch {
		console.error(context, error);
	}
}

export function safeLogRedactedError(context: string, error: unknown): void {
	const errorType =
		errorClassName(error) ??
		(error instanceof Error ? error.name : typeof error);
	try {
		log.error(context, {
			error_type: errorType,
			error_message: REDACTED_ERROR_MESSAGE,
		});
	} catch {
		console.error(context, {
			error_type: errorType,
			error_message: REDACTED_ERROR_MESSAGE,
		});
	}
}
