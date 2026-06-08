export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asRecord<
	T extends Record<string, unknown> = Record<string, unknown>,
>(value: unknown): T | undefined {
	return isRecord(value) ? (value as T) : undefined;
}
