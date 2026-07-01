import { afterEach, describe, expect, test } from "bun:test";
import ccxt, { type Exchange } from "@usherlabs/ccxt";
import fs from "fs";
import os from "os";
import path from "path";
import {
	australiaDepositQuestionnaireSchema,
	getEnabledTravelRuleDepositConfig,
	loadPolicy,
	registerBinanceTravelRuleDepositEndpoints,
	resolveDepositOriginatorQuestionnaire,
} from "../src/helpers";
import {
	createAccountState,
	loadTravelRuleDepositReconcilerConfigFromEnv,
	parseLocalEntityDeposit,
	type ReconcileAccountDeps,
	reconcileAccountOnce,
	resolveOnChainSender,
} from "../src/helpers/travel-rule-deposit-reconciler";
import type { PolicyConfig, TravelRuleDepositConfig } from "../src/types";

const SELF_OWNED_DEPOSIT = {
	depositOriginator: 1,
	receiveFrom: 1,
	declaration: true,
};
// Mixed-case in policy to exercise case-insensitive originator matching.
const ORIGINATOR = "0xE64B2f840b54C906e8dA26E96DBC9904b3B7f95a";
const ORIGINATOR_LOWER = ORIGINATOR.toLowerCase();
const WITHDRAW_DEST = "0xC8319213172c3a608Fb13f570fC7DF5cdA4F84d1";

function policyWithDeposit(
	depositsEnabled: boolean,
	withDeposits = true,
): PolicyConfig {
	return {
		withdraw: {
			rule: [
				{
					exchange: "BINANCE",
					network: "ARBITRUM",
					whitelist: [WITHDRAW_DEST],
				},
			],
		},
		deposit: {},
		order: { rule: { markets: ["*"], limits: [] } },
		travelRule: {
			rule: [
				{
					exchange: "BINANCE",
					enabled: true,
					addresses: {
						[WITHDRAW_DEST]: {
							questionnaire: {
								isAddressOwner: 1,
								sendTo: 1,
								declaration: true,
							},
						},
					},
					...(withDeposits && {
						deposits: {
							enabled: depositsEnabled,
							originators: {
								[ORIGINATOR]: { questionnaire: SELF_OWNED_DEPOSIT },
							},
						},
					}),
				},
			],
		},
	};
}

describe("australiaDepositQuestionnaireSchema", () => {
	test("accepts the self-owned deposit questionnaire", () => {
		expect(
			australiaDepositQuestionnaireSchema.validate(SELF_OWNED_DEPOSIT).error,
		).toBeUndefined();
	});

	test("rejects a false declaration", () => {
		const { error } = australiaDepositQuestionnaireSchema.validate({
			depositOriginator: 1,
			receiveFrom: 1,
			declaration: false,
		});
		expect(error).toBeDefined();
	});

	test("rejects a missing declaration", () => {
		const { error } = australiaDepositQuestionnaireSchema.validate({
			depositOriginator: 1,
			receiveFrom: 1,
		});
		expect(error).toBeDefined();
	});

	test("rejects a non-self depositOriginator (needs identity fields we lack)", () => {
		const { error } = australiaDepositQuestionnaireSchema.validate({
			depositOriginator: 2,
			receiveFrom: 1,
			declaration: true,
		});
		expect(error).toBeDefined();
	});

	test("rejects the withdraw questionnaire shape (isAddressOwner/sendTo)", () => {
		const { error } = australiaDepositQuestionnaireSchema.validate({
			isAddressOwner: 1,
			sendTo: 1,
			declaration: true,
		});
		expect(error).toBeDefined();
	});
});

describe("getEnabledTravelRuleDepositConfig", () => {
	test("returns null when there is no travel-rule section", () => {
		const policy: PolicyConfig = {
			withdraw: { rule: [] },
			deposit: {},
			order: { rule: { markets: [], limits: [] } },
		};
		expect(getEnabledTravelRuleDepositConfig(policy, "BINANCE")).toBeNull();
	});

	test("returns null when the deposits block is absent", () => {
		expect(
			getEnabledTravelRuleDepositConfig(
				policyWithDeposit(true, false),
				"BINANCE",
			),
		).toBeNull();
	});

	test("returns null when deposits are disabled", () => {
		expect(
			getEnabledTravelRuleDepositConfig(policyWithDeposit(false), "BINANCE"),
		).toBeNull();
	});

	test("returns the config when enabled (case-insensitive exchange)", () => {
		const config = getEnabledTravelRuleDepositConfig(
			policyWithDeposit(true),
			"binance",
		);
		expect(config?.enabled).toBe(true);
		expect(config?.originators[ORIGINATOR]).toBeDefined();
	});
});

