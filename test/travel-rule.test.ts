import { describe, expect, test } from "bun:test";
import type { Exchange } from "@usherlabs/ccxt";
import fs from "fs";
import os from "os";
import path from "path";
import {
	australiaQuestionnaireSchema,
	loadPolicy,
	registerBinanceTravelRuleWithdrawEndpoint,
	resolveTravelRuleDecision,
	withdrawViaLocalEntity,
} from "../src/helpers";
import type { PolicyConfig } from "../src/types";

const SELF_OWNED = { isAddressOwner: 1, sendTo: 1, declaration: true };
const ADDRESS = "0xC8319213172c3a608Fb13f570fC7DF5cdA4F84d1";

function policyWithTravelRule(enabled: boolean): PolicyConfig {
	return {
		withdraw: {
			rule: [
				{ exchange: "BINANCE", network: "ARBITRUM", whitelist: [ADDRESS] },
			],
		},
		deposit: {},
		order: { rule: { markets: ["*"], limits: [] } },
		travelRule: {
			rule: [
				{
					exchange: "BINANCE",
					enabled,
					description: "Australia (AUSTRAC) travel-rule requirement",
					addresses: { [ADDRESS]: { questionnaire: SELF_OWNED } },
				},
			],
		},
	};
}

describe("australiaQuestionnaireSchema", () => {
	test("accepts a self-owned questionnaire", () => {
		expect(
			australiaQuestionnaireSchema.validate(SELF_OWNED).error,
		).toBeUndefined();
	});

	test("rejects a false declaration", () => {
		const { error } = australiaQuestionnaireSchema.validate({
			isAddressOwner: 1,
			sendTo: 1,
			declaration: false,
		});
		expect(error).toBeDefined();
	});

	test("rejects a missing declaration", () => {
		const { error } = australiaQuestionnaireSchema.validate({
			isAddressOwner: 1,
			sendTo: 1,
		});
		expect(error).toBeDefined();
	});

	test("requires bnfType when sending to another beneficiary", () => {
		const { error } = australiaQuestionnaireSchema.validate({
			isAddressOwner: 2,
			sendTo: 1,
			declaration: true,
		});
		expect(error).toBeDefined();
	});

	test("requires individual name fields for bnfType individual", () => {
		const { error } = australiaQuestionnaireSchema.validate({
			isAddressOwner: 2,
			bnfType: 0,
			sendTo: 1,
			declaration: true,
		});
		expect(error).toBeDefined();
	});

	test("accepts a full individual-beneficiary questionnaire", () => {
		const { error } = australiaQuestionnaireSchema.validate({
			isAddressOwner: 2,
			bnfType: 0,
			bnfFirstName: "Jane",
			bnfLastName: "Doe",
			country: "au",
			city: "Sydney",
			sendTo: 1,
			declaration: true,
		});
		expect(error).toBeUndefined();
	});

	test("requires vasp when sending to another VASP", () => {
		const { error } = australiaQuestionnaireSchema.validate({
			isAddressOwner: 1,
			sendTo: 2,
			declaration: true,
		});
		expect(error).toBeDefined();
	});

	test("requires vaspName when vasp is 'others'", () => {
		const { error } = australiaQuestionnaireSchema.validate({
			isAddressOwner: 1,
			sendTo: 2,
			vasp: "others",
			declaration: true,
		});
		expect(error).toBeDefined();
	});

	test("forbids beneficiary fields on a self-owned questionnaire", () => {
		const { error } = australiaQuestionnaireSchema.validate({
			isAddressOwner: 1,
			sendTo: 1,
			declaration: true,
			bnfType: 0,
		});
		expect(error).toBeDefined();
	});
});

describe("resolveTravelRuleDecision", () => {
	test("returns standard when there is no travel-rule section", () => {
		const policy: PolicyConfig = {
			withdraw: { rule: [] },
			deposit: {},
			order: { rule: { markets: [], limits: [] } },
		};
		expect(resolveTravelRuleDecision(policy, "BINANCE", ADDRESS).mode).toBe(
			"standard",
		);
	});

	test("returns standard when the exchange entry is disabled", () => {
		expect(
			resolveTravelRuleDecision(policyWithTravelRule(false), "BINANCE", ADDRESS)
				.mode,
		).toBe("standard");
	});

	test("returns localentity with the questionnaire when enabled (case-insensitive)", () => {
		const decision = resolveTravelRuleDecision(
			policyWithTravelRule(true),
			"binance",
			ADDRESS.toLowerCase(),
		);
		expect(decision).toEqual({
			mode: "localentity",
			questionnaire: SELF_OWNED,
		});
	});

	test("fails closed when enabled but the address has no questionnaire", () => {
		const decision = resolveTravelRuleDecision(
			policyWithTravelRule(true),
			"BINANCE",
			"0x0000000000000000000000000000000000000000",
		);
		expect(decision.mode).toBe("denied");
	});
});

