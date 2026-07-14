import type { BrokerAccount, BrokerPoolEntry } from "./broker";
import {
	ACCOUNT_BALANCE_SCOPE,
	type BrokerExecutionArchiver,
	buildAccountBalanceSnapshotRow,
	buildCommonArchiveTags,
	normalizeCcxtBalanceForArchive,
} from "./broker-execution-archive";
import { log } from "./logger";
import type { OtelMetrics } from "./otel";

type ExchangeWithBalance = {
	fetchBalance: (params: { type: "spot" }) => Promise<unknown>;
};

export type AccountBalanceArchivePollerConfig = {
	pollIntervalMs: number;
};

const DEFAULT_CONFIG: AccountBalanceArchivePollerConfig = {
	pollIntervalMs: 60_000,
};

type BalancePollTarget = {
	exchangeId: string;
	account: BrokerAccount;
};

const metricLabels = (target: BalancePollTarget) => ({
	exchange: target.exchangeId,
	account_selector: target.account.label,
	balance_scope: ACCOUNT_BALANCE_SCOPE,
});

export class AccountBalanceArchivePoller {
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#running: Promise<boolean> | null = null;
	readonly #lastSuccessMs = new Map<string, number>();
	readonly #config: AccountBalanceArchivePollerConfig;

	constructor(
		private readonly params: {
			brokers: Record<string, BrokerPoolEntry>;
			archiver: BrokerExecutionArchiver;
			metrics?: OtelMetrics;
			config?: Partial<AccountBalanceArchivePollerConfig>;
		},
	) {
		this.#config = { ...DEFAULT_CONFIG, ...params.config };
	}

	start(): void {
		if (
			this.#timer ||
			this.#stopped ||
			!this.params.archiver.canPersistAccountBalanceSnapshots()
		) {
			return;
		}
		log.info("💰 Account balance archive poller started", {
			balanceScope: ACCOUNT_BALANCE_SCOPE,
		});
		this.#schedule(0);
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		await this.#running;
	}

	async pollAllOnce(): Promise<boolean> {
		if (
			this.#stopped ||
			this.#running ||
			!this.params.archiver.canPersistAccountBalanceSnapshots()
		) {
			return false;
		}
		this.#running = this.#pollAllSequentially();
		try {
			return await this.#running;
		} finally {
			this.#running = null;
		}
	}

	#targets(): BalancePollTarget[] {
		const targets: BalancePollTarget[] = [];
		for (const [exchangeId, pool] of Object.entries(this.params.brokers)) {
			for (const account of [pool.primary, ...pool.secondaryBrokers]) {
				targets.push({ exchangeId, account });
			}
		}
		return targets;
	}

	async #pollAllSequentially(): Promise<boolean> {
		for (const target of this.#targets()) {
			if (this.#stopped) {
				break;
			}
			await this.#pollOne(target);
		}
		return true;
	}

	async #pollOne(target: BalancePollTarget): Promise<void> {
		const labels = metricLabels(target);
		void this.params.metrics?.recordCounter(
			"cex_account_balance_poll_attempts_total",
			1,
			labels,
		);
		try {
			const exchange = target.account
				.exchange as unknown as ExchangeWithBalance;
			const balance = await exchange.fetchBalance({
				type: ACCOUNT_BALANCE_SCOPE,
			});
			const observedAt = new Date();
			const normalized = normalizeCcxtBalanceForArchive(balance);
			this.params.archiver.enqueue(
				buildAccountBalanceSnapshotRow({
					tags: buildCommonArchiveTags({
						deploymentId: this.params.archiver.getDeploymentId(),
						accountSelector: target.account.label,
						exchange: target.exchangeId,
						brokerObservedTimestamp: observedAt.toISOString(),
					}),
					balance: normalized,
				}),
			);

			const successMs = Date.now();
			this.#lastSuccessMs.set(this.#targetKey(target), successMs);
			void this.params.metrics?.recordCounter(
				"cex_account_balance_poll_successes_total",
				1,
				labels,
			);
			void this.params.metrics?.recordGauge(
				"cex_account_balance_poll_last_success_timestamp_seconds",
				Math.floor(successMs / 1000),
				labels,
			);
			this.#recordFreshness(labels, successMs, successMs);
		} catch (error) {
			void this.params.metrics?.recordCounter(
				"cex_account_balance_poll_failures_total",
				1,
				labels,
			);
			const now = Date.now();
			const lastSuccess = this.#lastSuccessMs.get(this.#targetKey(target));
			if (lastSuccess !== undefined) {
				this.#recordFreshness(labels, lastSuccess, now);
			}
			log.warn("Account balance archive poll failed", {
				exchange: target.exchangeId,
				account: target.account.label,
				balanceScope: ACCOUNT_BALANCE_SCOPE,
				errorType: error instanceof Error ? error.name : "unknown",
			});
		}
	}

	#recordFreshness(
		labels: ReturnType<typeof metricLabels>,
		lastSuccessMs: number,
		nowMs: number,
	): void {
		void this.params.metrics?.recordGauge(
			"cex_account_balance_poll_freshness_seconds",
			Math.max(0, (nowMs - lastSuccessMs) / 1000),
			labels,
		);
	}

	#targetKey(target: BalancePollTarget): string {
		return `${target.exchangeId}|${target.account.label}|${ACCOUNT_BALANCE_SCOPE}`;
	}

	#schedule(delayMs: number): void {
		this.#timer = setTimeout(() => void this.#tick(), delayMs);
		this.#timer.unref?.();
	}

	async #tick(): Promise<void> {
		this.#timer = null;
		try {
			await this.pollAllOnce();
		} catch (error) {
			log.error("Account balance archive poller tick failed", error);
		} finally {
			if (!this.#stopped) {
				this.#schedule(this.#config.pollIntervalMs);
			}
		}
	}
}
