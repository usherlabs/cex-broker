import type { ClickHouseClient } from "@clickhouse/client";
import {
	BASE_TIMEFRAME,
	rollupCandles,
	timeframeMultiplier,
	timeframeToMs,
} from "./timeframes";

export type CandleRow = {
	open_time_ms: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	is_closed: number;
	broker_version: number;
};

export type ChartCandle = {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	isClosed: boolean;
};

export type CandleQuery = {
	exchange: string;
	symbol: string;
	timeframe: string;
	limit: number;
};

function toNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return 0;
}

function toUInt(value: unknown): number {
	return Math.trunc(toNumber(value));
}

export function toChartCandle(row: CandleRow): ChartCandle {
	return {
		time: Math.trunc(row.open_time_ms / 1000),
		open: row.open,
		high: row.high,
		low: row.low,
		close: row.close,
		volume: row.volume,
		isClosed: row.is_closed === 1,
	};
}

export function candleFingerprint(candles: ChartCandle[]): string {
	if (candles.length === 0) {
		return "";
	}
	const last = candles[candles.length - 1];
	return candles
		.map(
			(c) =>
				`${c.time}:${c.open}:${c.high}:${c.low}:${c.close}:${c.volume}:${c.isClosed}`,
		)
		.join("|");
}

export async function fetchRawCandles(
	client: ClickHouseClient,
	query: CandleQuery,
	timeframe: string,
): Promise<ChartCandle[]> {
	const result = await client.query({
		query: `
			SELECT
				open_time_ms,
				open,
				high,
				low,
				close,
				volume,
				is_closed,
				broker_version
			FROM candles FINAL
			WHERE exchange = {exchange:String}
				AND symbol = {symbol:String}
				AND timeframe = {timeframe:String}
			ORDER BY open_time_ms DESC
			LIMIT {limit:UInt32}
		`,
		query_params: {
			exchange: query.exchange.toLowerCase(),
			symbol: query.symbol,
			timeframe,
			limit: query.limit,
		},
		format: "JSONEachRow",
	});

	const rows = (await result.json()) as CandleRow[];
	return rows
		.map((row) =>
			toChartCandle({
				open_time_ms: toUInt(row.open_time_ms),
				open: toNumber(row.open),
				high: toNumber(row.high),
				low: toNumber(row.low),
				close: toNumber(row.close),
				volume: toNumber(row.volume),
				is_closed: toUInt(row.is_closed),
				broker_version: toUInt(row.broker_version),
			}),
		)
		.sort((a, b) => a.time - b.time);
}

export async function fetchCandles(
	client: ClickHouseClient,
	query: CandleQuery,
): Promise<ChartCandle[]> {
	const requestedTimeframe = query.timeframe;
	if (!timeframeToMs(requestedTimeframe)) {
		return [];
	}

	const multiplier = timeframeMultiplier(requestedTimeframe);
	const baseLimit = Math.min(
		Math.trunc(query.limit * multiplier),
		10_000,
	);

	const baseCandles = await fetchRawCandles(
		client,
		{ ...query, limit: baseLimit },
		BASE_TIMEFRAME,
	);

	if (multiplier === 1) {
		return baseCandles.slice(-query.limit);
	}

	return rollupCandles(baseCandles, requestedTimeframe).slice(-query.limit);
}
