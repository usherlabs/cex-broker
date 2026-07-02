export type ViewerConfig = {
	port: number;
	pollIntervalMs: number;
	clickhouse: {
		host: string;
		port: number;
		username: string;
		password: string;
		database: string;
	};
	defaults: {
		exchange: string;
		symbol: string;
		symbols: string[];
		timeframe: string;
		limit: number;
	};
};

const SUPPORTED_TIMEFRAMES = ["1m", "5m", "15m", "1h"] as const;

function parseSymbols(value: string | undefined): string[] {
	const raw =
		value?.trim() ||
		process.env.CANDLE_VIEWER_SYMBOLS?.trim() ||
		"BTC/USDT,BNB/USDT,DOGE/USDT";
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parsePort(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimeframe(value: string | undefined): string {
	const normalized = value?.trim() || "1m";
	return SUPPORTED_TIMEFRAMES.includes(
		normalized as (typeof SUPPORTED_TIMEFRAMES)[number],
	)
		? normalized
		: "1m";
}

export function loadViewerConfig(): ViewerConfig {
	return {
		port: parsePort(process.env.CANDLE_VIEWER_PORT, 8091),
		pollIntervalMs: parsePositiveInt(
			process.env.CANDLE_VIEWER_POLL_MS,
			500,
		),
		clickhouse: {
			host: process.env.CLICKHOUSE_HOST?.trim() || "localhost",
			port: parsePort(process.env.CLICKHOUSE_PORT, 18123),
			username: process.env.CLICKHOUSE_USER?.trim() || "default",
			password: process.env.CLICKHOUSE_PASSWORD ?? "",
			database: process.env.CLICKHOUSE_DATABASE?.trim() || "market_data",
		},
		defaults: {
			exchange: process.env.CANDLE_VIEWER_EXCHANGE?.trim() || "binance",
			symbol: process.env.CANDLE_VIEWER_SYMBOL?.trim() || "BTC/USDT",
			symbols: parseSymbols(process.env.CANDLE_VIEWER_SYMBOLS),
			timeframe: parseTimeframe(process.env.CANDLE_VIEWER_TIMEFRAME),
			limit: parsePositiveInt(process.env.CANDLE_VIEWER_LIMIT, 300),
		},
	};
}
