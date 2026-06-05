import { describe, expect, test } from "bun:test";
import { getErrorMessage } from "../src/helpers/shared/errors";

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
});
