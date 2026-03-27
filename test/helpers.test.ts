import { beforeEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import fs from "fs";
import os from "os";
import path from "path";
import {
	type BrokerPoolEntry,
	createBrokerPool,
	executeWithdrawWithRouting,
	getCurrentBrokerSelector,
	loadPolicy,
	resolveBrokerAccount,
	resolveOrderExecution,
	validateDeposit,
	validateOrder,
	validateWithdraw,
	WithdrawRoutingError,
	WithdrawRoutingUnavailableError,
} from "../src/helpers/index";
import { WithdrawPayloadSchema } from "../src/schemas/action-payloads";
import type { PolicyConfig } from "../src/types";

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

		test("should allow any ticker when rule has no coins field (backward compat)", () => {
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

		test("should allow withdrawal when ticker is in coins list", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				withdraw: {
					rule: [
						{
							exchange: "BINANCE",
							network: "ARB",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
							coins: ["ETH", "USDT"],
						},
					],
				},
			};
			const result = validateWithdraw(
				policy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"ETH",
			);
			expect(result.valid).toBe(true);
		});

		test("should reject withdrawal when ticker is not in coins list", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				withdraw: {
					rule: [
						{
							exchange: "BINANCE",
							network: "ARB",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
							coins: ["ETH", "USDT"],
						},
					],
				},
			};
			const result = validateWithdraw(
				policy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"ARB",
			);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("Token ARB is not allowed");
			expect(result.error).toContain("ETH");
			expect(result.error).toContain("USDT");
		});

		test("should allow any ticker when coins is wildcard ['*']", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				withdraw: {
					rule: [
						{
							exchange: "BINANCE",
							network: "ARB",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
							coins: ["*"],
						},
					],
				},
			};
			const result = validateWithdraw(
				policy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"ANYTHING",
			);
			expect(result.valid).toBe(true);
		});

		test("should allow any ticker when coins is empty array (same as omitted)", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				withdraw: {
					rule: [
						{
							exchange: "BINANCE",
							network: "ARB",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
							coins: [],
						},
					],
				},
			};
			const result = validateWithdraw(
				policy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"ANYTHING",
			);
			expect(result.valid).toBe(true);
		});

		test("should match coins case-insensitively", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				withdraw: {
					rule: [
						{
							exchange: "BINANCE",
							network: "ARB",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
							coins: ["eth"],
						},
					],
				},
			};
			// normalizePolicyConfig uppercases coins, so "eth" -> "ETH"
			const result = validateWithdraw(
				policy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"ETH",
			);
			expect(result.valid).toBe(true);
		});

		test("highest-priority rule wins absolutely — no fallthrough to lower-priority on coin mismatch", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				withdraw: {
					rule: [
						{
							exchange: "BINANCE",
							network: "ARB",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
							coins: ["ETH"],
						},
						{
							exchange: "*",
							network: "ARB",
							whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
							coins: ["USDT"],
						},
					],
				},
			};
			// BINANCE/ARB exact match (priority 4) wins over */ARB (priority 2).
			// The winning rule only allows ETH, so USDT must be rejected.
			const result = validateWithdraw(
				policy,
				"BINANCE",
				"ARB",
				"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
				1000,
				"USDT",
			);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("Token USDT is not allowed");
			expect(result.error).toContain("ETH");
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
		test("should allow deposit when coin is in allowed list", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				deposit: {
					rule: [
						{
							exchange: "BINANCE",
							network: "ARBITRUM",
							coins: ["ETH", "USDT"],
						},
					],
				},
			};
			const result = validateDeposit(policy, "BINANCE", "ARBITRUM", "ETH");
			expect(result.valid).toBe(true);
		});

		test("should reject deposit when coin is not in allowed list", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				deposit: {
					rule: [
						{
							exchange: "BINANCE",
							network: "ARBITRUM",
							coins: ["ETH", "USDT"],
						},
					],
				},
			};
			const result = validateDeposit(policy, "BINANCE", "ARBITRUM", "ARB");
			expect(result.valid).toBe(false);
			expect(result.error).toContain("Token ARB not allowed");
			expect(result.error).toContain("ETH");
			expect(result.error).toContain("USDT");
		});

		test("should allow any coin when coins field is absent", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				deposit: {
					rule: [{ exchange: "BINANCE", network: "ARBITRUM" }],
				},
			};
			const result = validateDeposit(policy, "BINANCE", "ARBITRUM", "DOGE");
			expect(result.valid).toBe(true);
		});

		test("should allow any coin when coins is wildcard ['*']", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				deposit: {
					rule: [{ exchange: "BINANCE", network: "ARBITRUM", coins: ["*"] }],
				},
			};
			const result = validateDeposit(policy, "BINANCE", "ARBITRUM", "ANYTHING");
			expect(result.valid).toBe(true);
		});

		test("should allow all deposits when deposit has no rule key", () => {
			const policy: PolicyConfig = { ...testPolicy, deposit: {} };
			const result = validateDeposit(policy, "BINANCE", "ARBITRUM", "ETH");
			expect(result.valid).toBe(true);
		});

		test("should allow all deposits when deposit has empty rule array", () => {
			const policy: PolicyConfig = { ...testPolicy, deposit: { rule: [] } };
			const result = validateDeposit(policy, "BINANCE", "ARBITRUM", "ETH");
			expect(result.valid).toBe(true);
		});

		test("should match exchange/network and allow any coin when rule has no coins", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				deposit: {
					rule: [{ exchange: "BINANCE", network: "ARBITRUM" }],
				},
			};
			const result = validateDeposit(policy, "BINANCE", "ARBITRUM", "ETH");
			expect(result.valid).toBe(true);
		});

		test("should reject wrong exchange/network when rules are present", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				deposit: {
					rule: [{ exchange: "BINANCE", network: "ARBITRUM" }],
				},
			};
			const result = validateDeposit(policy, "BYBIT", "OPTIMISM", "ETH");
			expect(result.valid).toBe(false);
			expect(result.error).toContain("Deposits not allowed for BYBIT:OPTIMISM");
		});

		test("highest-priority rule wins with no fallthrough on coin mismatch", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				deposit: {
					rule: [
						{ exchange: "BINANCE", network: "ARBITRUM", coins: ["ETH"] },
						{ exchange: "*", network: "ARBITRUM", coins: ["USDT"] },
					],
				},
			};
			// BINANCE/ARBITRUM matches rule1 (priority 4) which only allows ETH
			const result = validateDeposit(policy, "BINANCE", "ARBITRUM", "USDT");
			expect(result.valid).toBe(false);
			expect(result.error).toContain("Token USDT not allowed");
		});

		test("should be case-insensitive for exchange, network, and coin", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				deposit: {
					rule: [{ exchange: "binance", network: "arbitrum", coins: ["eth"] }],
				},
			};
			const result = validateDeposit(policy, "Binance", "Arbitrum", "Eth");
			expect(result.valid).toBe(true);
		});

		test("should allow all coins when coins is empty array", () => {
			const policy: PolicyConfig = {
				...testPolicy,
				deposit: {
					rule: [{ exchange: "BINANCE", network: "ARBITRUM", coins: [] }],
				},
			};
			const result = validateDeposit(policy, "BINANCE", "ARBITRUM", "ANYTHING");
			expect(result.valid).toBe(true);
		});
	});

	describe("withdraw routing", () => {
		function createMockExchange() {
			const state = {
				withdrawCalls: [] as unknown[],
				transferCalls: [] as unknown[],
			};
			const exchange = {
				loadMarkets: async () => undefined,
				currency: (code: string) => ({ id: code }),
				currencyToPrecision: (_code: string, amount: number) => String(amount),
				withdraw: async (...args: unknown[]) => {
					state.withdrawCalls.push(args);
					return { id: "withdraw-1" };
				},
				sapiPostSubAccountTransferSubToMaster: async (
					params: Record<string, unknown>,
				) => {
					state.transferCalls.push(params);
					return { txnId: "transfer-1" };
				},
			} as unknown as Exchange & {
				sapiPostSubAccountTransferSubToMaster: (
					params: Record<string, unknown>,
				) => Promise<unknown>;
			};
			return { exchange, state };
		}

		function createMetadata(useSecondaryKey?: string) {
			const metadata = new grpc.Metadata();
			if (useSecondaryKey) {
				metadata.set("use-secondary-key", useSecondaryKey);
			}
			return metadata;
		}

		test("should parse routed withdraw payload fields", () => {
			const payload = WithdrawPayloadSchema.parse({
				recipientAddress: "0xabc",
				amount: "1.25",
				chain: "ARB",
				routeViaMaster: "true",
				sourceAccount: "secondary:1",
				masterAccount: "primary",
			});

			expect(payload.routeViaMaster).toBe(true);
			expect(payload.amount).toBe(1.25);
			expect(payload.sourceAccount).toBe("secondary:1");
			expect(payload.masterAccount).toBe("primary");
		});

		test("should resolve broker selectors from metadata", () => {
			const primaryMetadata = createMetadata();
			const secondaryMetadata = createMetadata("2");

			expect(getCurrentBrokerSelector(primaryMetadata)).toBe("primary");
			expect(getCurrentBrokerSelector(secondaryMetadata)).toBe("secondary:2");
		});

		test("should resolve broker accounts by selector", () => {
			const { exchange: primary } = createMockExchange();
			const { exchange: secondaryOne } = createMockExchange();
			const { exchange: secondaryTwo } = createMockExchange();
			const pool: BrokerPoolEntry = {
				primary: { exchange: primary, label: "primary" },
				secondaryBrokers: [
					{ exchange: secondaryOne, label: "secondary:1", index: 1 },
					{ exchange: secondaryTwo, label: "secondary:2", index: 2 },
				],
			};

			expect(resolveBrokerAccount(pool, "primary")?.label).toBe("primary");
			expect(resolveBrokerAccount(pool, "secondary:2")?.label).toBe(
				"secondary:2",
			);
			expect(resolveBrokerAccount(pool, "secondary:3")).toBeNull();
		});

		test("should preserve sparse secondary indices and metadata from env-style config", () => {
			const pool = createBrokerPool({
				binance: {
					apiKey: "primary-key",
					apiSecret: "primary-secret",
					_secondaryMap: {
						2: {
							apiKey: "secondary-key-2",
							apiSecret: "secondary-secret-2",
							role: "subaccount",
							email: "sub2@example.com",
						},
					},
				},
			});

			expect(resolveBrokerAccount(pool.binance, "secondary:1")).toBeNull();
			expect(resolveBrokerAccount(pool.binance, "secondary:2")).toMatchObject({
				label: "secondary:2",
				index: 2,
				role: "subaccount",
				email: "sub2@example.com",
			});
		});

		test("should route binance withdraws through master account", async () => {
			const { exchange: primary, state: primaryState } = createMockExchange();
			const { exchange: secondary, state: secondaryState } =
				createMockExchange();
			const pool: BrokerPoolEntry = {
				primary: { exchange: primary, label: "primary", role: "master" },
				secondaryBrokers: [
					{
						exchange: secondary,
						label: "secondary:1",
						index: 1,
						role: "subaccount",
					},
				],
			};

			await executeWithdrawWithRouting({
				cex: "binance",
				brokers: pool,
				metadata: createMetadata("1"),
				selectedBroker: secondary,
				code: "USDT",
				amount: 2,
				recipientAddress: "0xabc",
				network: "ARB",
				routeViaMaster: true,
				sourceAccount: "current",
				masterAccount: "primary",
			});

			expect(secondaryState.transferCalls).toHaveLength(1);
			expect(primaryState.withdrawCalls).toHaveLength(1);
			expect(secondaryState.transferCalls[0]).toMatchObject({
				asset: "USDT",
				amount: "2",
			});
		});

		test("should skip transfer when source and master are the same", async () => {
			const { exchange: primary, state } = createMockExchange();
			const pool: BrokerPoolEntry = {
				primary: { exchange: primary, label: "primary" },
				secondaryBrokers: [],
			};

			await executeWithdrawWithRouting({
				cex: "binance",
				brokers: pool,
				metadata: createMetadata(),
				selectedBroker: primary,
				code: "USDT",
				amount: 1,
				recipientAddress: "0xabc",
				network: "ARB",
				routeViaMaster: true,
				sourceAccount: "primary",
				masterAccount: "primary",
			});

			expect(state.transferCalls).toHaveLength(0);
			expect(state.withdrawCalls).toHaveLength(1);
		});

		test("should report unavailable routing for unsupported exchanges", async () => {
			const { exchange: primary } = createMockExchange();
			const { exchange: secondary } = createMockExchange();
			const pool: BrokerPoolEntry = {
				primary: { exchange: primary, label: "primary" },
				secondaryBrokers: [
					{ exchange: secondary, label: "secondary:1", index: 1 },
				],
			};

			await expect(
				executeWithdrawWithRouting({
					cex: "bybit",
					brokers: pool,
					metadata: createMetadata("1"),
					selectedBroker: secondary,
					code: "USDT",
					amount: 2,
					recipientAddress: "0xabc",
					network: "ARB",
					routeViaMaster: true,
				}),
			).rejects.toBeInstanceOf(WithdrawRoutingUnavailableError);
		});

		test("should reject a non-master target account for routed withdraws", async () => {
			const { exchange: primary } = createMockExchange();
			const { exchange: secondary } = createMockExchange();
			const pool: BrokerPoolEntry = {
				primary: { exchange: primary, label: "primary", role: "master" },
				secondaryBrokers: [
					{
						exchange: secondary,
						label: "secondary:1",
						index: 1,
						role: "subaccount",
					},
				],
			};

			await expect(
				executeWithdrawWithRouting({
					cex: "binance",
					brokers: pool,
					metadata: createMetadata("1"),
					selectedBroker: secondary,
					code: "USDT",
					amount: 2,
					recipientAddress: "0xabc",
					network: "ARB",
					routeViaMaster: true,
					sourceAccount: "secondary:1",
					masterAccount: "secondary:1",
				}),
			).rejects.toThrow(
				"Master account secondary:1 must resolve to the primary/master account",
			);
		});

		test("should reject a non-subaccount source for routed withdraws", async () => {
			const { exchange: primary } = createMockExchange();
			const { exchange: secondary } = createMockExchange();
			const pool: BrokerPoolEntry = {
				primary: { exchange: primary, label: "primary", role: "master" },
				secondaryBrokers: [
					{
						exchange: secondary,
						label: "secondary:1",
						index: 1,
						role: "master",
					},
				],
			};

			await expect(
				executeWithdrawWithRouting({
					cex: "binance",
					brokers: pool,
					metadata: createMetadata(),
					selectedBroker: primary,
					code: "USDT",
					amount: 2,
					recipientAddress: "0xabc",
					network: "ARB",
					routeViaMaster: true,
					sourceAccount: "primary",
					masterAccount: "secondary:1",
				}),
			).rejects.toThrow(
				"Source account primary must resolve to a subaccount when routeViaMaster is enabled",
			);
		});

		test("should reject invalid account selectors", async () => {
			const { exchange: primary } = createMockExchange();
			const pool: BrokerPoolEntry = {
				primary: { exchange: primary, label: "primary" },
				secondaryBrokers: [],
			};

			await expect(
				executeWithdrawWithRouting({
					cex: "binance",
					brokers: pool,
					metadata: createMetadata(),
					selectedBroker: primary,
					code: "USDT",
					amount: 2,
					recipientAddress: "0xabc",
					network: "ARB",
					routeViaMaster: true,
					sourceAccount: "secondary:bad",
				}),
			).rejects.toBeInstanceOf(WithdrawRoutingError);
		});
	});
});
