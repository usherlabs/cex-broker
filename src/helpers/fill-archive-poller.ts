import type { BrokerPoolEntry } from "./broker";
import { resolveBrokerAccount } from "./broker";
import {
	type BrokerExecutionArchiver,
	buildCommonArchiveTags,
	buildFillEventArchiveRow,
	normalizeCcxtTradeForArchive,
} from "./broker-execution-archive";
import { log } from "./logger";
import type { OrderActivityTracker } from "./order-activity-tracker";
import type { OtelMetrics } from "./otel";
import { asRecord } from "./shared/guards";

// ccxt method surface used by the poller (typed defensively — not every exchange
// build exposes fetchMyTrades).
type ExchangeWithTrades = {
	fetchMyTrades?: (
		symbol: string,
		since?: number,
		limit?: number,
		params?: Record<string, unknown>,
	) => Promise<unknown[]>;
	has?: Record<string, unknown>;
};

export type FillArchivePollerConfig = {
	// Constant defaults (no env vars): every broker env var must be allowlisted in a
	// Gramine manifest in another repo, so the poller intentionally introduces none.
	pollIntervalMs: number;
	// How far back the first poll of a (account, symbol) reaches. A restart loses the
	// in-memory cursor and re-scans this window; the resulting duplicate rows are
	// resolved by read-time dedup (fill_events is plain MergeTree, per contract).
	lookbackMs: number;
	tradesLimit: number;
};

const DEFAULT_CONFIG: FillArchivePollerConfig = {
	pollIntervalMs: 60_000,
	lookbackMs: 24 * 60 * 60 * 1000,
	tradesLimit: 500,
};

/**
 * Advances a since-cursor past the newest trade in a batch. The next poll asks for
 * trades strictly after the last one seen (+1ms) so the same trade is not refetched
 * every tick, while still tolerating out-of-order timestamps within a batch.
 */
export function nextFillCursor(
	trades: unknown[],
	currentSince: number,
): number {
	let next = currentSince;
	for (const trade of trades) {
		const ts = asRecord(trade)?.timestamp;
		if (typeof ts === "number" && Number.isFinite(ts) && ts + 1 > next) {
			next = ts + 1;
		}
	}
	return next;
}

/**
 * Broker-internal periodic capture of per-fill facts. For each (account, symbol)
 * that saw recent order activity it calls the venue trade-history endpoint
 * (fetchMyTrades) with a since-cursor and archives each trade to
 * broker_execution.fill_events. Started at bootstrap only when archiving is
 * enabled; symbols are staggered by sequential awaits so one tick never bursts the
 * venue rate limit. Mirrors the TravelRuleDepositReconciler lifecycle.
 */
export class FillArchivePoller {
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#running = false;
	// Per (exchange|account|symbol) last since-cursor (epoch ms). In-memory only.
	readonly #cursors = new Map<string, number>();
	readonly #config: FillArchivePollerConfig;

	constructor(
		private readonly params: {
			brokers: Record<string, BrokerPoolEntry>;
			archiver: BrokerExecutionArchiver;
			tracker: OrderActivityTracker;
			metrics?: OtelMetrics;
			config?: Partial<FillArchivePollerConfig>;
		},
	) {
		this.#config = { ...DEFAULT_CONFIG, ...params.config };
	}

	start(): void {
		if (this.#timer || this.#stopped) {
			return;
		}
		if (!this.params.archiver.isEnabled()) {
			return;
		}
		log.info("🧾 Fill archive poller started");
		this.#timer = setTimeout(() => void this.#tick(), 0);
		this.#timer.unref?.();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}

	async #tick(): Promise<void> {
		if (this.#stopped || this.#running) {
			return;
		}
		this.#running = true;
		try {
			await this.pollTrackedOnce();
		} catch (error) {
			log.error("Fill archive poller tick failed", error);
		} finally {
			this.#running = false;
			if (!this.#stopped) {
				this.#timer = setTimeout(
					() => void this.#tick(),
					this.#config.pollIntervalMs,
				);
				this.#timer.unref?.();
			}
		}
	}

	/**
	 * Runs one poll pass over every tracked (account, symbol), sequentially so the
	 * per-symbol awaits stagger venue calls. Exposed for tests (the timer loop calls
	 * it every tick).
	 */
	async pollTrackedOnce(): Promise<void> {
		for (const entry of this.params.tracker.list()) {
			if (this.#stopped) {
				break;
			}
			await this.#pollOne(entry.exchangeId, entry.accountLabel, entry.symbol);
		}
	}

	async #pollOne(
		exchangeId: string,
		accountLabel: string,
		symbol: string,
	): Promise<void> {
		const account = resolveBrokerAccount(
			this.params.brokers[exchangeId],
			accountLabel,
		);
		if (!account) {
			return;
		}
		const exchange = account.exchange as unknown as ExchangeWithTrades;
		if (
			typeof exchange.fetchMyTrades !== "function" ||
			exchange.has?.fetchMyTrades === false
		) {
			return;
		}

		const key = `${exchangeId}|${accountLabel}|${symbol}`;
		const since =
			this.#cursors.get(key) ?? Date.now() - this.#config.lookbackMs;

		let trades: unknown[];
		try {
			trades = await exchange.fetchMyTrades(
				symbol,
				since,
				this.#config.tradesLimit,
			);
		} catch (error) {
			void this.params.metrics?.recordCounter(
				"cex_fill_poller_errors_total",
				1,
				{
					exchange: exchangeId,
				},
			);
			log.warn("Fill archive poll failed", {
				exchange: exchangeId,
				account: accountLabel,
				symbol,
				error,
			});
			return;
		}
		if (!Array.isArray(trades) || trades.length === 0) {
			return;
		}

		trades.forEach((trade, fillIndex) => {
			const tags = buildCommonArchiveTags({
				deploymentId: this.params.archiver.getDeploymentId(),
				accountSelector: accountLabel,
				exchange: exchangeId,
				symbol,
			});
			this.params.archiver.enqueue(
				buildFillEventArchiveRow({
					tags,
					fill: { ...normalizeCcxtTradeForArchive(trade), fillIndex },
				}),
			);
		});
		void this.params.metrics?.recordCounter(
			"cex_fill_poller_trades_archived_total",
			trades.length,
			{ exchange: exchangeId },
		);
		this.#cursors.set(key, nextFillCursor(trades, since));
	}
}
