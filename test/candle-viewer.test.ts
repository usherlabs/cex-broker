import { describe, expect, test } from "bun:test";
import {
	candleFingerprint,
	toChartCandle,
	type CandleRow,
} from "../research/candle-viewer/candles";

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
		});
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
		};
		const before = candleFingerprint([base]);
		const after = candleFingerprint([{ ...base, close: 1.6 }]);
		expect(before).not.toBe(after);
	});
});
