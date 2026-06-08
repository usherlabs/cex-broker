import type { z } from "zod";

export type ParsePayloadResult<T> =
	| { success: true; data: T }
	| { success: false; message: string };

export function parsePayload<T>(
	schema: z.ZodType<T>,
	rawPayload: Record<string, string> | undefined,
): ParsePayloadResult<T> {
	const parsed = schema.safeParse(rawPayload ?? {});
	if (parsed.success) {
		return { success: true, data: parsed.data };
	}
	const firstIssue = parsed.error.issues[0];
	const path =
		firstIssue && firstIssue.path.length > 0
			? `${firstIssue.path.join(".")}: `
			: "";
	return {
		success: false,
		message: `ValidationError: ${path}${firstIssue?.message ?? "Invalid payload"}`,
	};
}
