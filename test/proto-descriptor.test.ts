import { describe, expect, test } from "bun:test";
import protobuf from "protobufjs";
import descriptor from "../src/proto/node.descriptor.ts";

describe("Proto descriptor", () => {
	test("matches src/proto/node.proto", async () => {
		const root = await protobuf.load("src/proto/node.proto");
		expect(JSON.stringify(root.toJSON())).toBe(JSON.stringify(descriptor));
	});

	test("keeps ActionRequest and ActionResponse field shapes stable", () => {
		const messages = descriptor.nested.cex_broker.nested;
		expect(messages.ActionRequest.fields).toEqual({
			action: { type: "Action", id: 1 },
			payload: { keyType: "string", type: "string", id: 2 },
			cex: { type: "string", id: 3 },
			symbol: { type: "string", id: 4 },
		});
		expect(messages.ActionResponse.fields).toEqual({
			result: { type: "string", id: 1 },
			proof: { type: "string", id: 2 },
		});
	});
});
