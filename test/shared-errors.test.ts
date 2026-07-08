import { describe, expect, test } from "bun:test";
import {
	errorClassName,
	getErrorMessage,
	sanitizeErrorDetail,
} from "../src/helpers/shared/errors";

class InsufficientFunds extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InsufficientFunds";
	}
}

describe("shared errors", () => {
	test("getErrorMessage handles Error", () => {
		expect(getErrorMessage(new Error("boom"))).toBe("boom");
	});

	test("getErrorMessage handles string", () => {
		expect(getErrorMessage("oops")).toBe("oops");
	});

	test("getErrorMessage handles unknown", () => {
		expect(getErrorMessage(42)).toBe("Unknown error");
	});

	test("errorClassName returns the subclass name", () => {
		expect(errorClassName(new InsufficientFunds("x"))).toBe(
			"InsufficientFunds",
		);
	});

	test("errorClassName drops the generic Error name and non-Errors", () => {
		expect(errorClassName(new Error("x"))).toBeUndefined();
		expect(errorClassName("nope")).toBeUndefined();
	});

	test("sanitizeErrorDetail prefixes the class name to the message", () => {
		expect(
			sanitizeErrorDetail(
				new InsufficientFunds("binance Account has insufficient balance."),
			),
		).toBe("InsufficientFunds: binance Account has insufficient balance.");
	});

	test("sanitizeErrorDetail collapses newlines into a single line", () => {
		const detail = sanitizeErrorDetail(
			new InsufficientFunds("line one\nline two\n\tindented"),
		);
		expect(detail).not.toContain("\n");
		expect(detail).toBe("InsufficientFunds: line one line two indented");
	});

	test("sanitizeErrorDetail caps the detail at 512 characters", () => {
		const detail = sanitizeErrorDetail(new InsufficientFunds("a".repeat(1000)));
		expect(detail.length).toBe(512);
	});

	test("sanitizeErrorDetail falls back to the message for non-Errors", () => {
		expect(sanitizeErrorDetail("plain string")).toBe("plain string");
		expect(sanitizeErrorDetail(new Error("bare"))).toBe("bare");
	});
});
