export type ActionPayload = Record<string, unknown>;

export type PayloadFieldShape = Record<
	string,
	{
		type: "number" | "jsonObject" | "jsonArray";
		required?: boolean;
	}
>;

export class PayloadValidationError extends Error {
	constructor(message: string) {
		super(`ValidationError: ${message}`);
		this.name = "PayloadValidationError";
	}
}

function parseNumberField(value: unknown, fieldName: string): number {
	if (typeof value !== "string" && typeof value !== "number") {
		throw new PayloadValidationError(`'${fieldName}' must be a numeric string`);
	}
	const parsed = typeof value === "number" ? value : Number(value.trim());
	if (!Number.isFinite(parsed)) {
		throw new PayloadValidationError(`'${fieldName}' must be a valid number`);
	}
	return parsed;
}

function parseJsonField(
	value: unknown,
	fieldName: string,
	expected: "jsonObject" | "jsonArray",
): Record<string, unknown> | unknown[] {
	const parsedValue =
		typeof value === "string"
			? (() => {
					try {
						return JSON.parse(value);
					} catch {
						throw new PayloadValidationError(
							`Failed to parse JSON for '${fieldName}'`,
						);
					}
				})()
			: value;

	if (expected === "jsonObject") {
		if (
			typeof parsedValue !== "object" ||
			parsedValue === null ||
			Array.isArray(parsedValue)
		) {
			throw new PayloadValidationError(`'${fieldName}' must be a JSON object`);
		}
		return parsedValue as Record<string, unknown>;
	}

	if (!Array.isArray(parsedValue)) {
		throw new PayloadValidationError(`'${fieldName}' must be a JSON array`);
	}
	return parsedValue;
}

export class PayloadReader {
	private readonly payload: ActionPayload;

	constructor(payload: ActionPayload | undefined | null) {
		this.payload = { ...(payload ?? {}) };
	}

	public read(shape: PayloadFieldShape): ActionPayload {
		const prepared: ActionPayload = { ...this.payload };

		for (const [fieldName, spec] of Object.entries(shape)) {
			const rawValue = prepared[fieldName];
			const isMissing = rawValue === undefined || rawValue === null;
			if (isMissing) {
				if (spec.required) {
					throw new PayloadValidationError(`'${fieldName}' is required`);
				}
				continue;
			}

			if (spec.type === "number") {
				prepared[fieldName] = parseNumberField(rawValue, fieldName);
				continue;
			}

			prepared[fieldName] = parseJsonField(rawValue, fieldName, spec.type);
		}

		return prepared;
	}
}

