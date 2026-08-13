import type { Metadata } from "@grpc/grpc-js";

/** gRPC metadata key for lightweight caller → broker correlation (broker contract). */
export const TRACE_METADATA_KEY = "x-trace-id";

/**
 * Extract optional `x-trace-id` from inbound gRPC metadata.
 * Does not remove the key — it is harmless and useful for debugging.
 */
export function extractTraceId(metadata: Metadata): string | undefined {
	const values = metadata.get(TRACE_METADATA_KEY);
	const raw = values?.[0];
	if (raw === undefined) {
		return undefined;
	}
	const text = (typeof raw === "string" ? raw : raw.toString("utf8")).trim();
	return text.length > 0 ? text : undefined;
}
