import { describe, test, expect } from "bun:test";

describe("Integration Tests", () => {
	describe("Policy Integration", () => {
		test("should load and validate policy correctly", () => {
			// Test that the policy file can be loaded
			const fs = require("bun:fs");
			const path = require("bun:path");
			const policyPath = path.join(__dirname, "./policy/policy.json");

			expect(() => {
				const policyData = fs.readFileSync(policyPath, "utf8");
				const policy = JSON.parse(policyData);
				return policy;
			}).not.toThrow();
		});

		test("should have correct policy structure", () => {
			const fs = require("bun:fs");
			const path = require("bun:path");
			const policyPath = path.join(__dirname, "./policy/policy.json");
			const policyData = fs.readFileSync(policyPath, "utf8");
			const policy = JSON.parse(policyData);

			// Check withdraw policy
			expect(policy.withdraw).toBeDefined();
			expect(policy.withdraw.rule).toBeDefined();
			expect(policy.withdraw.rule.networks).toContain("ARBITRUM");
			expect(policy.withdraw.rule.whitelist).toContain(
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
			const { validateWithdraw } = require("./helpers");
			const { loadPolicy } = require("./helpers");

			const policy = loadPolicy("./policy/policy.json");

			// Test valid withdrawal
			const validResult = validateWithdraw(
				policy,
				"ARBITRUM",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"USDC",
			);

			expect(validResult.valid).toBe(true);

			// Test invalid withdrawal
			const invalidResult = validateWithdraw(
				policy,
				"ETH", // Wrong network
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"USDC",
			);

			expect(invalidResult.valid).toBe(false);
		});

		test("should validate order policy correctly", () => {
			const { validateOrder } = require("./helpers");
			const { loadPolicy } = require("./helpers");

			const policy = loadPolicy("./policy/policy.json");

			// Test valid order
			const validResult = validateOrder(policy, "USDT", "ETH", 1, "BINANCE");

			expect(validResult.valid).toBe(true);

			// Test invalid order
			const invalidResult = validateOrder(policy, "BTC", "ETH", 0.5, "BINANCE");

			expect(invalidResult.valid).toBe(false);
		});
	});

	describe("Price Calculation Integration", () => {
		test("should calculate optimal prices correctly", async () => {
			const { buyAtOptimalPrice, sellAtOptimalPrice } = require("./helpers");

			// Create a mock exchange with realistic order book data
			const mockExchange = {
				fetchOrderBook: async (_symbol: string) => ({
					bids: [
						[100, 10],
						[99, 20],
						[98, 30],
					],
					asks: [
						[101, 10],
						[102, 20],
						[103, 30],
					],
				}),
			};

			// Test buy calculation
			const buyResult = await buyAtOptimalPrice(mockExchange, "ARB/USDT", 25);
			expect(buyResult.avgPrice).toBeGreaterThan(0);
			expect(buyResult.fillPrice).toBeGreaterThan(0);
			expect(buyResult.size).toBe(25);
			expect(buyResult.symbol).toBe("ARB/USDT");

			// Test sell calculation
			const sellResult = await sellAtOptimalPrice(mockExchange, "ARB/USDT", 25);
			expect(sellResult.avgPrice).toBeGreaterThan(0);
			expect(sellResult.fillPrice).toBeGreaterThan(0);
			expect(sellResult.size).toBe(25);
			expect(sellResult.symbol).toBe("ARB/USDT");
		});
	});

	describe("Error Handling Integration", () => {
		test("should handle insufficient depth correctly", async () => {
			const { buyAtOptimalPrice } = require("./helpers");

			const insufficientExchange = {
				fetchOrderBook: async () => ({
					bids: [[100, 5]], // Only 5 volume available
				}),
			};

			await expect(
				buyAtOptimalPrice(insufficientExchange, "ARB/USDT", 10),
			).rejects.toThrow("Insufficient depth");
		});

		test("should handle invalid symbol format", () => {
			const { validateOrder } = require("./helpers");
			const { loadPolicy } = require("./helpers");

			const policy = loadPolicy("./policy/policy.json");

			// Test with invalid symbol format
			const result = validateOrder(
				policy,
				"USDT",
				"ETH",
				0.5,
				"BINANCE",
				"ARB", // Invalid format - missing '/'
			);

			expect(result.valid).toBe(false);
		});
	});
});
