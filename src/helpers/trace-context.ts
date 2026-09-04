import type { Metadata } from "@grpc/grpc-js";

/** gRPC metadata key for lightweight operational correlation with callers. */
export const TRACE_METADATA_KEY = "x-trace-id";

const MAX_TRACE_METADATA_LENGTH = 128;
const OTEL_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ZERO_OTEL_TRACE_ID = "00000000000000000000000000000000";

/**
 * Returns a validated caller correlation ID without mutating inbound metadata.
 * Invalid values are deliberately discarded before they can reach telemetry.
 */
export function extractTraceId(metadata: Metadata): string | undefined {
	const raw = metadata.get(TRACE_METADATA_KEY)[0];
	if (typeof raw !== "string" || raw.length > MAX_TRACE_METADATA_LENGTH) {
		return undefined;
	}

	const traceId = raw.trim();
	if (
		(OTEL_TRACE_ID_PATTERN.test(traceId) && traceId !== ZERO_OTEL_TRACE_ID) ||
		UUID_V4_PATTERN.test(traceId)
	) {
		return traceId;
	}
	return undefined;
}
