import { describe, expect, test } from "bun:test";
import {
	depositMatchesTransaction,
	normalizeAddress,
	normalizeDepositStatus,
	stringAmountEquals,
} from "../src/helpers/deposit";

describe("deposit helpers", () => {
	test("normalizeDepositStatus maps credited states", () => {
		expect(normalizeDepositStatus("ok")).toBe("credited");
		expect(normalizeDepositStatus("pending")).toBe("pending");
	});

	test("normalizeDepositStatus keeps empty and unknown states pending", () => {
		expect(normalizeDepositStatus(undefined)).toBe("pending");
		expect(normalizeDepositStatus("")).toBe("pending");
		expect(normalizeDepositStatus("not-yet-indexed")).toBe("pending");
	});

	test("depositMatchesTransaction matches txid", () => {
		expect(depositMatchesTransaction({ txid: "0xabc" }, "0xabc")).toBe(true);
	});

	test("stringAmountEquals compares numeric strings", () => {
		expect(stringAmountEquals("1.0", 1)).toBe(true);
	});

	test("normalizeAddress lowercases", () => {
		expect(normalizeAddress(" 0xABC ")).toBe("0xabc");
	});
});
