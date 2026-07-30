import type { BrokerAccount, BrokerPoolEntry } from "./broker";
import {
	type BrokerExecutionArchiver,
	buildCommonArchiveTags,
	buildTransferEventArchiveRow,
	normalizeCcxtTransactionForArchive,
	rethrowArchiveDurabilityError,
} from "./broker-execution-archive";
import { depositField, normalizeDepositStatus } from "./deposit";
import { log } from "./logger";
import type { OtelMetrics } from "./otel";
import { asRecord } from "./shared/guards";

// ccxt method surface used by the poller (typed defensively — not every exchange
// build exposes fetchDeposits).
type ExchangeWithDeposits = {
	fetchDeposits?: (
		code?: string,
		since?: number,
		limit?: number,
		params?: Record<string, unknown>,
	) => Promise<unknown[]>;
	has?: Record<string, unknown>;
};

export type DepositArchivePollerConfig = {
	// Constant defaults (no env vars): every broker env var must be allowlisted in a
	// Gramine manifest in another repo, so the poller intentionally introduces none.
	pollIntervalMs: number;
	// How far back the first poll of an account reaches. A restart loses the
	// in-memory cursor and re-scans this window; duplicate rows are acceptable
	// because transfer_events is plain MergeTree and consumers deduplicate at read
	// time over (exchange, account, symbol, external_id, status).
	lookbackMs: number;
	depositsLimit: number;
};

const DEFAULT_CONFIG: DepositArchivePollerConfig = {
	pollIntervalMs: 60_000,
	lookbackMs: 24 * 60 * 60 * 1000,
	depositsLimit: 50,
};

const ALL_CURRENCIES_CODE = "*";

type DepositPollTarget = {
	exchangeId: string;
	account: BrokerAccount;
	code: typeof ALL_CURRENCIES_CODE;
};

/**
 * Advances the inclusive since-watermark only across a fully observed,
 * terminal prefix of deposit history.
 */
export function nextDepositCursor(
	deposits: unknown[],
	currentSince: number,
	depositsLimit: number,
): number {
	// A full batch may be either end of a truncated window. Without a portable
	// ccxt pagination boundary, moving the watermark could permanently skip the
	// unseen side of a newest-first response.
	if (deposits.length >= depositsLimit) {
		return currentSince;
	}

	let next = currentSince;
	let oldestPending = Number.POSITIVE_INFINITY;
	for (const deposit of deposits) {
		const record = asRecord(deposit);
		if (!record) {
			return currentSince;
		}
		const observedAt = depositField(record, [
			"timestamp",
			"creditedAt",
			"credited_at",
			"updated",
			"updatedAt",
			"datetime",
		]);
		const timestamp =
			typeof observedAt === "number"
				? observedAt
				: typeof observedAt === "string"
					? Date.parse(observedAt)
					: Number.NaN;
		const status = normalizeDepositStatus(
			depositField(record, ["status", "state"]),
		);
		if (!Number.isFinite(timestamp)) {
			if (status === "pending") {
				return currentSince;
			}
			continue;
		}
		if (status === "pending") {
			oldestPending = Math.min(oldestPending, timestamp);
		} else {
			next = Math.max(next, timestamp + 1);
		}
	}
	return Number.isFinite(oldestPending)
		? Math.max(currentSince, oldestPending)
		: next;
}

/**
 * Broker-internal periodic capture of venue deposit history. It polls every
 * configured account sequentially, using ccxt's unfiltered deposit-history
 * surface so newly funded currencies do not depend on balance or market
 * discovery.
 */
export class DepositArchivePoller {
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#running: Promise<boolean> | null = null;
	readonly #cursors = new Map<string, number>();
	readonly #unsupportedLogged = new Set<string>();
	readonly #config: DepositArchivePollerConfig;

	constructor(
		private readonly params: {
			brokers: Record<string, BrokerPoolEntry>;
			archiver: BrokerExecutionArchiver;
			metrics?: OtelMetrics;
			config?: Partial<DepositArchivePollerConfig>;
		},
	) {
		this.#config = { ...DEFAULT_CONFIG, ...params.config };
	}

