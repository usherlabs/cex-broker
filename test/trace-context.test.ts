import { describe, expect, test } from "bun:test";
import { Metadata } from "@grpc/grpc-js";
import {
	extractTraceId,
	TRACE_METADATA_KEY,
} from "../src/helpers/trace-context";

describe("extractTraceId", () => {
	test.each([
		"0123456789abcdef0123456789abcdef",
		"550e8400-e29b-41d4-a716-446655440000",
	])("accepts and trims the supported trace identifier %s", (traceId) => {
		const metadata = new Metadata();
		metadata.set(TRACE_METADATA_KEY, `  ${traceId}  `);

		expect(extractTraceId(metadata)).toBe(traceId);
	});

	test("returns undefined when x-trace-id is missing", () => {
		expect(extractTraceId(new Metadata())).toBeUndefined();
	});

	test.each([
		"",
		"   ",
		"not-a-trace-id",
		"0123456789ABCDEF0123456789ABCDEF",
		"00000000000000000000000000000000",
		"550E8400-E29B-41D4-A716-446655440000",
		"550e8400-e29b-11d4-a716-446655440000",
		"550e8400-e29b-41d4-7716-446655440000",
		`${"a".repeat(256)}-must-never-be-logged`,
	])("silently rejects an invalid trace identifier", (traceId) => {
		const metadata = new Metadata();
		metadata.set(TRACE_METADATA_KEY, traceId);

		expect(extractTraceId(metadata)).toBeUndefined();
	});
});
