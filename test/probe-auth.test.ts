import { describe, expect, test } from "bun:test";
import {
	getProbeCredentialsFromEnv,
	runProbeAuth,
} from "../src/commands/probe-auth";
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
		expect(result.mode).toBe("configured");
		expect(result.selector).toBe("primary");
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

	test("should return probe results for raw credentials", async () => {
		const broker = new CEXBroker({}, testPolicy);
		const fakeExchange = {
			fetchAccountId: async () => "1218874794",
			fetchBalance: async () => ({
				total: {
					USDT: 1,
				},
			}),
		};

		(
			broker as unknown as {
				probeAuthWithCredentials: unknown;
			}
		).probeAuthWithCredentials = async (
			exchange: string,
			creds: { apiKey: string; apiSecret: string },
		) => {
			expect(exchange).toBe("binance");
			expect(creds).toEqual({
				apiKey: "probe_key",
				apiSecret: "probe_secret",
			});
			return (
				broker as unknown as {
					runProbeAuthSteps: unknown;
				}
			).runProbeAuthSteps("binance", fakeExchange, {
				mode: "raw",
			});
		};

		const result = await runProbeAuth(broker, "binance", "secondary:1", {
			CEX_BROKER_PROBE_API_KEY: "probe_key",
			CEX_BROKER_PROBE_API_SECRET: "probe_secret",
		});

		expect(result.mode).toBe("raw");
		expect(result.selector).toBeUndefined();
		expect(result.resolvedAccount).toBeUndefined();
		expect(result.fetchAccountId.success).toBe(true);
		expect(result.fetchBalance.assetCount).toBe(1);
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

	test("should parse probe credentials from env", () => {
		const result = getProbeCredentialsFromEnv({
			CEX_BROKER_PROBE_API_KEY: "probe_key",
			CEX_BROKER_PROBE_API_SECRET: "probe_secret",
		});

		expect(result).toEqual({
			apiKey: "probe_key",
			apiSecret: "probe_secret",
		});
	});

	test("should ignore probe mode when env vars are absent", () => {
		expect(getProbeCredentialsFromEnv({})).toBeNull();
	});

	test("should reject partial probe env configuration", () => {
		expect(() =>
			getProbeCredentialsFromEnv({
				CEX_BROKER_PROBE_API_KEY: "probe_key",
			}),
		).toThrow(
			"CEX_BROKER_PROBE_API_KEY and CEX_BROKER_PROBE_API_SECRET must both be set for raw probe mode",
		);
	});
});
