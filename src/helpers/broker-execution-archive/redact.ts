import { createHash } from "node:crypto";
import { REDACTED_ERROR_MESSAGE } from "../shared/errors";
import { asRecord } from "../shared/guards";

const SECRET_KEY_PATTERN =
	/\b(api[_-]?key|api[_-]?secret|secret|signature|passphrase|password|token|credential)\b/i;
const SECRET_VALUE_PATTERN =
	/(\b(?:apiKey|api_key|apiSecret|api_secret|secret|signature|passphrase|password|token)\b\s*[=:]\s*)[^\s&,;)}\]]+/gi;
const SECRET_JSON_PATTERN =
	/("(?:apiKey|api_key|apiSecret|api_secret|secret|signature|passphrase|password|token)"\s*:\s*")[^"]*(")/gi;

export function redactErrorForArchive(error: unknown): {
	error_type?: string;
	error_message?: string;
} {
	if (!(error instanceof Error)) {
		return {};
	}
	return {
		error_type: error.name,
		error_message: REDACTED_ERROR_MESSAGE,
	};
}

export function redactSecretLiterals(
	value: string,
	secretLiterals: readonly string[] = [],
): string {
	let redacted = value;
	for (const literal of secretLiterals) {
		if (literal.length > 0) {
			redacted = redacted.split(literal).join("[redacted]");
		}
	}
	return redacted
		.replace(SECRET_VALUE_PATTERN, "$1[redacted]")
		.replace(SECRET_JSON_PATTERN, "$1[redacted]$2");
}

type RedactedValue =
	| null
	| undefined
	| string
	| number
	| boolean
	| RedactedValue[]
	| { [key: string]: RedactedValue };

function redactUnknownValue(
	value: unknown,
	secretLiterals: readonly string[],
): RedactedValue {
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === "string") {
		return redactSecretLiterals(value, secretLiterals);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => redactUnknownValue(entry, secretLiterals));
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const redacted: Record<string, RedactedValue> = {};
		for (const [key, entry] of Object.entries(record)) {
			if (SECRET_KEY_PATTERN.test(key)) {
				redacted[key] = "[redacted]";
				continue;
			}
			redacted[key] = redactUnknownValue(entry, secretLiterals);
		}
		return redacted;
	}
	return String(value);
}

export function removeSecretMaterial(
	value: unknown,
	secretLiterals: readonly string[] = [],
): RedactedValue {
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === "string") {
		return redactSecretLiterals(value, secretLiterals);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => removeSecretMaterial(entry, secretLiterals));
	}
	if (typeof value === "object") {
		const clean: Record<string, RedactedValue> = {};
		for (const [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (!SECRET_KEY_PATTERN.test(key)) {
				clean[key] = removeSecretMaterial(entry, secretLiterals);
			}
		}
		return clean;
	}
	return String(value);
}

export function redactStreamPayload(
	payload: unknown,
	secretLiterals: readonly string[] = [],
): Record<string, unknown> {
	if (Array.isArray(payload)) {
		return {
			items: payload.map((entry) => redactUnknownValue(entry, secretLiterals)),
		};
	}
	const record = asRecord(payload);
	if (!record) {
		return {};
	}
	return redactUnknownValue(record, secretLiterals) as Record<string, unknown>;
}

export function hashMarketMetadata(payload: unknown): string | undefined {
	if (payload === undefined || payload === null) {
		return undefined;
	}
	try {
		const normalized = JSON.stringify(payload);
		if (!normalized || normalized === "{}") {
			return undefined;
		}
		return createHash("sha256").update(normalized).digest("hex");
	} catch {
		return undefined;
	}
}
