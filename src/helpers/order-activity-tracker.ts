export type OrderActivityEntry = {
	exchangeId: string;
	accountLabel: string;
	symbol: string;
	lastActivityAt: number;
};

// Entries not touched within this window are dropped from the poll set: their
// trades have long since been archived and re-polling them wastes venue rate limit.
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Records the (exchange, account, symbol) tuples that saw order activity through
 * the execute-action path, so the fill poller scans only those markets instead of
 * the whole exchange. Process-lifetime, in-memory only (no persistence needed: on
 * restart the poller re-derives the set from fresh order activity and read-time
 * dedup absorbs the lookback re-scan).
 */
export class OrderActivityTracker {
	readonly #entries = new Map<string, OrderActivityEntry>();
	readonly #maxAgeMs: number;

	constructor(options?: { maxAgeMs?: number }) {
		this.#maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	}

	record(
		exchangeId: string,
		accountLabel: string,
		symbol: string,
		now: number = Date.now(),
	): void {
		const exchange = exchangeId.trim().toLowerCase();
		const trimmedSymbol = symbol.trim();
		if (!exchange || !accountLabel.trim() || !trimmedSymbol) {
			return;
		}
		const key = `${exchange}|${accountLabel}|${trimmedSymbol}`;
		this.#entries.set(key, {
			exchangeId: exchange,
			accountLabel,
			symbol: trimmedSymbol,
			lastActivityAt: now,
		});
	}

	/** Active entries (seen within maxAge). Prunes stale entries as a side effect. */
	list(now: number = Date.now()): OrderActivityEntry[] {
		const active: OrderActivityEntry[] = [];
		for (const [key, entry] of this.#entries) {
			if (now - entry.lastActivityAt > this.#maxAgeMs) {
				this.#entries.delete(key);
				continue;
			}
			active.push(entry);
		}
		return active;
	}
}
