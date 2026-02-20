import { describe, expect, test } from "bun:test";
import {
	PayloadReader,
	PayloadValidationError,
} from "../src/utils/payload-reader";

describe("PayloadReader", () => {
	test("should parse numeric string fields", () => {
		const reader = new PayloadReader({
			amount: "100.5",
			price: "2",
		});

		const payload = reader.read({
			amount: { type: "number", required: true },
			price: { type: "number", required: true },
		});

		expect(payload.amount).toBe(100.5);
		expect(payload.price).toBe(2);
	});

	test("should parse JSON object and array fields", () => {
		const reader = new PayloadReader({
			params: '{"network":"ARBITRUM"}',
			args: '["BTC/USDT", {"limit": 50}]',
		});

		const payload = reader.read({
			params: { type: "jsonObject" },
			args: { type: "jsonArray" },
		});

		expect(payload.params).toEqual({ network: "ARBITRUM" });
		expect(payload.args).toEqual(["BTC/USDT", { limit: 50 }]);
	});

	test("should throw on invalid numeric field", () => {
		const reader = new PayloadReader({ amount: "NaN" });

		expect(() =>
			reader.read({ amount: { type: "number", required: true } }),
		).toThrow(PayloadValidationError);
	});

	test("should throw on missing required field", () => {
		const reader = new PayloadReader({});

		expect(() =>
			reader.read({ amount: { type: "number", required: true } }),
		).toThrow(PayloadValidationError);
	});
});

