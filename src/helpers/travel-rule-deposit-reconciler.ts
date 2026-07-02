import type { Exchange } from "@usherlabs/ccxt";
import type {
	PolicyConfig,
	TravelRuleDepositConfig,
	TravelRuleDepositQuestionnaire,
} from "../types";
import type { BrokerAccount, BrokerPoolEntry } from "./broker";
import { depositField } from "./deposit";
import { log } from "./logger";
import type { OtelMetrics } from "./otel";
import {
	getEnabledTravelRuleDepositConfig,
	resolveDepositOriginatorQuestionnaire,
} from "./travel-rule";

/**
 * Auto-clear reconciler for Binance travel-rule-frozen DEPOSITS.
 *
 * Under the AUSTRAC travel rule Binance credits an inbound deposit but holds it
 * in `getUserAsset.freeze` (invisible to free+locked balances) until a per-deposit
 * questionnaire is answered. This reconciler polls `localentity/deposit/history`
 * for such frozen deposits and submits the questionnaire — but only for deposits
 * whose on-chain sender is PROVEN (via `eth_getTransactionByHash`) to be one of
 * our configured originator wallets. Everything else is left frozen and surfaced.
 *
 * Compliance invariant: a deposit is NEVER auto-declared unless its origin is
 * proven ours. Undeclared origin, unresolvable sender, entity drift, or any
 * uncertainty all fail closed (skip + surface), never "declare anyway".
 *
 * This runs entirely broker-internal (not through the gRPC verity path), so
 * provide-info carries no verity proof — acceptable for a compliance attestation
 * that is not a trading action; see the plan's edge-case notes.
 */

// ---------------------------------------------------------------------------
// Parsed deposit record
// ---------------------------------------------------------------------------

export type LocalEntityDeposit = {
	tranId: string;
	coin: string;
	amount: string;
	network: string;
	txId: string;
	// travelRuleStatusV2, uppercased: PENDING | PASSED | FAILED (others pass through).
	travelRuleStatus: string;
	requireQuestionnaire: boolean;
	raw: Record<string, unknown>;
};

function toBool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") return value.trim().toLowerCase() === "true";
	return false;
}

/**
 * Parses one raw `localentity/deposit/history` row. Returns null when the row
 * lacks a tranId (the only id valid for provide-info — the `capital/deposit/hisrec`
 * id is a different id space and yields "Deposit request not found").
 */
export function parseLocalEntityDeposit(
	raw: Record<string, unknown>,
): LocalEntityDeposit | null {
	// Only `tranId` is accepted: it is the sole id `provide-info` recognizes. A
	// generic `id` fallback risks the `capital/deposit/hisrec` id space, which
	// provide-info rejects with "Deposit request not found".
	const tranId = depositField(raw, ["tranId"]);
	if (tranId === undefined) return null;
	return {
		tranId: String(tranId),
		coin: String(depositField(raw, ["coin", "asset"]) ?? ""),
		amount: String(depositField(raw, ["amount"]) ?? ""),
		network: String(depositField(raw, ["network"]) ?? ""),
		txId: String(
			depositField(raw, ["txId", "txid", "tx_hash", "txHash"]) ?? "",
		),
		travelRuleStatus: String(
			depositField(raw, ["travelRuleStatusV2", "travelRuleStatus"]) ?? "",
		)
			.trim()
			.toUpperCase(),
		requireQuestionnaire: toBool(
			raw.requireQuestionnaire ?? raw.requireQuestionnaireV2,
		),
		raw,
	};
}

// ---------------------------------------------------------------------------
// On-chain origin proof
// ---------------------------------------------------------------------------

const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Resolves the on-chain sender (`tx.from`) of a deposit's transaction hash via a
 * JSON-RPC `eth_getTransactionByHash`. Returns the lowercased sender, or null
 * when the hash is not a well-formed EVM tx hash or the tx is not found (pruned
 * node / reorg / not yet mined) — both of which mean the origin is UNPROVEN and
 * the caller must skip rather than assume.
 *
 * `tx.from` is the EOA that signed the deposit transaction. For our funding
 * churn (owner wallet → Binance via a direct ERC20 transfer) that equals the
 * token originator. A transfer routed through a contract could differ; hardening
 * to the ERC20 Transfer event's `from` is possible later if that case arises.
 */
