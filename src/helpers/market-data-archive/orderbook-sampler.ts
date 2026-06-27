const DEFAULT_ORDERBOOK_INTERVAL_MS = 1_000;

export function getOrderbookIntervalMs(): number {
	const raw =
		process.env.CEX_BROKER_ORDERBOOK_INTERVAL_MS ??
		process.env.CEX_BROKER_ORDERBOOK_TOB_INTERVAL_MS;
	if (!raw) {
		return DEFAULT_ORDERBOOK_INTERVAL_MS;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_ORDERBOOK_INTERVAL_MS;
}

export function isMarketArchiveEnabled(): boolean {
	return process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED !== "false";
}

export class OrderbookSampler {
	private lastEmitMs: number | null = null;

	constructor(private readonly intervalMs = getOrderbookIntervalMs()) {}

	shouldEmit(nowMs: number = Date.now()): boolean {
		if (this.lastEmitMs !== null && nowMs < this.lastEmitMs) {
			this.lastEmitMs = nowMs;
			return true;
		}
		if (this.lastEmitMs !== null && nowMs - this.lastEmitMs < this.intervalMs) {
			return false;
		}
		this.lastEmitMs = nowMs;
		return true;
	}
}

/** @deprecated Use getOrderbookIntervalMs */
export const getOrderbookTobIntervalMs = getOrderbookIntervalMs;

/** @deprecated Use OrderbookSampler */
export const OrderbookTobSampler = OrderbookSampler;
