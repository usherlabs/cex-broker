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
	brokerVersion: number;
};

export type CandleQuery = {
	exchange: string;
	symbol: string;
	timeframe: string;
	limit: number;
};

function parseFiniteNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number.parseFloat(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
}

function toUInt(value: unknown): number | null {
	const parsed = parseFiniteNumber(value);
	return parsed === null ? null : Math.trunc(parsed);
}

export function toChartCandle(row: CandleRow): ChartCandle | null {
	const open = parseFiniteNumber(row.open);
	const high = parseFiniteNumber(row.high);
	const low = parseFiniteNumber(row.low);
	const close = parseFiniteNumber(row.close);
	const volume = parseFiniteNumber(row.volume);
	const openTimeMs = toUInt(row.open_time_ms);
	const isClosed = toUInt(row.is_closed);
	const brokerVersion = toUInt(row.broker_version);
	if (
		open === null ||
		high === null ||
		low === null ||
		close === null ||
		volume === null ||
		openTimeMs === null ||
		isClosed === null ||
		brokerVersion === null
	) {
		return null;
	}
	return {
		time: Math.trunc(openTimeMs / 1000),
		open,
		high,
		low,
		close,
		volume,
		isClosed: isClosed === 1,
		brokerVersion,
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
				`${c.time}:${c.open}:${c.high}:${c.low}:${c.close}:${c.volume}:${c.isClosed}:${c.brokerVersion}`,
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
				open_time_ms: row.open_time_ms,
				open: row.open,
				high: row.high,
				low: row.low,
				close: row.close,
				volume: row.volume,
				is_closed: row.is_closed,
				broker_version: row.broker_version,
			}),
		)
		.filter((candle): candle is ChartCandle => candle !== null)
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
	const baseLimit = Math.trunc(query.limit * multiplier);

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
