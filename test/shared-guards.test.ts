import { describe, expect, test } from "bun:test";
import { asRecord, isRecord } from "../src/helpers/shared/guards";

describe("shared guards", () => {
	test("isRecord accepts plain objects", () => {
		expect(isRecord({ a: 1 })).toBe(true);
	});

	test("isRecord rejects null, arrays, and primitives", () => {
		expect(isRecord(null)).toBe(false);
		expect(isRecord([])).toBe(false);
		expect(isRecord("x")).toBe(false);
	});

	test("asRecord returns object or undefined", () => {
		expect(asRecord({ ok: true })).toEqual({ ok: true });
		expect(asRecord(null)).toBeUndefined();
	});
});
