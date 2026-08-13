import { describe, expect, it } from "bun:test";
import { Metadata } from "@grpc/grpc-js";
import {
	TRACE_METADATA_KEY,
	extractTraceId,
} from "../src/helpers/trace-context";

describe("extractTraceId", () => {
	it("returns the trimmed x-trace-id when present", () => {
		const metadata = new Metadata();
		metadata.set(TRACE_METADATA_KEY, "  abc-123  ");
		expect(extractTraceId(metadata)).toBe("abc-123");
	});

	it("returns undefined when x-trace-id is missing", () => {
		expect(extractTraceId(new Metadata())).toBeUndefined();
	});

	it("returns undefined when x-trace-id is empty or whitespace", () => {
		const empty = new Metadata();
		empty.set(TRACE_METADATA_KEY, "");
		expect(extractTraceId(empty)).toBeUndefined();

		const whitespace = new Metadata();
		whitespace.set(TRACE_METADATA_KEY, "   ");
		expect(extractTraceId(whitespace)).toBeUndefined();
	});
});