describe("resolveDepositOriginatorQuestionnaire", () => {
	const config: TravelRuleDepositConfig = {
		enabled: true,
		originators: { [ORIGINATOR]: { questionnaire: SELF_OWNED_DEPOSIT } },
	};

	test("matches a declared originator case-insensitively", () => {
		expect(
			resolveDepositOriginatorQuestionnaire(config, ORIGINATOR_LOWER),
		).toEqual(SELF_OWNED_DEPOSIT);
	});

	test("returns null for an undeclared sender", () => {
		expect(
			resolveDepositOriginatorQuestionnaire(
				config,
				"0x0000000000000000000000000000000000000000",
			),
		).toBeNull();
	});
});

describe("registerBinanceTravelRuleDepositEndpoints", () => {
	test("registers the three localentity endpoints on Binance", () => {
		const calls: unknown[][] = [];
		const exchange = {
			id: "binance",
			defineRestApi: (...args: unknown[]) => calls.push(args),
		} as unknown as Exchange;
		registerBinanceTravelRuleDepositEndpoints(exchange);
		expect(calls).toEqual([
			[
				{
					sapi: {
						get: {
							"localentity/deposit/history": 1,
							"localentity/questionnaire-requirements": 1,
						},
						put: { "localentity/deposit/provide-info": 1 },
					},
				},
				"request",
			],
		]);
	});

	test("is a no-op for non-Binance exchanges", () => {
		const calls: unknown[][] = [];
		const exchange = {
			id: "bybit",
			defineRestApi: (...args: unknown[]) => calls.push(args),
		} as unknown as Exchange;
		registerBinanceTravelRuleDepositEndpoints(exchange);
		expect(calls).toEqual([]);
	});
});

describe("loadPolicy deposit travel-rule validation", () => {
	function writeTempPolicy(policy: unknown): string {
		const tempPath = path.join(
			os.tmpdir(),
			`policy-deposit-${Date.now()}-${Math.random()}.json`,
		);
		fs.writeFileSync(tempPath, JSON.stringify(policy));
		return tempPath;
	}

	test("loads a policy with a valid deposits block", () => {
		const tempPath = writeTempPolicy(policyWithDeposit(true));
		try {
			const policy = loadPolicy(tempPath);
			const deposits = policy.travelRule?.rule[0]?.deposits;
			expect(deposits?.enabled).toBe(true);
			expect(deposits?.originators[ORIGINATOR]?.questionnaire).toEqual(
				SELF_OWNED_DEPOSIT,
			);
		} finally {
			fs.unlinkSync(tempPath);
		}
	});

	test("rejects a deposits block whose questionnaire is the withdraw shape", () => {
		const bad = policyWithDeposit(true);
		// biome-ignore lint/suspicious/noExplicitAny: intentionally invalid config
		(bad.travelRule as any).rule[0].deposits.originators[
			ORIGINATOR
		].questionnaire = { isAddressOwner: 1, sendTo: 1, declaration: true };
		const tempPath = writeTempPolicy(bad);
		try {
			expect(() => loadPolicy(tempPath)).toThrow();
		} finally {
			fs.unlinkSync(tempPath);
		}
	});
});

describe("binance localentity deposit provide-info signing (ccxt patch)", () => {
	// Guards the @usherlabs/ccxt patch: provide-info must sign the questionnaire
	// with rawencode (raw JSON). urlencode percent-encodes the JSON and Binance
	// rejects it with -1022. This uses the real ccxt so it fails if the patch is
	// ever dropped on a version bump (edge case 11).
	test("signs the questionnaire raw, not percent-encoded, on the PUT", () => {
		const exchange = new ccxt.binance({ apiKey: "k", secret: "s" });
		const params = {
			tranId: "387083631169",
			questionnaire: JSON.stringify(SELF_OWNED_DEPOSIT),
		};
		const signed = exchange.sign(
			"localentity/deposit/provide-info",
			"sapi",
			"PUT",
			params,
		);
		const body = String(signed.body ?? "");
		expect(body).toContain('questionnaire={"depositOriginator":1');
		expect(body).not.toContain("questionnaire=%7B");
	});
});

