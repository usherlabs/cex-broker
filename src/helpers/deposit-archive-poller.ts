import type { BrokerAccount, BrokerPoolEntry } from "./broker";
import {
	type BrokerExecutionArchiver,
	buildCommonArchiveTags,
	buildTransferEventArchiveRow,
	normalizeCcxtTransactionForArchive,
	normalizeTimestamp,
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
	// time over (exchange, account, symbol, external_id, status). A Binance deposit
	// unlocking intentionally produces distinct credited_not_withdrawable and ok rows.
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

type LastArchivedDeposit = {
	status: string | undefined;
	timestamp: number | undefined;
};

function depositTimestamp(record: Record<string, unknown>): number | undefined {
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
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function archivedDepositStatus(
	exchangeId: string | undefined,
	record: Record<string, unknown>,
): string | undefined {
	const rawStatus = asRecord(record.info)?.status;
	if (
		exchangeId?.toLowerCase() === "binance" &&
		String(rawStatus ?? "").trim() === "6"
	) {
		return "credited_not_withdrawable";
	}
	return normalizeCcxtTransactionForArchive(record).status;
}

/**
 * Advances the inclusive since-watermark only across a fully observed,
 * terminal prefix of deposit history.
 */
export function nextDepositCursor(
	deposits: unknown[],
	currentSince: number,
	depositsLimit: number,
	exchangeId?: string,
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
		const timestamp = depositTimestamp(record);
		const archiveStatus = archivedDepositStatus(exchangeId, record);
		const status = normalizeDepositStatus(
			depositField(record, ["status", "state"]),
		);
		const isPending =
			archiveStatus === "credited_not_withdrawable" || status === "pending";
		if (timestamp === undefined) {
			if (isPending) {
				return currentSince;
			}
			continue;
		}
		if (isPending) {
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
	readonly #lastArchivedByTarget = new Map<
		string,
		Map<string, LastArchivedDeposit>
	>();
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
			const archiveStatus = archivedDepositStatus(target.exchangeId, record);
			const creditedAt = depositField(record, [
				"creditedAt",
				"credited_at",
				"updated",
				"updatedAt",
				"timestamp",
				"datetime",
			]);
			const depositTxid = txid === undefined ? undefined : String(txid);
			const lastArchived =
				depositTxid === undefined
					? undefined
					: this.#lastArchivedByTarget.get(key)?.get(depositTxid);
			if (lastArchived && lastArchived.status === archiveStatus) {
				continue;
			}

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
						exchangeTimestamp: normalizeTimestamp(creditedAt),
						payload: record,
					},
				}),
			);
			if (depositTxid !== undefined) {
				let targetDeposits = this.#lastArchivedByTarget.get(key);
				if (!targetDeposits) {
					targetDeposits = new Map();
					this.#lastArchivedByTarget.set(key, targetDeposits);
				}
				targetDeposits.set(depositTxid, {
					status: archiveStatus,
					timestamp: depositTimestamp(record),
				});
			}
			archived += 1;
		}

		if (archived > 0) {
			void this.params.metrics?.recordCounter(
				"cex_deposit_poller_deposits_archived_total",
				archived,
				{ exchange: target.exchangeId },
			);
		}
		const nextCursor = nextDepositCursor(
			deposits,
			since,
			this.#config.depositsLimit,
			target.exchangeId,
		);
		this.#cursors.set(key, nextCursor);
		const targetDeposits = this.#lastArchivedByTarget.get(key);
		if (targetDeposits) {
			for (const [externalId, lastArchived] of targetDeposits) {
				if (
					lastArchived.timestamp !== undefined &&
					lastArchived.timestamp < nextCursor
				) {
					targetDeposits.delete(externalId);
				}
			}
			if (targetDeposits.size === 0) {
				this.#lastArchivedByTarget.delete(key);
			}
		}
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
