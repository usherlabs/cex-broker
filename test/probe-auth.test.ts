import { describe, expect, test } from "bun:test";
import CEXBroker from "../src/index";
import type { PolicyConfig } from "../src/types";

const testPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

describe("probeAuth", () => {
	test("should return probe results for a configured account", async () => {
		const broker = new CEXBroker({}, testPolicy);
		const fakeExchange = {
			fetchAccountId: async () => "15210996",
			fetchBalance: async () => ({
				total: {
					USDT: 10,
					BTC: 0,
				},
			}),
		};

		(
			broker as unknown as {
				brokers: Record<string, unknown>;
			}
		).brokers = {
			binance: {
				primary: {
					exchange: fakeExchange,
					label: "primary",
					role: "subaccount",
				},
				secondaryBrokers: [],
			},
		};

		const result = await broker.probeAuth("binance");

		expect(result.exchange).toBe("binance");
		expect(result.resolvedAccount).toBe("primary");
		expect(result.fetchAccountId).toEqual({
			success: true,
			accountId: "15210996",
		});
		expect(result.fetchBalance).toEqual({
			success: true,
			assetCount: 2,
		});
	});

	test("should capture auth failures without stopping after the first error", async () => {
		const broker = new CEXBroker({}, testPolicy);
		const fakeExchange = {
			fetchAccountId: async () => {
				throw new Error("binance {-2015}");
			},
			fetchBalance: async () => {
				throw new Error("binance balance rejected");
			},
		};

		(
			broker as unknown as {
				brokers: Record<string, unknown>;
			}
		).brokers = {
			binance: {
				primary: {
					exchange: fakeExchange,
					label: "primary",
				},
				secondaryBrokers: [],
			},
		};

		const result = await broker.probeAuth("binance");

		expect(result.fetchAccountId.success).toBe(false);
		expect(result.fetchAccountId.error).toContain("-2015");
		expect(result.fetchBalance.success).toBe(false);
		expect(result.fetchBalance.error).toContain("balance rejected");
	});

	test("should reject missing account selectors", () => {
		const broker = new CEXBroker({}, testPolicy);
		(
			broker as unknown as {
				brokers: Record<string, unknown>;
			}
		).brokers = {
			binance: {
				primary: {
					exchange: {},
					label: "primary",
				},
				secondaryBrokers: [],
			},
		};

		expect(() => broker.getBrokerAccount("binance", "secondary:1")).toThrow(
			'Account selector "secondary:1" is not configured for "binance"',
		);
	});
});