describe("parseLocalEntityDeposit", () => {
	test("parses a frozen deposit row", () => {
		const parsed = parseLocalEntityDeposit({
			tranId: 387083631169,
			coin: "USDC",
			amount: "1",
			network: "ARBITRUM",
			txId: `0x${"a".repeat(64)}`,
			travelRuleStatusV2: "PENDING",
			requireQuestionnaire: true,
		});
		expect(parsed).toMatchObject({
			tranId: "387083631169",
			coin: "USDC",
			network: "ARBITRUM",
			travelRuleStatus: "PENDING",
			requireQuestionnaire: true,
		});
	});

	test("returns null when the row has no tranId (wrong id space)", () => {
		expect(parseLocalEntityDeposit({ coin: "USDC", amount: "1" })).toBeNull();
	});
});

describe("resolveOnChainSender", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const HASH = `0x${"b".repeat(64)}`;

	test("returns the lowercased tx.from", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({ result: { from: ORIGINATOR } }),
			)) as typeof fetch;
		expect(await resolveOnChainSender("http://rpc", HASH)).toBe(
			ORIGINATOR_LOWER,
		);
	});

	test("returns null when the tx is not found (result null)", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ result: null }))) as typeof fetch;
		expect(await resolveOnChainSender("http://rpc", HASH)).toBeNull();
	});

	test("returns null (no RPC call) for a malformed tx hash", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}");
		}) as typeof fetch;
		expect(await resolveOnChainSender("http://rpc", "not-a-hash")).toBeNull();
		expect(called).toBe(false);
	});
});

describe("loadTravelRuleDepositReconcilerConfigFromEnv", () => {
	test("parses per-network RPC URLs and applies defaults", () => {
		const config = loadTravelRuleDepositReconcilerConfigFromEnv({
			TRAVEL_RULE_RPC_URL_ARBITRUM: "http://arb-rpc",
			OTHER: "ignored",
		});
		expect(config.rpcUrlsByNetwork).toEqual({ ARBITRUM: "http://arb-rpc" });
		expect(config.expectedQuestionnaireCountry).toBe("AU");
		expect(config.pollIntervalActiveMs).toBe(60_000);
	});

	test("honors cadence and country overrides", () => {
		const config = loadTravelRuleDepositReconcilerConfigFromEnv({
			TRAVEL_RULE_DEPOSIT_POLL_ACTIVE_SECS: "30",
			TRAVEL_RULE_QUESTIONNAIRE_COUNTRY: "au",
		});
		expect(config.pollIntervalActiveMs).toBe(30_000);
		expect(config.expectedQuestionnaireCountry).toBe("AU");
	});
});

// ---------------------------------------------------------------------------
// reconcileAccountOnce — the compliance-critical core
// ---------------------------------------------------------------------------

const FROZEN_DEPOSIT = {
	tranId: "387083631169",
	coin: "USDC",
	amount: "1",
	network: "ARBITRUM",
	txId: `0x${"a".repeat(64)}`,
	travelRuleStatusV2: "PENDING",
	requireQuestionnaire: true,
};

function baseDeps(
	overrides: Partial<ReconcileAccountDeps> = {},
): ReconcileAccountDeps {
	return {
		accountLabel: "binance:secondary:1",
		depositConfig: {
			enabled: true,
			originators: { [ORIGINATOR]: { questionnaire: SELF_OWNED_DEPOSIT } },
		},
		expectedCountry: "AU",
		failureBackoffMs: 900_000,
		rateLimitCooldownMs: 300_000,
		now: 1_000_000,
		state: createAccountState(),
		fetchDepositHistory: async () => [{ ...FROZEN_DEPOSIT }],
		fetchQuestionnaireCountry: async () => "AU",
		resolveSender: async () => ORIGINATOR_LOWER,
		submitProvideInfo: async () => ({ accepted: true }),
		resolveQuestionnaire: resolveDepositOriginatorQuestionnaire,
		...overrides,
	};
}