export async function resolveOnChainSender(
	rpcUrl: string,
	txHash: string,
	timeoutMs = 10_000,
): Promise<string | null> {
	if (!EVM_TX_HASH.test(txHash)) return null;
	// Bound the request: a hung RPC would otherwise stall the whole reconciler
	// tick (candidates are resolved sequentially) and block the next poll.
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	let response: Response;
	try {
		response = await fetch(rpcUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: controller.signal,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "eth_getTransactionByHash",
				params: [txHash],
			}),
		});
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) {
		throw new Error(`travel_rule_rpc_http_${response.status}`);
	}
	const json = (await response.json()) as {
		result?: { from?: unknown } | null;
		error?: unknown;
	};
	if (json.error) {
		throw new Error(`travel_rule_rpc_error: ${JSON.stringify(json.error)}`);
	}
	const from = json.result?.from;
	return typeof from === "string" && from.length > 0
		? from.toLowerCase()
		: null;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** Binance rate-limit signals (-1003 / HTTP 429 / DDoS guard). */
export function isRateLimitError(error: unknown): boolean {
	const text = errorText(error).toLowerCase();
	return (
		text.includes("-1003") ||
		text.includes("too many requests") ||
		text.includes("429") ||
		text.includes("ddosprotection") ||
		text.includes("ratelimitexceeded")
	);
}

/**
 * A provide-info call that Binance treats as already-satisfied. Re-submitting a
 * tranId that was already provided (a manual release, or a reconciler restart)
 * must be idempotent, so these responses/errors count as success.
 */
export function isAlreadyProvidedError(error: unknown): boolean {
	const text = errorText(error).toLowerCase();
	return (
		text.includes("already") &&
		(text.includes("provided") ||
			text.includes("processed") ||
			text.includes("passed") ||
			text.includes("submit"))
	);
}

function isAcceptedResponse(response: Record<string, unknown>): boolean {
	// { "accepted": true } on success. Some paths return no explicit flag; treat
	// an absent `accepted` as accepted (no error was thrown) but an explicit
	// `accepted: false` as a content rejection.
	return response.accepted !== false;
}

// ---------------------------------------------------------------------------
// Per-account reconcile core (pure orchestration over injected I/O)
// ---------------------------------------------------------------------------

export type ReconcilerAccountState = {
	// tranIds we have successfully submitted (or that Binance reported already
	// provided). Skipped on subsequent cycles — idempotency keyed by tranId.
	submittedTranIds: Set<string>;
	// FAILED deposits already surfaced once (terminal; not re-logged every cycle).
	surfacedFailed: Set<string>;
	// tranId → epoch-ms before which we will not re-attempt. Prevents hot-looping
	// on content errors, unresolved senders, and undeclared origins.
	backoffUntil: Map<string, number>;
	// account-wide cooldown after a rate-limit signal (epoch-ms).
	rateLimitedUntil: number;
};

export function createAccountState(): ReconcilerAccountState {
	return {
		submittedTranIds: new Set(),
		surfacedFailed: new Set(),
		backoffUntil: new Map(),
		rateLimitedUntil: 0,
	};
}

export type ReconcileOutcome =
	| { kind: "submitted"; deposit: LocalEntityDeposit; sender: string }
	| { kind: "already-provided"; deposit: LocalEntityDeposit; sender: string }
	| { kind: "undeclared-origin"; deposit: LocalEntityDeposit; sender: string }
	| { kind: "unproven-origin"; deposit: LocalEntityDeposit }
	| {
			kind: "entity-drift";
			deposit: LocalEntityDeposit;
			country: string | null;
	  }
	| { kind: "failed-terminal"; deposit: LocalEntityDeposit }
	| { kind: "submit-error"; deposit: LocalEntityDeposit; error: string }
	| { kind: "poll-error"; error: string };