describe("registerBinanceTravelRuleWithdrawEndpoint", () => {
	test("registers the endpoint on a Binance instance", () => {
		const calls: unknown[][] = [];
		const exchange = {
			id: "binance",
			defineRestApi: (...args: unknown[]) => calls.push(args),
		} as unknown as Exchange;
		registerBinanceTravelRuleWithdrawEndpoint(exchange);
		expect(calls).toEqual([
			[{ sapi: { post: { "localentity/withdraw/apply": 4.0002 } } }, "request"],
		]);
	});

	test("is a no-op for non-Binance exchanges", () => {
		const calls: unknown[][] = [];
		const exchange = {
			id: "bybit",
			defineRestApi: (...args: unknown[]) => calls.push(args),
		} as unknown as Exchange;
		registerBinanceTravelRuleWithdrawEndpoint(exchange);
		expect(calls).toEqual([]);
	});
});

describe("withdrawViaLocalEntity", () => {
	function createMockBinance() {
		const captured: { request?: Record<string, unknown> } = {};
		const exchange = {
			options: { networks: { ARBITRUM: "ARBITRUM" } },
			checkAddress: (address: string) => address,
			loadMarkets: async () => undefined,
			currency: (code: string) => ({ id: code, code }),
			currencyToPrecision: (_code: string, amount: number) => String(amount),
			safeDict: (obj: Record<string, unknown>, key: string) => obj?.[key] ?? {},
			safeString: (
				obj: Record<string, unknown>,
				key: string,
				fallback: string,
			) => (typeof obj?.[key] === "string" ? (obj[key] as string) : fallback),
			parseTransaction: (tx: Record<string, unknown>) => ({ parsed: tx }),
			sapiPostLocalentityWithdrawApply: async (
				request: Record<string, unknown>,
			) => {
				captured.request = request;
				return { id: "withdrawal-123" };
			},
		} as unknown as Exchange;
		return { exchange, captured };
	}

	test("calls the localentity endpoint with a URL-serializable questionnaire", async () => {
		const { exchange, captured } = createMockBinance();
		const result = await withdrawViaLocalEntity(exchange, {
			code: "USDC",
			amount: 100,
			address: ADDRESS,
			network: "ARBITRUM",
			questionnaire: SELF_OWNED,
		});

		expect(captured.request).toEqual({
			coin: "USDC",
			address: ADDRESS,
			amount: "100",
			network: "ARBITRUM",
			questionnaire: JSON.stringify(SELF_OWNED),
		});
		expect(result).toEqual({ parsed: { id: "withdrawal-123" } });
	});

	test("throws when the endpoint is not registered", async () => {
		const exchange = {
			checkAddress: (address: string) => address,
			loadMarkets: async () => undefined,
			currency: (code: string) => ({ id: code }),
		} as unknown as Exchange;
		await expect(
			withdrawViaLocalEntity(exchange, {
				code: "USDC",
				amount: 100,
				address: ADDRESS,
				network: "ARBITRUM",
				questionnaire: SELF_OWNED,
			}),
		).rejects.toThrow("binance_localentity_withdraw_unavailable");
	});
});

describe("loadPolicy travel-rule validation", () => {
	function writeTempPolicy(policy: unknown): string {
		const tempPath = path.join(
			os.tmpdir(),
			`policy-travel-${Date.now()}-${Math.random()}.json`,
		);
		fs.writeFileSync(tempPath, JSON.stringify(policy));
		return tempPath;
	}

	test("loads a policy with a valid travel-rule section", () => {
		const tempPath = writeTempPolicy(policyWithTravelRule(true));
		try {
			const policy = loadPolicy(tempPath);
			expect(policy.travelRule?.rule[0]?.enabled).toBe(true);
			expect(policy.travelRule?.rule[0]?.description).toBe(
				"Australia (AUSTRAC) travel-rule requirement",
			);
			expect(
				policy.travelRule?.rule[0]?.addresses[ADDRESS]?.questionnaire,
			).toEqual(SELF_OWNED);
		} finally {
			fs.unlinkSync(tempPath);
		}
	});

	test("rejects a policy whose questionnaire is malformed", () => {
		const bad = policyWithTravelRule(true);
		// biome-ignore lint/suspicious/noExplicitAny: intentionally invalid config
		(bad.travelRule as any).rule[0].addresses[ADDRESS].questionnaire = {
			isAddressOwner: 1,
			sendTo: 1,
			declaration: false,
		};
		const tempPath = writeTempPolicy(bad);
		try {
			expect(() => loadPolicy(tempPath)).toThrow();
		} finally {
			fs.unlinkSync(tempPath);
		}
	});
});
