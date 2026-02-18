import { describe, expect, test } from "bun:test";

describe("Integration Tests", () => {
	describe("Policy Integration", () => {
		test("should load and validate policy correctly", () => {
			// Test that the policy file can be loaded
			const fs = require("bun:fs");
			const path = require("bun:path");
			const policyPath = path.join(__dirname, "../policy/policy.json");

			expect(() => {
				const policyData = fs.readFileSync(policyPath, "utf8");
				const policy = JSON.parse(policyData);
				return policy;
			}).not.toThrow();
		});

		test("should have correct policy structure", () => {
			const fs = require("bun:fs");
			const path = require("bun:path");
			const policyPath = path.join(__dirname, "../policy/policy.json");
			const policyData = fs.readFileSync(policyPath, "utf8");
			const policy = JSON.parse(policyData);

			// Check withdraw policy
			expect(policy.withdraw).toBeDefined();
			expect(policy.withdraw.rule).toBeDefined();
			expect(Array.isArray(policy.withdraw.rule)).toBe(true);
			const withdrawRule = policy.withdraw.rule.find(
				(rule) => rule.exchange === "BINANCE" && rule.network === "ARBITRUM",
			);
			expect(withdrawRule).toBeDefined();
			expect(withdrawRule.whitelist).toContain(
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
			);

			// Check order policy
			expect(policy.order).toBeDefined();
			expect(policy.order.rule).toBeDefined();
			expect(policy.order.rule.markets).toContain("BINANCE:ARB/USDT");
			expect(policy.order.rule.limits).toBeDefined();
			expect(policy.order.rule.limits.length).toBeGreaterThan(0);
		});
	});

	describe("Helper Functions Integration", () => {
		test("should validate withdraw policy correctly", () => {
			const { validateWithdraw } = require("../src/helpers");
			const { loadPolicy } = require("../src/helpers");

			const policy = loadPolicy("./policy/policy.json");

			// Test valid withdrawal
			const validResult = validateWithdraw(
				policy,
				"BINANCE",
				"ARBITRUM",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"USDC",
			);

			expect(validResult.valid).toBe(true);

			// Test invalid withdrawal
			const invalidResult = validateWithdraw(
				policy,
				"BINANCE",
				"ETH", // Wrong network
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"USDC",
			);

			expect(invalidResult.valid).toBe(false);
		});

		test("should validate order policy correctly", () => {
			const { validateOrder } = require("../src/helpers");
			const { loadPolicy } = require("../src/helpers");

			const policy = loadPolicy("./policy/policy.json");

			// Test valid order
			const validResult = validateOrder(policy, "USDT", "ETH", 1, "BINANCE");

			expect(validResult.valid).toBe(true);

			// Test invalid order
			const invalidResult = validateOrder(policy, "BTC", "ETH", 0.5, "BINANCE");

			expect(invalidResult.valid).toBe(false);
		});
	});
});
