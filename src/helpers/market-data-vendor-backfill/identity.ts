import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export function jcsCanonicalize(value: unknown): string {
	const rendered = canonicalize(value);
	if (rendered === undefined) {
		throw new TypeError("Value is not representable as RFC 8785 JSON");
	}
	return rendered;
}

export function jcsSha256(value: unknown): string {
	return createHash("sha256")
		.update(jcsCanonicalize(value), "utf8")
		.digest("hex");
}

export function withoutOwnDigest<T extends Record<string, unknown>>(
	document: T,
	digestField: keyof T | string,
): Omit<T, keyof T> & Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(document).filter(([key]) => key !== digestField),
	) as Omit<T, keyof T> & Record<string, unknown>;
}

/** Hashes a wire document while excluding only its own top-level digest field. */
export function documentSha256<T extends Record<string, unknown>>(
	document: T,
	digestField: keyof T | string,
): string {
	return jcsSha256(withoutOwnDigest(document, digestField));
}

export function assertDocumentSha256<T extends Record<string, unknown>>(
	document: T,
	digestField: keyof T | string,
): void {
	const supplied = document[String(digestField)];
	if (
		typeof supplied !== "string" ||
		supplied !== documentSha256(document, digestField)
	) {
		throw new Error(
			`${String(digestField)} does not match RFC 8785 document content`,
		);
	}
}
