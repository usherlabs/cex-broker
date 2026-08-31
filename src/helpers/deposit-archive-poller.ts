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
	// Bounds the venue call. A fetchDeposits promise that never settles would
	// strand #pollOne forever: no error, no metric, no reschedule — the one
	// poller death mode that leaves no trace at all. The bound converts it into
	// an ordinary poll failure, which is already observable.
	fetchTimeoutMs: number;
	// How far back the first poll of an account reaches. A restart loses the
	// in-memory cursor and re-scans this window; duplicate rows are acceptable
	// because transfer_events is plain MergeTree and consumers deduplicate at read
	// time over the full transfer identity plus the observed progress. A Binance
	// deposit can therefore produce multiple rows before it becomes withdrawable.
	lookbackMs: number;
	depositsLimit: number;
};

const DEFAULT_CONFIG: DepositArchivePollerConfig = {
	pollIntervalMs: 60_000,
	fetchTimeoutMs: 30_000,
	lookbackMs: 24 * 60 * 60 * 1000,
	depositsLimit: 50,
};

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		timer.unref?.();
	});
	return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

const ALL_CURRENCIES_CODE = "*";

type DepositPollTarget = {
	exchangeId: string;
	account: BrokerAccount;
	code: typeof ALL_CURRENCIES_CODE;
};

type PollOutcome = "ok" | "error" | "unsupported";

type BinanceUnlockProgressState =
	| "pending"
	| "credited_not_withdrawable"
	| "ok"
	| "failed"
	| "unknown";

type BinanceUnlockProgressQuality = "valid" | "unknown" | "contradictory";

const BINANCE_UNLOCK_PROGRESS_SOURCE = {
	venue: "binance",
	endpoint: "GET /sapi/v1/capital/deposit/hisrec",
	fields: {
		status: "info.status",
		confirmTimes: "info.confirmTimes",
		unlockConfirm: "info.unlockConfirm",
		completeTime: "info.completeTime",
	},
} as const;

export type BinanceUnlockProgress = {
	version: 1;
	state: BinanceUnlockProgressState;
	progress_state: BinanceUnlockProgressQuality;
	reason: string | null;
	native_status: number | null;
	current: number | null;
	credit_required: number | null;
	unlock_required: number | null;
	complete_time: number | null;
	observed_at: string;
	source: typeof BINANCE_UNLOCK_PROGRESS_SOURCE;
};

type UnlockProgressWatermark = {
	current: number;
	credit_required: number;
	unlock_required: number;
};

type LastArchivedDeposit = {
	status: string | undefined;
	timestamp: number | undefined;
	progressKey: string | undefined;
	highWatermark: UnlockProgressWatermark | undefined;
};

