export const BASE_TIMEFRAME = "1m";

const TIMEFRAME_MS: Record<string, number> = {
	"1m": 60_000,
	"5m": 5 * 60_000,
	"15m": 15 * 60_000,
	"1h": 60 * 60_000,
};

export const SUPPORTED_TIMEFRAMES = Object.keys(TIMEFRAME_MS);

export function timeframeToMs(timeframe: string): number | null {
	return TIMEFRAME_MS[timeframe] ?? null;
}

export function timeframeMultiplier(requested: string): number {
	const baseMs = timeframeToMs(BASE_TIMEFRAME);
	const targetMs = timeframeToMs(requested);
	if (!baseMs || !targetMs || targetMs <= baseMs) {
		return 1;
	}
	return targetMs / baseMs;
}

export type RollupCandle = {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	isClosed: boolean;
	brokerVersion: number;
};

export function rollupCandles(
	candles: RollupCandle[],
	targetTimeframe: string,
): RollupCandle[] {
	const targetMs = timeframeToMs(targetTimeframe);
	const baseMs = timeframeToMs(BASE_TIMEFRAME);
	if (!targetMs || !baseMs || targetMs <= baseMs || candles.length === 0) {
		return candles;
	}

	const barsPerBucket = targetMs / baseMs;
	const buckets = new Map<number, RollupCandle[]>();

	for (const candle of candles) {
		const bucketMs =
			Math.floor((candle.time * 1000) / targetMs) * targetMs;
		const bucketTime = bucketMs / 1000;
		const bucket = buckets.get(bucketTime) ?? [];
		bucket.push(candle);
		buckets.set(bucketTime, bucket);
	}

	return [...buckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([time, bars]) => {
			bars.sort((a, b) => a.time - b.time);
			const open = bars[0].open;
			const close = bars[bars.length - 1].close;
			const high = Math.max(...bars.map((b) => b.high));
			const low = Math.min(...bars.map((b) => b.low));
			const volume = bars.reduce((sum, b) => sum + b.volume, 0);
			const isClosed =
				bars.length >= barsPerBucket && bars.every((b) => b.isClosed);
			const brokerVersion = Math.max(
				...bars.map((b) => b.brokerVersion ?? 0),
			);

			return { time, open, high, low, close, volume, isClosed, brokerVersion };
		});
}
