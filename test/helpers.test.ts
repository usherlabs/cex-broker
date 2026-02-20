import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import type { PolicyConfig } from "../src/types";
import type { Exchange } from "@usherlabs/ccxt";
import {
	loadPolicy,
	resolveOrderExecution,
	validateDeposit,
	validateOrder,
	validateWithdraw,
} from "../src/helpers/index";

describe("Helper Functions", () => {
	let testPolicy: PolicyConfig;

	beforeEach(() => {
		testPolicy = {
			withdraw: {
				rule: [
					{
						exchange: "BINANCE",
						network: "ARB",
						whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
					},
					{
						exchange: "*",
						network: "ARB",
						whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
					},
				],
			},
			deposit: {},
			order: {
				rule: {
					markets: [
						"BINANCE:ARB/USDT",
						"BYBIT:ARB/USDC",
						"UPBIT:ETH/USDC",
						"BINANCE:ETH/USDT",
						"BINANCE:BTC/ETH",
					],
					limits: [
						{ from: "USDT", to: "ETH", min: 1, max: 100_000 },
						{ from: "ETH", to: "USDT", min: 0.5, max: 5 },
						{ from: "ARB", to: "USDC", min: 1, max: 1000 },
						{ from: "USDC", to: "ARB", min: 1, max: 10000 },
					],
				},
			},
		};
	});

	describe("loadPolicy", () => {
		test("should load policy successfully", () => {
			const policy = loadPolicy("./policy/policy.json");

			expect(policy).toBeDefined();
			expect(Array.isArray(policy.withdraw.rule)).toBe(true);
			const binanceArbitrum = policy.withdraw.rule.find(
				(rule) => rule.exchange === "BINANCE" && rule.network === "ARBITRUM",
			);
			expect(binanceArbitrum).toBeDefined();
			expect(binanceArbitrum?.whitelist).toContain(
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
			);
		});

		test("should default missing order limits to empty array", () => {
			const tempPath = path.join(
				os.tmpdir(),
				`policy-${Date.now()}-${Math.random()}.json`,
			);
			const tempPolicy = {
				withdraw: {
					rule: [
						{
							exchange: "BINANCE",
							network: "ARB",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
						},
					],
				},
				deposit: {},
				order: {
					rule: {
						markets: ["*"],
					},
				},
			};
			fs.writeFileSync(tempPath, JSON.stringify(tempPolicy));
			try {
				const policy = loadPolicy(tempPath);
				expect(policy.order.rule.limits).toEqual([]);
			} finally {
				fs.unlinkSync(tempPath);
			}
		});
	});

	describe("validateWithdraw", () => {
		test("should validate successful withdrawal", () => {
			const result = validateWithdraw(
				testPolicy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"USDC",
			);

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		test("should reject unauthorized network", () => {
			const result = validateWithdraw(
				testPolicy,
				"BYBIT",
				"ETH", // Not in allowed networks
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"USDC",
			);

			expect(result.valid).toBe(false);
			expect(result.error).toContain("Network ETH is not allowed");
		});

		test("should reject non-whitelisted address", () => {
			const result = validateWithdraw(
				testPolicy,
				"BINANCE",
				"ARB",
				"0x1234567890123456789012345678901234567890", // Not whitelisted
				1000,
				"USDC",
			);

			expect(result.valid).toBe(false);
			expect(result.error).toContain("is not whitelisted for withdrawals");
		});

		test("should ignore ticker checks for withdrawals", () => {
			const result = validateWithdraw(
				testPolicy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"ETH",
			);

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		test("should ignore minimum amount checks for withdrawals", () => {
			const result = validateWithdraw(
				testPolicy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				0.5,
				"USDC",
			);

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		test("should ignore maximum amount checks for withdrawals", () => {
			const result = validateWithdraw(
				testPolicy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				200000,
				"USDC",
			);

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		test("should handle case-insensitive address comparison", () => {
			const result = validateWithdraw(
				testPolicy,
				"BINANCE",
				"ARB",
				"0X9D467FA9062B6E9B1A46E26007AD82DB116C67CB", // Uppercase
				1000,
				"USDC",
			);

			expect(result.valid).toBe(true);
		});

		test("should accept mixed-case whitelist entries in policy objects", () => {
			const mixedCasePolicy: PolicyConfig = {
				...testPolicy,
				withdraw: {
					rule: [
						{
							exchange: "binance",
							network: "arb",
							whitelist: ["0x9D467fA9062B6e9B1A46e26007AD82dB116C67Cb"],
						},
					],
				},
			};
			const result = validateWithdraw(
				mixedCasePolicy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"USDC",
			);

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		test("should reject unauthorised exchange", () => {
			const result = validateWithdraw(
				testPolicy,
				"KRAKEN",
				"SOL",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"USDC",
			);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("exchange KRAKEN");
		});

		test("should prioritise exact match over wildcard rules", () => {
			const wildcardPolicy: PolicyConfig = {
				...testPolicy,
				withdraw: {
					rule: [
						{
							exchange: "*",
							network: "*",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
						},
						{
							exchange: "BINANCE",
							network: "*",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
						},
						{
							exchange: "BINANCE",
							network: "ARB",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
						},
					],
				},
			};
			const result = validateWithdraw(
				wildcardPolicy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				500,
				"USDC",
			);
			expect(result.valid).toBe(true);
		});
	});

	describe("validateOrder", () => {
		test("should validate successful order for exact market rule", () => {
			const result = validateOrder(testPolicy, "USDT", "ETH", 20, "BINANCE");

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		test("should allow wildcard exchange+market rule", () => {
			const wildcardPolicy: PolicyConfig = {
				...testPolicy,
				order: {
					rule: {
						...testPolicy.order.rule,
						markets: ["*"],
						limits: [{ from: "USDT", to: "ETH", min: 1, max: 100_000 }],
					},
				},
			};
			const result = validateOrder(wildcardPolicy, "USDT", "ETH", 20, "KRAKEN");

			expect(result.valid).toBe(true);
		});

		test("should allow wildcard exchange for specific pair", () => {
			const wildcardPolicy: PolicyConfig = {
				...testPolicy,
				order: {
					rule: {
						...testPolicy.order.rule,
						markets: ["*:BTC/ETH"],
						limits: [{ from: "BTC", to: "ETH", min: 0.1, max: 100 }],
					},
				},
			};
			const result = validateOrder(wildcardPolicy, "BTC", "ETH", 1, "KRAKEN");

			expect(result.valid).toBe(true);
		});

		test("should allow wildcard pair for specific exchange", () => {
			const wildcardPolicy: PolicyConfig = {
				...testPolicy,
				order: {
					rule: {
						...testPolicy.order.rule,
						markets: ["BINANCE:*"],
						limits: [{ from: "DOGE", to: "USDT", min: 1, max: 100_000 }],
					},
				},
			};
			const result = validateOrder(
				wildcardPolicy,
				"DOGE",
				"USDT",
				20,
				"BINANCE",
			);

			expect(result.valid).toBe(true);
		});

		test("should reject unauthorised market", () => {
			const result = validateOrder(
				testPolicy,
				"USDT",
				"ETH",
				0.5,
				"kraken", // Not in allowed markets
			);

			expect(result.valid).toBe(false);
			expect(result.error).toMatch(
				/Market KRAKEN.* is not allowed\. Allowed markets: .*/,
			);
		});

		test("should reject unauthorised conversion pair when limits exist", () => {
			const result = validateOrder(
				testPolicy,
				"BTC",
				"ETH", // Not in limits
				0.5,
				"BINANCE",
			);

			expect(result.valid).toBe(false);
			expect(result.error).toContain(
				"Conversion from BTC to ETH is not allowed",
			);
		});

		test("should allow conversion when limits are omitted", () => {
			const noLimitPolicy: PolicyConfig = {
				...testPolicy,
				order: {
					rule: {
						...testPolicy.order.rule,
						limits: undefined,
					},
				},
			};
			const result = validateOrder(
				noLimitPolicy,
				"USDT",
				"ETH",
				200_000,
				"BINANCE",
			);

			expect(result.valid).toBe(true);
		});

		test("should enforce directional limits", () => {
			const directionalPolicy: PolicyConfig = {
				...testPolicy,
				order: {
					rule: {
						markets: ["BINANCE:*"],
						limits: [{ from: "USDT", to: "ETH", min: 1, max: 100_000 }],
					},
				},
			};
			const reverseResult = validateOrder(
				directionalPolicy,
				"ETH",
				"USDT",
				2,
				"BINANCE",
			);

			expect(reverseResult.valid).toBe(false);
			expect(reverseResult.error).toContain(
				"Conversion from ETH to USDT is not allowed",
			);
		});

		test("should reject amount below minimum", () => {
			const result = validateOrder(
				testPolicy,
				"USDT",
				"ETH",
				0.005, // Below minimum of 1
				"BINANCE",
			);

			expect(result.valid).toBe(false);
			expect(result.error).toMatch(/Amount 0.005 is below minimum.*/);
		});

		test("should reject amount above maximum", () => {
			const result = validateOrder(
				testPolicy,
				"USDT",
				"ETH",
				200_000.0, // Above maximum of 100000
				"BINANCE",
			);

			expect(result.valid).toBe(false);
			expect(result.error).toContain("Amount 200000 exceeds maximum 100000");
		});
	});

	describe("resolveOrderExecution", () => {
		function createBrokerMock(symbols: string[]): Exchange {
			const markets = Object.fromEntries(symbols.map((symbol) => [symbol, {}]));
			return {
				markets,
				loadMarkets: async () => markets,
				market: (symbol: string) => {
					if (!(symbol in markets)) {
						throw new Error(`Symbol ${symbol} not supported`);
					}
					return markets[symbol];
				},
			} as unknown as Exchange;
		}

		test("should resolve direct symbol as sell and keep base amount", async () => {
			const broker = createBrokerMock(["ETH/USDT"]);
			const result = await resolveOrderExecution(
				testPolicy,
				broker,
				"BINANCE",
				"ETH",
				"USDT",
				2,
				2500,
			);

			expect(result.valid).toBe(true);
			expect(result.symbol).toBe("ETH/USDT");
			expect(result.side).toBe("sell");
			expect(result.amountBase).toBe(2);
		});

		test("should resolve reverse symbol as buy and divide by price", async () => {
			const broker = createBrokerMock(["ETH/USDT"]);
			const wildcardNoLimitPolicy: PolicyConfig = {
				...testPolicy,
				order: {
					rule: {
						markets: ["BINANCE:*"],
						limits: [],
					},
				},
			};
			const result = await resolveOrderExecution(
				wildcardNoLimitPolicy,
				broker,
				"BINANCE",
				"USDT",
				"ETH",
				2500,
				2500,
			);

			expect(result.valid).toBe(true);
			expect(result.symbol).toBe("ETH/USDT");
			expect(result.side).toBe("buy");
			expect(result.amountBase).toBe(1);
		});

		test("should reject when exchange does not support either symbol direction", async () => {
			const broker = createBrokerMock(["ARB/USDT"]);
			const wildcardPolicy: PolicyConfig = {
				...testPolicy,
				order: {
					rule: {
						markets: ["*"],
						limits: [],
					},
				},
			};
			const result = await resolveOrderExecution(
				wildcardPolicy,
				broker,
				"BINANCE",
				"BTC",
				"ETH",
				1,
				2500,
			);

			expect(result.valid).toBe(false);
			expect(result.error).toContain(
				"Exchange BINANCE does not support BTC/ETH or ETH/BTC",
			);
		});
	});

	describe("validateDeposit", () => {
		test("should always allow deposits when policy is empty", () => {
			const result = validateDeposit(testPolicy, "ARB", 1000);
			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		test("should allow deposits with any amount", () => {
			const result = validateDeposit(testPolicy, "ETH", 0.001);
			expect(result.valid).toBe(true);
		});

		test("should allow deposits on any chain", () => {
			const result = validateDeposit(testPolicy, "POLYGON", 500);
			expect(result.valid).toBe(true);
		});
	});
});