export type ReconcileAccountReport = {
	accountLabel: string;
	frozenDeposits: LocalEntityDeposit[];
	outcomes: ReconcileOutcome[];
	// Whether there was actionable work this cycle — drives active vs idle cadence.
	hadActionableWork: boolean;
};

export type ReconcileAccountDeps = {
	accountLabel: string;
	depositConfig: TravelRuleDepositConfig;
	expectedCountry: string;
	failureBackoffMs: number;
	rateLimitCooldownMs: number;
	now: number;
	state: ReconcilerAccountState;
	fetchDepositHistory: () => Promise<Array<Record<string, unknown>>>;
	fetchQuestionnaireCountry: () => Promise<string | null>;
	resolveSender: (network: string, txId: string) => Promise<string | null>;
	submitProvideInfo: (
		tranId: string,
		questionnaire: TravelRuleDepositQuestionnaire,
	) => Promise<Record<string, unknown>>;
	resolveQuestionnaire: (
		config: TravelRuleDepositConfig,
		sender: string,
	) => TravelRuleDepositQuestionnaire | null;
};

function isInBackoff(
	state: ReconcilerAccountState,
	tranId: string,
	now: number,
): boolean {
	const until = state.backoffUntil.get(tranId);
	return until !== undefined && now < until;
}

/**
 * Reconciles a single account once. Pure orchestration: all I/O is injected so
 * the compliance invariants (never submit an unproven/undeclared/entity-drifted
 * deposit) are unit-testable without a network. Fetch/poll errors are captured
 * as outcomes rather than thrown so one bad account never stalls the loop.
 */