type DepositClassification = {
	archiveStatus: string;
	holdCursor: boolean;
	unlockProgress?: BinanceUnlockProgress;
	progressKey?: string;
	highWatermark?: UnlockProgressWatermark;
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

function parseNonNegativeInteger(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseConfirmTimes(value: unknown): {
	current?: number;
	creditRequired?: number;
	reason: string | null;
} {
	if (value === undefined || value === null) {
		return { reason: "missing_confirmTimes" };
	}

	let currentValue: unknown;
	let creditRequiredValue: unknown;
	if (typeof value === "string") {
		const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
		if (!match) {
			return { reason: "invalid_confirmTimes" };
		}
		currentValue = match[1];
		creditRequiredValue = match[2];
	} else {
		const record = asRecord(value);
		if (!record) {
			return { reason: "invalid_confirmTimes" };
		}
		currentValue = record.current;
		creditRequiredValue = record.credit_required;
	}

	const current = parseNonNegativeInteger(currentValue);
	const creditRequired = parseNonNegativeInteger(creditRequiredValue);
	if (current === undefined || creditRequired === undefined) {
		return { reason: "invalid_confirmTimes" };
	}
	return { current, creditRequired, reason: null };
}

function parseOptionalNonNegativeInteger(
	value: unknown,
	fieldName: string,
): { value: number | undefined; reason: string | null } {
	if (value === undefined || value === null) {
		return { value: undefined, reason: null };
	}
	const parsed = parseNonNegativeInteger(value);
	return parsed === undefined
		? { value: undefined, reason: `invalid_${fieldName}` }
		: { value: parsed, reason: null };
}

/**
 * Extracts Binance's native deposit confirmation fields without trusting
 * ccxt's normalized status. `confirmTimes` is normally the venue string
 * `"current/credit_required"`; the object form is accepted only for callers
 * that already decoded that exact field.
 */
export function parseBinanceUnlockProgress(
	record: Record<string, unknown>,
): BinanceUnlockProgress {
	const info = asRecord(record.info);
	const nativeStatus = parseNonNegativeInteger(info?.status);
	const confirmations = parseConfirmTimes(info?.confirmTimes);
	const unlockRequired = parseOptionalNonNegativeInteger(
		info?.unlockConfirm,
		"unlockConfirm",
	);
	const completeTime = parseOptionalNonNegativeInteger(
		info?.completeTime,
		"completeTime",
	);

	let quality: BinanceUnlockProgressQuality = "valid";
	let reason: string | null = null;
	if (nativeStatus === undefined) {
		quality = "unknown";
		reason = "missing_or_invalid_status";
	} else if (confirmations.reason !== null) {
		quality = "unknown";
		reason = confirmations.reason;
	} else if (unlockRequired.reason !== null) {
		quality = "unknown";
		reason = unlockRequired.reason;
	} else if (completeTime.reason !== null) {
		quality = "unknown";
		reason = completeTime.reason;
	}

	let state: BinanceUnlockProgressState = "unknown";
	switch (nativeStatus) {
		case 0:
			state = "pending";
			break;
		case 1:
			if (
				quality === "valid" &&
				confirmations.current !== undefined &&
				unlockRequired.value !== undefined &&
				confirmations.current >= unlockRequired.value
			) {
				state = "ok";
			} else if (quality === "valid") {
				state = "credited_not_withdrawable";
			}
			break;
		case 2:
		case 7:
			state = "failed";
			break;
		case 6:
			state = "credited_not_withdrawable";
			break;
		case 8:
			state = "pending";
			break;
		default:
			quality = "unknown";
			reason = "unsupported_status";
			break;
	}

	return {
		version: 1,
		state,
		progress_state: quality,
		reason,
		native_status: nativeStatus ?? null,
		current: confirmations.current ?? null,
		credit_required: confirmations.creditRequired ?? null,
		unlock_required: unlockRequired.value ?? null,
		complete_time: completeTime.value ?? null,
		observed_at: new Date().toISOString(),
		source: BINANCE_UNLOCK_PROGRESS_SOURCE,
	};
}

function unlockProgressKey(progress: BinanceUnlockProgress): string {
	return JSON.stringify({
		version: progress.version,
		state: progress.state,
		progress_state: progress.progress_state,
		reason: progress.reason,
		native_status: progress.native_status,
		current: progress.current,
		credit_required: progress.credit_required,
		unlock_required: progress.unlock_required,
		complete_time: progress.complete_time,
	});
}

function progressWatermark(
	progress: BinanceUnlockProgress,
	previous: UnlockProgressWatermark | undefined,
): UnlockProgressWatermark | undefined {
	if (
		progress.progress_state !== "valid" ||
		progress.current === null ||
		progress.credit_required === null ||
		progress.unlock_required === null
	) {
		return previous;
	}
	return {
		current: Math.max(previous?.current ?? 0, progress.current),
		credit_required: progress.credit_required,
		unlock_required: progress.unlock_required,
	};
}

function classifyBinanceDeposit(
	record: Record<string, unknown>,
	previous: LastArchivedDeposit | undefined,
): DepositClassification {
	let progress = parseBinanceUnlockProgress(record);
	let highWatermark = previous?.highWatermark;
	if (
		progress.progress_state === "valid" &&
		progress.current !== null &&
		progress.credit_required !== null &&
		progress.unlock_required !== null &&
		previous?.highWatermark !== undefined &&
		(progress.current < previous.highWatermark.current ||
			progress.credit_required !== previous.highWatermark.credit_required ||
			progress.unlock_required !== previous.highWatermark.unlock_required)
	) {
		progress = {
			...progress,
			state: "unknown",
			progress_state: "contradictory",
			reason: "confirmation_progress_regressed_or_requirement_changed",
		};
	} else {
		highWatermark = progressWatermark(progress, previous?.highWatermark);
	}

	return {
		archiveStatus: progress.state,
		holdCursor:
			progress.state === "pending" ||
			progress.state === "credited_not_withdrawable" ||
			progress.state === "unknown",
		unlockProgress: progress,
		progressKey: unlockProgressKey(progress),
		highWatermark,
	};
}

function classifyDeposit(
	exchangeId: string | undefined,
	record: Record<string, unknown>,
	previous?: LastArchivedDeposit,
): DepositClassification {
	if (exchangeId?.toLowerCase() === "binance") {
		return classifyBinanceDeposit(record, previous);
	}
	const archiveStatus = normalizeCcxtTransactionForArchive(record).status ?? "";
	const status = normalizeDepositStatus(
		depositField(record, ["status", "state"]),
	);
	return {
		archiveStatus,
		holdCursor:
			archiveStatus === "credited_not_withdrawable" || status === "pending",
		progressKey: JSON.stringify({ status: archiveStatus }),
	};
}

function depositIdentity(input: {
	exchangeId: string;
	accountSelector: string;
	coin: unknown;
	network: unknown;
	externalId: string | undefined;
	txid: string | undefined;
}): string | undefined {
	if (input.externalId === undefined && input.txid === undefined) {
		return undefined;
	}
	return JSON.stringify({
		exchange: input.exchangeId,
		account: input.accountSelector,
		coin: input.coin === undefined ? "" : String(input.coin),
		network: input.network === undefined ? "" : String(input.network),
		external_id: input.externalId ?? "",
		txid: input.txid ?? "",
	});
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
		const classification = classifyDeposit(exchangeId, record);
		const isPending = classification.holdCursor;
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

	// The heartbeat is the only signal that separates a healthy-idle poller from a
	// hung one: the archive and error counters are both silent on a quiet venue.
	// It therefore records on every exit, including an unexpected throw, which is
	// why the outcome starts pessimistic and is only narrowed by a completed poll.
	async #pollOne(target: DepositPollTarget): Promise<void> {
		let outcome: PollOutcome = "error";
		try {
			outcome = await this.#pollTarget(target);
		} finally {
			void this.params.metrics?.recordCounter(
				"cex_deposit_poller_polls_total",
				1,
				{ exchange: target.exchangeId, outcome },
			);
		}
	}

	async #pollTarget(target: DepositPollTarget): Promise<PollOutcome> {
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
			return "unsupported";
		}

		const since =
			this.#cursors.get(key) ?? Date.now() - this.#config.lookbackMs;
		let deposits: unknown[];
		try {
			deposits = await withTimeout(
				exchange.fetchDeposits(undefined, since, this.#config.depositsLimit),
				this.#config.fetchTimeoutMs,
				"fetchDeposits",
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
			return "error";
		}
		if (!Array.isArray(deposits) || deposits.length === 0) {
			return "ok";
		}

		let archived = 0;
		for (const deposit of deposits) {
			const record = asRecord(deposit);
			if (!record) {
				continue;
			}
			const info = asRecord(record.info);
			const assetSymbol =
				depositField(record, ["currency", "code", "asset"]) ?? info?.coin;
			const amount = depositField(record, ["amount"]);
			const address = depositField(record, [
				"address",
				"recipientAddress",
				"to",
				"destination",
			]);
			const txid = depositField(record, ["txid", "txId", "tx_hash", "txHash"]);
			const network =
				depositField(record, ["network", "chain"]) ?? info?.network;
			const depositTxid = txid === undefined ? undefined : String(txid);
			const identity = depositIdentity({
				exchangeId: target.exchangeId,
				accountSelector: target.account.label,
				coin: assetSymbol,
				network,
				externalId: depositTxid,
				txid: depositTxid,
			});
			const lastArchived =
				identity === undefined
					? undefined
					: this.#lastArchivedByTarget.get(key)?.get(identity);
			const classification = classifyDeposit(
				target.exchangeId,
				record,
				lastArchived,
			);
			if (
				lastArchived &&
				lastArchived.status === classification.archiveStatus &&
				lastArchived.progressKey === classification.progressKey
			) {
				continue;
			}
			const creditedAt = depositField(record, [
				"creditedAt",
				"credited_at",
				"updated",
				"updatedAt",
				"timestamp",
				"datetime",
			]);
			const payload =
				classification.unlockProgress === undefined
					? record
					: { ...record, unlock_progress: classification.unlockProgress };

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
						status: classification.archiveStatus,
						amount: amount === undefined ? undefined : String(amount),
						address: address === undefined ? undefined : String(address),
						network: network === undefined ? undefined : String(network),
						externalId: depositTxid,
						txid: depositTxid,
						exchangeTimestamp: normalizeTimestamp(creditedAt),
						payload,
					},
				}),
			);
			if (identity !== undefined) {
				let targetDeposits = this.#lastArchivedByTarget.get(key);
				if (!targetDeposits) {
					targetDeposits = new Map();
					this.#lastArchivedByTarget.set(key, targetDeposits);
				}
				targetDeposits.set(identity, {
					status: classification.archiveStatus,
					timestamp: depositTimestamp(record),
					progressKey: classification.progressKey,
					highWatermark: classification.highWatermark,
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
		return "ok";
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