describe("reconcileAccountOnce", () => {
	test("submits provide-info for a declared-originator frozen deposit", async () => {
		let submitCalls = 0;
		const deps = baseDeps({
			submitProvideInfo: async () => {
				submitCalls++;
				return { accepted: true };
			},
		});
		const report = await reconcileAccountOnce(deps);
		expect(submitCalls).toBe(1);
		expect(report.outcomes.map((o) => o.kind)).toEqual(["submitted"]);
		expect(deps.state.submittedTranIds.has(FROZEN_DEPOSIT.tranId)).toBe(true);
	});

	test("does not re-submit an already-submitted deposit on the next cycle", async () => {
		let submitCalls = 0;
		const deps = baseDeps({
			submitProvideInfo: async () => {
				submitCalls++;
				return { accepted: true };
			},
		});
		await reconcileAccountOnce(deps);
		const second = await reconcileAccountOnce(deps);
		expect(submitCalls).toBe(1);
		expect(second.hadActionableWork).toBe(false);
		// Still counted as frozen until Binance releases it asynchronously.
		expect(second.frozenDeposits).toHaveLength(1);
	});

	test("NEVER submits when the origin is undeclared", async () => {
		let submitCalls = 0;
		const deps = baseDeps({
			resolveSender: async () => "0x000000000000000000000000000000000000dead",
			submitProvideInfo: async () => {
				submitCalls++;
				return { accepted: true };
			},
		});
		const report = await reconcileAccountOnce(deps);
		expect(submitCalls).toBe(0);
		expect(report.outcomes.map((o) => o.kind)).toEqual(["undeclared-origin"]);
		expect(deps.state.backoffUntil.has(FROZEN_DEPOSIT.tranId)).toBe(true);
	});

	test("NEVER submits when the on-chain sender is unresolved", async () => {
		let submitCalls = 0;
		const deps = baseDeps({
			resolveSender: async () => null,
			submitProvideInfo: async () => {
				submitCalls++;
				return { accepted: true };
			},
		});
		const report = await reconcileAccountOnce(deps);
		expect(submitCalls).toBe(0);
		expect(report.outcomes.map((o) => o.kind)).toEqual(["unproven-origin"]);
	});

	test("NEVER submits when the entity country is not the expected one", async () => {
		let submitCalls = 0;
		const deps = baseDeps({
			fetchQuestionnaireCountry: async () => "DE",
			submitProvideInfo: async () => {
				submitCalls++;
				return { accepted: true };
			},
		});
		const report = await reconcileAccountOnce(deps);
		expect(submitCalls).toBe(0);
		expect(report.outcomes.map((o) => o.kind)).toEqual(["entity-drift"]);
	});

	test("treats an 'already provided' error as idempotent success", async () => {
		const deps = baseDeps({
			submitProvideInfo: async () => {
				throw new Error("Questionnaire already provided for this deposit");
			},
		});
		const report = await reconcileAccountOnce(deps);
		expect(report.outcomes.map((o) => o.kind)).toEqual(["already-provided"]);
		expect(deps.state.submittedTranIds.has(FROZEN_DEPOSIT.tranId)).toBe(true);
	});

	test("backs off (does not mark submitted) on a content rejection", async () => {
		const deps = baseDeps({
			submitProvideInfo: async () => ({
				accepted: false,
				msg: "Questionnaire format not valid",
			}),
		});
		const report = await reconcileAccountOnce(deps);
		expect(report.outcomes.map((o) => o.kind)).toEqual(["submit-error"]);
		expect(deps.state.submittedTranIds.has(FROZEN_DEPOSIT.tranId)).toBe(false);
		expect(deps.state.backoffUntil.get(FROZEN_DEPOSIT.tranId)).toBe(
			deps.now + deps.failureBackoffMs,
		);
	});

	test("surfaces a FAILED deposit as terminal and never submits it", async () => {
		let submitCalls = 0;
		const deps = baseDeps({
			fetchDepositHistory: async () => [
				{ ...FROZEN_DEPOSIT, travelRuleStatusV2: "FAILED" },
			],
			submitProvideInfo: async () => {
				submitCalls++;
				return { accepted: true };
			},
		});
		const report = await reconcileAccountOnce(deps);
		expect(submitCalls).toBe(0);
		expect(report.outcomes.map((o) => o.kind)).toEqual(["failed-terminal"]);
	});

	test("enters an account-wide cooldown on a rate-limit poll error", async () => {
		const deps = baseDeps({
			fetchDepositHistory: async () => {
				throw new Error("binance -1003 Too many requests");
			},
		});
		const report = await reconcileAccountOnce(deps);
		expect(report.outcomes.map((o) => o.kind)).toEqual(["poll-error"]);
		expect(deps.state.rateLimitedUntil).toBe(
			deps.now + deps.rateLimitCooldownMs,
		);
	});

	test("skips entirely while inside the rate-limit cooldown", async () => {
		let historyCalls = 0;
		const state = createAccountState();
		state.rateLimitedUntil = 2_000_000;
		const deps = baseDeps({
			state,
			now: 1_500_000,
			fetchDepositHistory: async () => {
				historyCalls++;
				return [];
			},
		});
		await reconcileAccountOnce(deps);
		expect(historyCalls).toBe(0);
	});
});
