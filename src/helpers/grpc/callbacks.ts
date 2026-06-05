import * as grpc from "@grpc/grpc-js";
import type { z } from "zod";
import { type ParsePayloadResult, parsePayload } from "./payload";

export function invalidArgumentError(message: string): grpc.ServiceError {
	return {
		code: grpc.status.INVALID_ARGUMENT,
		message,
		details: message,
		metadata: new grpc.Metadata(),
	} as grpc.ServiceError;
}

export function rejectInvalidPayload<T>(
	parsed: ParsePayloadResult<T>,
	callback: (error: grpc.ServiceError | null, value: null) => void,
): parsed is { success: true; data: T } {
	if (!parsed.success) {
		callback(invalidArgumentError(parsed.message), null);
		return false;
	}
	return true;
}

export function parseActionPayload<T>(
	schema: z.ZodType<T>,
	rawPayload: Record<string, string> | undefined,
	callback: (error: grpc.ServiceError | null, value: null) => void,
): T | null {
	const parsed = parsePayload(schema, rawPayload);
	if (!rejectInvalidPayload(parsed, callback)) {
		return null;
	}
	return parsed.data;
}
