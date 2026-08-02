import { describe, expect, test } from "bun:test";
import protobuf from "protobufjs";
import descriptor from "../src/proto/node.descriptor.ts";

describe("Proto descriptor", () => {
	test("matches src/proto/node.proto", async () => {
		const root = await protobuf.load("src/proto/node.proto");
		expect(root.toJSON()).toEqual(descriptor);
	});
});
