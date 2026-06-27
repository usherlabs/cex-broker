import { describe, expect, test } from "bun:test";
import {
	candleFingerprint,
	toChartCandle,
	type CandleRow,
} from "../research/candle-viewer/candles";
import {
	PRICE_DECIMAL_PLACES,
	chartPriceFormat,
	formatPrice,
} from "../research/candle-viewer/format";
import {
	shouldReplaceCandleSeries,
	type SeriesSnapshot,
} from "../research/candle-viewer/chart-update";
import { rollupCandles } from "../research/candle-viewer/timeframes";

describe("candle viewer candles", () => {
	test("toChartCandle converts ms to unix seconds", () => {
		const row: CandleRow = {
			open_time_ms: 1_700_000_000_000,
			open: 100,
			high: 110,
			low: 90,
			close: 105,
			volume: 12.5,
			is_closed: 0,
			broker_version: 1,
		};
		expect(toChartCandle(row)).toEqual({
			time: 1_700_000_000,
			open: 100,
			high: 110,
			low: 90,
			close: 105,
			volume: 12.5,
			isClosed: false,
			brokerVersion: 1,
		});
	});

	test("toChartCandle rejects malformed numeric strings and negative uints", () => {
		const base: CandleRow = {
			open_time_ms: 1_700_000_000_000,
			open: 100,
			high: 110,
			low: 90,
			close: 105,
			volume: 12.5,
			is_closed: 0,
			broker_version: 1,
		};
		expect(toChartCandle({ ...base, open: "123abc" as unknown as number })).toBeNull();
		expect(toChartCandle({ ...base, open_time_ms: -1 })).toBeNull();
		expect(toChartCandle({ ...base, is_closed: 1.5 })).toBeNull();
	});

	test("candleFingerprint changes when close updates", () => {
		const base = {
			time: 1_700_000_000,
			open: 1,
			high: 2,
			low: 0.5,
			close: 1.5,
			volume: 10,
			isClosed: false,
			brokerVersion: 100,
		};
		const before = candleFingerprint([base]);
		const after = candleFingerprint([{ ...base, close: 1.6 }]);
		expect(before).not.toBe(after);
	});
});

describe("candle viewer price format", () => {
	test("uses 6 decimal places for sub-$2 assets like DOGE", () => {
		expect(formatPrice(0.07692)).toBe(
			(0.07692).toLocaleString(undefined, {
				minimumFractionDigits: 6,
				maximumFractionDigits: 6,
			}),
		);
	});

	test("chart price format uses 6dp min move", () => {
		expect(chartPriceFormat()).toEqual({
			type: "price",
			precision: PRICE_DECIMAL_PLACES,
			minMove: 0.000001,
		});
	});
});

describe("candle viewer chart update", () => {
	test("replaces series when the window slides but count stays fixed", () => {
		const previous: SeriesSnapshot = {
			count: 2,
			firstTime: 1_000,
			lastTime: 1_001,
		};
		const candles = [{ time: 1_001 }, { time: 1_002 }];
		expect(shouldReplaceCandleSeries(previous, candles)).toBe(true);
	});

	test("updates in place when only the forming bar time is unchanged", () => {
		const previous: SeriesSnapshot = {
			count: 2,
			firstTime: 1_000,
			lastTime: 1_060,
		};
		const candles = [{ time: 1_000 }, { time: 1_060 }];
		expect(shouldReplaceCandleSeries(previous, candles)).toBe(false);
	});

	test("replaces series when a new bar opens", () => {
		const previous: SeriesSnapshot = {
			count: 2,
			firstTime: 1_000,
			lastTime: 1_001,
		};
		const candles = [{ time: 1_000 }, { time: 1_002 }];
		expect(shouldReplaceCandleSeries(previous, candles)).toBe(true);
	});
});

describe("candle viewer rollups", () => {
	test("rollupCandles carries brokerVersion from source bars", () => {
		const rolled = rollupCandles(
			[
				{
					time: 1_700_000_000,
					open: 1,
					high: 2,
					low: 0.5,
					close: 1.5,
					volume: 10,
					isClosed: true,
					brokerVersion: 100,
				},
				{
					time: 1_700_000_060,
					open: 1.5,
					high: 2.5,
					low: 1.4,
					close: 2,
					volume: 12,
					isClosed: false,
					brokerVersion: 200,
				},
			],
			"5m",
		);
		expect(rolled).toHaveLength(1);
		expect(rolled[0]?.brokerVersion).toBe(200);
	});
});
