import type { RowInserter } from "./insert";
import type { ArchiveForwarderTelemetry } from "./telemetry";
import { classifyInsertError } from "./telemetry";
import type { StrategyArchiveSpool } from "./strategy-spool";

const RETRY_CAP_MS = 60_000;
const RETRY_JITTER = 0.2;

export function retryDelayMs(
	attemptCount: number,
	random: () => number = Math.random,
): number {
	const base = Math.min(RETRY_CAP_MS, 1_000 * 2 ** attemptCount);
	const jitterFactor = 1 - RETRY_JITTER + random() * RETRY_JITTER * 2;
	return Math.round(base * jitterFactor);
}

function isPermanentError(errorClass: string): boolean {
	return errorClass === "schema" || errorClass === "authentication";
}

export type StrategyWorkerOptions = {
	spool: StrategyArchiveSpool;
	inserter: RowInserter;
	telemetry?: ArchiveForwarderTelemetry;
	now?: () => number;
	random?: () => number;
	pollIntervalMs?: number;
};

export type StrategyDrainResult = {
	completed: number;
	retried: number;
	terminal: number;
	expired: number;
};

export class StrategySpoolWorker {
	private readonly spool: StrategyArchiveSpool;
	private readonly inserter: RowInserter;
	private readonly telemetry?: ArchiveForwarderTelemetry;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly pollIntervalMs: number;
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = true;
	private draining = false;

	constructor(options: StrategyWorkerOptions) {
		this.spool = options.spool;
		this.inserter = options.inserter;
		this.telemetry = options.telemetry;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.pollIntervalMs = options.pollIntervalMs ?? 250;
	}

	public async drainOnce(): Promise<StrategyDrainResult> {
		const result: StrategyDrainResult = {
			completed: 0,
			retried: 0,
			terminal: 0,
			expired: this.spool.expire(),
		};
		if (result.expired > 0) {
			this.telemetry?.recordStrategyExpired(result.expired);
			this.telemetry?.recordStrategySpoolStats(this.spool.stats());
		}
		for (const work of this.spool.dueWork()) {
			try {
				await this.inserter(work.table, work.rows, {
					deduplicationToken: work.dedupeToken,
				});
				this.spool.complete(work);
				this.telemetry?.recordRowsInserted(work.table, work.rows.length);
				this.telemetry?.recordSuccessfulFlush();
				this.telemetry?.recordStrategyTableCompletion(work.table);
				result.completed += 1;
			} catch (error) {
				const errorClass = classifyInsertError(error);
				this.telemetry?.recordInsertFailure(work.table, error);
				if (isPermanentError(errorClass)) {
					this.spool.markTerminal(work, errorClass);
					this.telemetry?.recordStrategyTerminalFailure(
						work.table,
						errorClass,
					);
					result.terminal += 1;
					continue;
				}
				this.spool.reschedule(work, {
					nextAttemptAtMs:
						this.now() + retryDelayMs(work.attemptCount, this.random),
					errorClass,
				});
				this.telemetry?.recordStrategyRetry(work.table, errorClass);
				result.retried += 1;
			}
		}
		this.telemetry?.recordStrategySpoolStats(this.spool.stats());
		return result;
	}

	public start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.schedule(0);
	}

	private schedule(delayMs: number): void {
		if (this.stopped) return;
		this.timer = setTimeout(() => {
			void this.tick();
		}, delayMs);
		this.timer.unref?.();
	}

	private async tick(): Promise<void> {
		if (this.stopped || this.draining) return;
		this.draining = true;
		try {
			await this.drainOnce();
		} catch (error) {
			console.error("Strategy archive spool drain failed:", error);
		} finally {
			this.draining = false;
			this.schedule(this.pollIntervalMs);
		}
	}

	public stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