export async function reconcileAccountOnce(
	deps: ReconcileAccountDeps,
): Promise<ReconcileAccountReport> {
	const { state, now, accountLabel } = deps;
	const outcomes: ReconcileOutcome[] = [];

	if (now < state.rateLimitedUntil) {
		return {
			accountLabel,
			frozenDeposits: [],
			outcomes,
			hadActionableWork: false,
		};
	}

	let rawDeposits: Array<Record<string, unknown>>;
	try {
		rawDeposits = await deps.fetchDepositHistory();
	} catch (error) {
		if (isRateLimitError(error)) {
			state.rateLimitedUntil = now + deps.rateLimitCooldownMs;
		}
		return {
			accountLabel,
			frozenDeposits: [],
			outcomes: [{ kind: "poll-error", error: errorText(error) }],
			hadActionableWork: false,
		};
	}

	const deposits = rawDeposits
		.map(parseLocalEntityDeposit)
		.filter((d): d is LocalEntityDeposit => d !== null);
	const frozen = deposits.filter(
		(d) => d.requireQuestionnaire && d.travelRuleStatus === "PENDING",
	);

	// Terminal FAILED deposits: surface once, never auto-submit.
	for (const deposit of deposits) {
		if (
			deposit.travelRuleStatus === "FAILED" &&
			!state.surfacedFailed.has(deposit.tranId)
		) {
			state.surfacedFailed.add(deposit.tranId);
			outcomes.push({ kind: "failed-terminal", deposit });
		}
	}

	const candidates = frozen.filter(
		(d) =>
			!state.submittedTranIds.has(d.tranId) &&
			!isInBackoff(state, d.tranId, now),
	);
	if (candidates.length === 0) {
		return {
			accountLabel,
			frozenDeposits: frozen,
			outcomes,
			hadActionableWork: false,
		};
	}

	// Entity gate: only submit AU-shaped answers to an AU entity. Checked once per
	// cycle, only when there is a candidate, and fail-closed on drift/unavailable.
	let country: string | null = null;
	try {
		country = await deps.fetchQuestionnaireCountry();
	} catch (error) {
		if (isRateLimitError(error)) {
			state.rateLimitedUntil = now + deps.rateLimitCooldownMs;
		}
		country = null;
	}
	if (country !== deps.expectedCountry) {
		for (const deposit of candidates) {
			outcomes.push({ kind: "entity-drift", deposit, country });
		}
		return {
			accountLabel,
			frozenDeposits: frozen,
			outcomes,
			hadActionableWork: true,
		};
	}

	for (const deposit of candidates) {
		// A rate-limit signal from an earlier candidate this cycle set an
		// account-wide cooldown; stop hitting the API for the rest and let the next
		// tick wait it out rather than compounding the -1003.
		if (now < state.rateLimitedUntil) break;
		let sender: string | null = null;
		try {
			sender = await deps.resolveSender(deposit.network, deposit.txId);
		} catch (error) {
			sender = null;
			if (isRateLimitError(error)) {
				state.rateLimitedUntil = now + deps.rateLimitCooldownMs;
			}
		}
		if (!sender) {
			state.backoffUntil.set(deposit.tranId, now + deps.failureBackoffMs);
			outcomes.push({ kind: "unproven-origin", deposit });
			continue;
		}

		const questionnaire = deps.resolveQuestionnaire(deps.depositConfig, sender);
		if (!questionnaire) {
			state.backoffUntil.set(deposit.tranId, now + deps.failureBackoffMs);
			outcomes.push({ kind: "undeclared-origin", deposit, sender });
			continue;
		}

		try {
			const response = await deps.submitProvideInfo(
				deposit.tranId,
				questionnaire,
			);
			if (isAcceptedResponse(response)) {
				state.submittedTranIds.add(deposit.tranId);
				state.backoffUntil.delete(deposit.tranId);
				outcomes.push({ kind: "submitted", deposit, sender });
			} else {
				state.backoffUntil.set(deposit.tranId, now + deps.failureBackoffMs);
				outcomes.push({
					kind: "submit-error",
					deposit,
					error: JSON.stringify(response),
				});
			}
		} catch (error) {
			if (isAlreadyProvidedError(error)) {
				state.submittedTranIds.add(deposit.tranId);
				state.backoffUntil.delete(deposit.tranId);
				outcomes.push({ kind: "already-provided", deposit, sender });
			} else {
				if (isRateLimitError(error)) {
					state.rateLimitedUntil = now + deps.rateLimitCooldownMs;
				}
				state.backoffUntil.set(deposit.tranId, now + deps.failureBackoffMs);
				outcomes.push({
					kind: "submit-error",
					deposit,
					error: errorText(error),
				});
			}
		}
	}

	return {
		accountLabel,
		frozenDeposits: frozen,
		outcomes,
		hadActionableWork: true,
	};
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type TravelRuleDepositReconcilerConfig = {
	// Upper-cased Binance network code (e.g. "ARBITRUM") → EVM JSON-RPC URL used to
	// prove a deposit's on-chain sender. A frozen deposit on a network with no RPC
	// configured is treated as unproven and left frozen (fail-closed).
	rpcUrlsByNetwork: Record<string, string>;
	pollIntervalActiveMs: number;
	pollIntervalIdleMs: number;
	expectedQuestionnaireCountry: string;
	failureBackoffMs: number;
	rateLimitCooldownMs: number;
};

const DEFAULTS = {
	pollIntervalActiveMs: 60_000,
	pollIntervalIdleMs: 600_000,
	expectedQuestionnaireCountry: "AU",
	failureBackoffMs: 15 * 60_000,
	rateLimitCooldownMs: 5 * 60_000,
};

function envSecondsToMs(
	env: Record<string, string | undefined>,
	key: string,
	fallbackMs: number,
): number {
	const raw = env[key];
	if (raw === undefined) return fallbackMs;
	const secs = Number(raw);
	return Number.isFinite(secs) && secs > 0 ? secs * 1000 : fallbackMs;
}

/**
 * Builds reconciler config from the environment. RPC URLs are read from
 * `TRAVEL_RULE_RPC_URL_<NETWORK>` vars (network suffix must match Binance's
 * network code, e.g. `TRAVEL_RULE_RPC_URL_ARBITRUM`). These are intentionally NOT
 * `CEX_BROKER_`-prefixed so the credential env scan ignores them. Cadence and the
 * expected questionnaire country are overridable but default to the AU rollout.
 */
export function loadTravelRuleDepositReconcilerConfigFromEnv(
	env: Record<string, string | undefined>,
): TravelRuleDepositReconcilerConfig {
	const rpcUrlsByNetwork: Record<string, string> = {};
	const prefix = "TRAVEL_RULE_RPC_URL_";
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith(prefix) && value) {
			rpcUrlsByNetwork[key.slice(prefix.length).toUpperCase()] = value;
		}
	}
	return {
		rpcUrlsByNetwork,
		pollIntervalActiveMs: envSecondsToMs(
			env,
			"TRAVEL_RULE_DEPOSIT_POLL_ACTIVE_SECS",
			DEFAULTS.pollIntervalActiveMs,
		),
		pollIntervalIdleMs: envSecondsToMs(
			env,
			"TRAVEL_RULE_DEPOSIT_POLL_IDLE_SECS",
			DEFAULTS.pollIntervalIdleMs,
		),
		expectedQuestionnaireCountry:
			env.TRAVEL_RULE_QUESTIONNAIRE_COUNTRY?.trim().toUpperCase() ||
			DEFAULTS.expectedQuestionnaireCountry,
		failureBackoffMs: envSecondsToMs(
			env,
			"TRAVEL_RULE_DEPOSIT_FAILURE_BACKOFF_SECS",
			DEFAULTS.failureBackoffMs,
		),
		rateLimitCooldownMs: envSecondsToMs(
			env,
			"TRAVEL_RULE_DEPOSIT_RATE_LIMIT_COOLDOWN_SECS",
			DEFAULTS.rateLimitCooldownMs,
		),
	};
}

