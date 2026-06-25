const DEFAULT_ORDERBOOK_ARCHIVE_DEPTH_LIMIT = 25;
const MAX_ORDERBOOK_ARCHIVE_DEPTH_LIMIT = 500;

export function getOrderbookArchiveDepthLimit(): number {
	const raw = process.env.CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT;
	if (!raw) {
		return DEFAULT_ORDERBOOK_ARCHIVE_DEPTH_LIMIT;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_ORDERBOOK_ARCHIVE_DEPTH_LIMIT;
	}
	return Math.min(parsed, MAX_ORDERBOOK_ARCHIVE_DEPTH_LIMIT);
}

export function splitOrderBookSide(
	levels: number[][],
	limit: number,
): { prices: number[]; sizes: number[] } {
	const prices: number[] = [];
	const sizes: number[] = [];
	for (const level of levels.slice(0, limit)) {
		if (!Array.isArray(level) || level.length < 2) {
			continue;
		}
		const price = level[0];
		const size = level[1];
		if (!Number.isFinite(price) || !Number.isFinite(size)) {
			continue;
		}
		prices.push(price);
		sizes.push(size);
	}
	return { prices, sizes };
}
