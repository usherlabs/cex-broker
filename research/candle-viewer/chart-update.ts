export type CandleTimePoint = {
	time: number;
};

export type SeriesSnapshot = {
	count: number;
	firstTime: number | null;
	lastTime: number | null;
};

export function shouldReplaceCandleSeries(
	previous: SeriesSnapshot,
	candles: CandleTimePoint[],
): boolean {
	if (candles.length === 0) {
		return true;
	}
	if (previous.firstTime === null || previous.count === 0) {
		return true;
	}
	const first = candles[0].time;
	const last = candles[candles.length - 1].time;
	return (
		candles.length !== previous.count ||
		first !== previous.firstTime ||
		last !== previous.lastTime
	);
}