// ---------------------------------------------------------------------------
// Binance localentity implicit-method surface (registered via defineRestApi)
// ---------------------------------------------------------------------------

type BinanceLocalEntityDeposit = Exchange & {
	sapiGetLocalentityDepositHistory?: (
		params: Record<string, unknown>,
	) => Promise<unknown>;
	sapiGetLocalentityQuestionnaireRequirements?: (
		params: Record<string, unknown>,
	) => Promise<unknown>;
	sapiPutLocalentityDepositProvideInfo?: (
		params: Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
};

function parseQuestionnaireCountry(response: unknown): string | null {
	if (!response || typeof response !== "object") return null;
	const code = (response as Record<string, unknown>).questionnaireCountryCode;
	return typeof code === "string" ? code.trim().toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Reconciler loop
// ---------------------------------------------------------------------------

type ReconcilerTarget = {
	exchangeId: string;
	account: BrokerAccount;
	depositConfig: TravelRuleDepositConfig;
};

export class TravelRuleDepositReconciler {
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#running = false;
	readonly #states = new Map<string, ReconcilerAccountState>();

	constructor(
		private readonly params: {
			policy: PolicyConfig;
			brokers: Record<string, BrokerPoolEntry>;
			config: TravelRuleDepositReconcilerConfig;
			metrics?: OtelMetrics;
		},
	) {}

	/** True when at least one exchange has deposit auto-clear enabled in policy. */
	static hasEnabledExchange(policy: PolicyConfig): boolean {
		return (policy.travelRule?.rule ?? []).some((rule) =>
			getEnabledTravelRuleDepositConfig(policy, rule.exchange),
		);
	}

	start(): void {
		if (this.#timer || this.#stopped) return;
		if (!TravelRuleDepositReconciler.hasEnabledExchange(this.params.policy)) {
			return;
		}
		if (Object.keys(this.params.config.rpcUrlsByNetwork).length === 0) {
			log.warn(
				"⚠️ Travel-rule deposit auto-clear is enabled but no TRAVEL_RULE_RPC_URL_<NETWORK> is configured; every frozen deposit will be treated as unproven (left frozen).",
			);
		}
		log.info("🛂 Travel-rule deposit auto-clear reconciler started");
		this.#scheduleImmediate();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}

	#scheduleImmediate(): void {
		this.#timer = setTimeout(() => void this.#tick(), 0);
	}

	#stateFor(key: string): ReconcilerAccountState {
		let state = this.#states.get(key);
		if (!state) {
			state = createAccountState();
			this.#states.set(key, state);
		}
		return state;
	}

	#targets(): ReconcilerTarget[] {
		const targets: ReconcilerTarget[] = [];
		for (const rule of this.params.policy.travelRule?.rule ?? []) {
			const depositConfig = getEnabledTravelRuleDepositConfig(
				this.params.policy,
				rule.exchange,
			);
			if (!depositConfig) continue;
			const exchangeId = rule.exchange.trim().toLowerCase();
			const pool = this.params.brokers[exchangeId];
			if (!pool) continue;
			// Reconcile every account: the origin-proof gate makes it safe, and a
			// frozen deposit that landed on the wrong account (master) still releases.
			for (const account of [pool.primary, ...pool.secondaryBrokers]) {
				targets.push({ exchangeId, account, depositConfig });
			}
		}
		return targets;
	}

	async #tick(): Promise<void> {
		if (this.#stopped || this.#running) return;
		this.#running = true;
		let anyActionable = false;
		try {
			for (const target of this.#targets()) {
				if (this.#stopped) break;
				const report = await this.#reconcileTarget(target);
				this.#emit(target, report);
				if (report.hadActionableWork) anyActionable = true;
			}
		} catch (error) {
			log.error("Travel-rule deposit reconciler tick failed", error);
		} finally {
			this.#running = false;
			if (!this.#stopped) {
				const delay = anyActionable
					? this.params.config.pollIntervalActiveMs
					: this.params.config.pollIntervalIdleMs;
				this.#timer = setTimeout(() => void this.#tick(), delay);
			}
		}
	}

	#reconcileTarget(target: ReconcilerTarget): Promise<ReconcileAccountReport> {
		const exchange = target.account.exchange as BinanceLocalEntityDeposit;
		const accountLabel = `${target.exchangeId}:${target.account.label}`;
		const { config } = this.params;
		return reconcileAccountOnce({
			accountLabel,
			depositConfig: target.depositConfig,
			expectedCountry: config.expectedQuestionnaireCountry,
			failureBackoffMs: config.failureBackoffMs,
			rateLimitCooldownMs: config.rateLimitCooldownMs,
			now: Date.now(),
			state: this.#stateFor(accountLabel),
			fetchDepositHistory: async () => {
				if (typeof exchange.sapiGetLocalentityDepositHistory !== "function") {
					throw new Error(
						"binance_localentity_deposit_history_unavailable: endpoint not registered",
					);
				}
				const result = await exchange.sapiGetLocalentityDepositHistory({});
				return Array.isArray(result)
					? (result as Array<Record<string, unknown>>)
					: [];
			},
			fetchQuestionnaireCountry: async () => {
				if (
					typeof exchange.sapiGetLocalentityQuestionnaireRequirements !==
					"function"
				) {
					return null;
				}
				const result =
					await exchange.sapiGetLocalentityQuestionnaireRequirements({});
				return parseQuestionnaireCountry(result);
			},
			resolveSender: (network, txId) => {
				const url = config.rpcUrlsByNetwork[network.trim().toUpperCase()];
				if (!url) return Promise.resolve(null);
				return resolveOnChainSender(url, txId);
			},
			submitProvideInfo: (tranId, questionnaire) => {
				if (
					typeof exchange.sapiPutLocalentityDepositProvideInfo !== "function"
				) {
					throw new Error(
						"binance_localentity_provide_info_unavailable: endpoint not registered",
					);
				}
				return exchange.sapiPutLocalentityDepositProvideInfo({
					tranId,
					questionnaire: JSON.stringify(questionnaire),
				});
			},
			resolveQuestionnaire: resolveDepositOriginatorQuestionnaire,
		});
	}

	#emit(target: ReconcilerTarget, report: ReconcileAccountReport): void {
		const { metrics } = this.params;
		const base = { exchange: target.exchangeId, account: target.account.label };

		void metrics?.recordGauge(
			"travel_rule_frozen_deposits",
			report.frozenDeposits.length,
			base,
		);

		for (const outcome of report.outcomes) {
			switch (outcome.kind) {
				case "submitted":
				case "already-provided": {
					// Compliance attestation — must be auditable.
					log.info("🛂 Travel-rule deposit auto-declared", {
						result: outcome.kind,
						account: report.accountLabel,
						tranId: outcome.deposit.tranId,
						coin: outcome.deposit.coin,
						amount: outcome.deposit.amount,
						network: outcome.deposit.network,
						txId: outcome.deposit.txId,
						originator: outcome.sender,
					});
					void metrics?.recordCounter(
						"travel_rule_deposit_submissions_total",
						1,
						{
							...base,
							coin: outcome.deposit.coin,
							result: outcome.kind,
						},
					);
					break;
				}
				case "undeclared-origin":
					log.warn(
						"🛂 Travel-rule deposit from UNDECLARED originator — left frozen",
						{
							account: report.accountLabel,
							tranId: outcome.deposit.tranId,
							coin: outcome.deposit.coin,
							amount: outcome.deposit.amount,
							sender: outcome.sender,
						},
					);
					void metrics?.recordCounter(
						"travel_rule_deposit_anomalies_total",
						1,
						{
							...base,
							reason: "undeclared_origin",
						},
					);
					break;
				case "unproven-origin":
					log.warn(
						"🛂 Travel-rule deposit origin UNPROVEN (tx sender unresolved) — left frozen",
						{
							account: report.accountLabel,
							tranId: outcome.deposit.tranId,
							coin: outcome.deposit.coin,
							network: outcome.deposit.network,
							txId: outcome.deposit.txId,
						},
					);
					void metrics?.recordCounter(
						"travel_rule_deposit_anomalies_total",
						1,
						{
							...base,
							reason: "unproven_origin",
						},
					);
					break;
				case "entity-drift":
					log.warn(
						"🛂 Travel-rule deposit skipped — questionnaire entity is not the expected country",
						{
							account: report.accountLabel,
							tranId: outcome.deposit.tranId,
							observedCountry: outcome.country,
							expectedCountry: this.params.config.expectedQuestionnaireCountry,
						},
					);
					void metrics?.recordCounter(
						"travel_rule_deposit_anomalies_total",
						1,
						{
							...base,
							reason: "entity_drift",
						},
					);
					break;
				case "failed-terminal":
					log.warn(
						"🛂 Travel-rule deposit is FAILED (terminal) — needs manual handling",
						{
							account: report.accountLabel,
							tranId: outcome.deposit.tranId,
							coin: outcome.deposit.coin,
						},
					);
					void metrics?.recordCounter(
						"travel_rule_deposit_anomalies_total",
						1,
						{
							...base,
							reason: "failed_status",
						},
					);
					break;
				case "submit-error":
					log.error("🛂 Travel-rule deposit provide-info failed", {
						account: report.accountLabel,
						tranId: outcome.deposit.tranId,
						error: outcome.error,
					});
					void metrics?.recordCounter(
						"travel_rule_deposit_anomalies_total",
						1,
						{
							...base,
							reason: "submit_error",
						},
					);
					break;
				case "poll-error":
					log.error("🛂 Travel-rule deposit history poll failed", {
						account: report.accountLabel,
						error: outcome.error,
					});
					void metrics?.recordCounter(
						"travel_rule_deposit_anomalies_total",
						1,
						{
							...base,
							reason: "poll_error",
						},
					);
					break;
			}
		}
	}
}
