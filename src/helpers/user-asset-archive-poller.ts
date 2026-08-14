import type { BrokerAccount, BrokerPoolEntry } from "./broker";
import {
	type BrokerExecutionArchiver,
	buildCommonArchiveTags,
	buildUserAssetSnapshotRow,
	normalizeBinanceUserAssetsForArchive,
	rethrowArchiveDurabilityError,
	USER_ASSET_BALANCE_SCOPE,
} from "./broker-execution-archive";
import { log } from "./logger";
import type { OtelMetrics } from "./otel";

/**
 * Periodic snapshot of Binance's `POST /sapi/v3/asset/getUserAsset`.
 *
 * Sibling of {@link AccountBalanceArchivePoller}, not a replacement. The spot
 * fetchBalance snapshot reads api/v3/account, which reports only free and
 * locked; funds held under a travel-rule freeze are owned but appear in neither,
 * so they are invisible there for as long as the hold lasts. getUserAsset is the
 * only endpoint that reports the freeze bucket, so NAV reads it from here.
 *
 * It is a separate poller so that a getUserAsset outage (a sapi-only endpoint,
 * with its own weight budget and its own venue availability) cannot take the
 * spot balance snapshot down with it, and vice versa.
 */

// ccxt generates this implicit method from binance's sapiV3 POST map; it is
// already in the vendored @usherlabs/ccxt api definition, so unlike the
// localentity endpoints it needs no defineRestApi registration.
type ExchangeWithUserAsset = {
	id?: string;
	sapiV3PostAssetGetUserAsset?: (
		params?: Record<string, unknown>,
	) => Promise<unknown>;
};

export type UserAssetArchivePollerConfig = {
	pollIntervalMs: number;
};

const DEFAULT_CONFIG: UserAssetArchivePollerConfig = {
	pollIntervalMs: 60_000,
};

// The endpoint is Binance-only. Other venues have no freeze bucket to read, so
// they are not polled at all — that is an absent scope, not a failed read.
const USER_ASSET_EXCHANGE_ID = "binance";

type UserAssetPollTarget = {
	exchangeId: string;
	account: BrokerAccount;
};

const metricLabels = (target: UserAssetPollTarget) => ({
	exchange: target.exchangeId,
	account_selector: target.account.label,
	balance_scope: USER_ASSET_BALANCE_SCOPE,
});

export class UserAssetArchivePoller {
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#running: Promise<boolean> | null = null;
	readonly #lastSuccessMs = new Map<string, number>();
	readonly #config: UserAssetArchivePollerConfig;

	constructor(
		private readonly params: {
			brokers: Record<string, BrokerPoolEntry>;
			archiver: BrokerExecutionArchiver;
			metrics?: OtelMetrics;
			config?: Partial<UserAssetArchivePollerConfig>;
		},
	) {
		this.#config = { ...DEFAULT_CONFIG, ...params.config };
	}

	start(): void {
		if (
			this.#timer ||
			this.#stopped ||
			!this.params.archiver.canPersistAccountBalanceSnapshots() ||
			this.#targets().length === 0
		) {
			return;
		}
		log.info("🧊 User asset archive poller started", {
			balanceScope: USER_ASSET_BALANCE_SCOPE,
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

	#targets(): UserAssetPollTarget[] {
		const targets: UserAssetPollTarget[] = [];
		for (const [exchangeId, pool] of Object.entries(this.params.brokers)) {
			if (exchangeId.trim().toLowerCase() !== USER_ASSET_EXCHANGE_ID) {
				continue;
			}
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

	async #pollOne(target: UserAssetPollTarget): Promise<void> {
		const labels = metricLabels(target);
		void this.params.metrics?.recordCounter(
			"cex_user_asset_poll_attempts_total",
			1,
			labels,
		);
		try {
			const exchange = target.account
				.exchange as unknown as ExchangeWithUserAsset;
			// A Binance account whose exchange instance lacks the method is a broken
			// read, not an absent scope: leave the snapshot missing and count a
			// failure rather than write a row that reports no frozen funds.
			if (typeof exchange.sapiV3PostAssetGetUserAsset !== "function") {
				throw new Error(
					"binance_user_asset_unavailable: getUserAsset is not defined on this exchange instance",
				);
			}
			const response = await exchange.sapiV3PostAssetGetUserAsset({});
			const observedAt = new Date();
			const normalized = normalizeBinanceUserAssetsForArchive(response);
			this.params.archiver.enqueue(
				buildUserAssetSnapshotRow({
					tags: buildCommonArchiveTags({
						deploymentId: this.params.archiver.getDeploymentId(),
						accountSelector: target.account.label,
						exchange: target.exchangeId,
						brokerObservedTimestamp: observedAt.toISOString(),
					}),
					userAssets: normalized,
				}),
			);

			const successMs = Date.now();
			this.#lastSuccessMs.set(this.#targetKey(target), successMs);
			void this.params.metrics?.recordCounter(
				"cex_user_asset_poll_successes_total",
				1,
				labels,
			);
			void this.params.metrics?.recordGauge(
				"cex_user_asset_poll_last_success_timestamp_seconds",
				Math.floor(successMs / 1000),
				labels,
			);
			this.#recordFreshness(labels, successMs, successMs);
		} catch (error) {
			rethrowArchiveDurabilityError(error);
			void this.params.metrics?.recordCounter(
				"cex_user_asset_poll_failures_total",
				1,
				labels,
			);
			const now = Date.now();
			const lastSuccess = this.#lastSuccessMs.get(this.#targetKey(target));
			if (lastSuccess !== undefined) {
				this.#recordFreshness(labels, lastSuccess, now);
			}
			log.warn("User asset archive poll failed", {
				exchange: target.exchangeId,
				account: target.account.label,
				balanceScope: USER_ASSET_BALANCE_SCOPE,
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
			"cex_user_asset_poll_freshness_seconds",
			Math.max(0, (nowMs - lastSuccessMs) / 1000),
			labels,
		);
	}

	#targetKey(target: UserAssetPollTarget): string {
		return `${target.exchangeId}|${target.account.label}|${USER_ASSET_BALANCE_SCOPE}`;
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
			rethrowArchiveDurabilityError(error);
			log.error("User asset archive poller tick failed", error);
		} finally {
			if (!this.#stopped) {
				this.#schedule(this.#config.pollIntervalMs);
			}
		}
	}
}