	start(): void {
		if (this.#timer || this.#stopped || !this.params.archiver.isEnabled()) {
			return;
		}
		log.info("📥 Deposit archive poller started");
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
		if (this.#stopped || this.#running || !this.params.archiver.isEnabled()) {
			return false;
		}
		this.#running = this.#pollAllSequentially();
		try {
			return await this.#running;
		} finally {
			this.#running = null;
		}
	}

	#targets(): DepositPollTarget[] {
		const targets: DepositPollTarget[] = [];
		for (const [exchangeId, pool] of Object.entries(this.params.brokers)) {
			for (const account of [pool.primary, ...pool.secondaryBrokers]) {
				targets.push({
					exchangeId,
					account,
					code: ALL_CURRENCIES_CODE,
				});
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

	async #pollOne(target: DepositPollTarget): Promise<void> {
		const exchange = target.account.exchange as unknown as ExchangeWithDeposits;
		const key = this.#targetKey(target);
		if (
			typeof exchange.fetchDeposits !== "function" ||
			exchange.has?.fetchDeposits === false
		) {
			if (!this.#unsupportedLogged.has(key)) {
				this.#unsupportedLogged.add(key);
				log.info("Deposit archive poll skipped: fetchDeposits unsupported", {
					exchange: target.exchangeId,
					account: target.account.label,
				});
			}
			return;
		}

		const since =
			this.#cursors.get(key) ?? Date.now() - this.#config.lookbackMs;
		let deposits: unknown[];
		try {
			deposits = await exchange.fetchDeposits(
				undefined,
				since,
				this.#config.depositsLimit,
			);
		} catch (error) {
			void this.params.metrics?.recordCounter(
				"cex_deposit_poller_errors_total",
				1,
				{ exchange: target.exchangeId },
			);
			log.warn("Deposit archive poll failed", {
				exchange: target.exchangeId,
				account: target.account.label,
				error,
			});
			return;
		}
		if (!Array.isArray(deposits) || deposits.length === 0) {
			return;
		}

		let archived = 0;
		for (const deposit of deposits) {
			const record = asRecord(deposit);
			if (!record) {
				continue;
			}
			const assetSymbol = depositField(record, ["currency", "code", "asset"]);
			const amount = depositField(record, ["amount"]);
			const address = depositField(record, [
				"address",
				"recipientAddress",
				"to",
				"destination",
			]);
			const txid = depositField(record, ["txid", "txId", "tx_hash", "txHash"]);
			const network = depositField(record, ["network", "chain"]);
			const archiveStatus = normalizeCcxtTransactionForArchive(record).status;
			const creditedAt = depositField(record, [
				"creditedAt",
				"credited_at",
				"updated",
				"updatedAt",
				"timestamp",
				"datetime",
			]);
			const depositTxid = txid === undefined ? undefined : String(txid);

			this.params.archiver.enqueue(
				buildTransferEventArchiveRow({
					tags: buildCommonArchiveTags({
						deploymentId: this.params.archiver.getDeploymentId(),
						accountSelector: target.account.label,
						exchange: target.exchangeId,
						symbol: assetSymbol === undefined ? undefined : String(assetSymbol),
					}),
					transfer: {
						eventKind: "deposit",
						lifecycleAction: "observe_deposit",
						status: archiveStatus,
						amount: amount === undefined ? undefined : String(amount),
						address: address === undefined ? undefined : String(address),
						network: network === undefined ? undefined : String(network),
						externalId: depositTxid,
						txid: depositTxid,
						exchangeTimestamp:
							typeof creditedAt === "string" ? creditedAt : undefined,
						payload: record,
					},
				}),
			);
			archived += 1;
		}

		if (archived > 0) {
			void this.params.metrics?.recordCounter(
				"cex_deposit_poller_deposits_archived_total",
				archived,
				{ exchange: target.exchangeId },
			);
		}
		this.#cursors.set(
			key,
			nextDepositCursor(deposits, since, this.#config.depositsLimit),
		);
	}

	#targetKey(target: DepositPollTarget): string {
		return `${target.exchangeId}|${target.account.label}|${target.code}`;
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
			log.error("Deposit archive poller tick failed", error);
		} finally {
			if (!this.#stopped) {
				this.#schedule(this.#config.pollIntervalMs);
			}
		}
	}
}
