#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CanonicalMarketReplayWindow = {
	clickhouseUrl: string;
	captureBundleIds: string[];
	exchange: string;
	tradingPair: string;
	startTimeMs: number;
	endTimeMs: number;
	username?: string;
	password?: string;
};

export type CanonicalOrderBookParquetExport = CanonicalMarketReplayWindow & {
	outputDirectory: string;
};

export type CanonicalOrderBookParquetExportResult = {
	levelsPath: string;
	summaryPath: string;
	levelRows: number;
	summaryRows: number;
	promotionReceiptIds: string[];
};

export type CanonicalMarketReplayValidation = {
	rawRowsByFeed: Record<"ORDERBOOK" | "TICKER" | "TRADES" | "OHLCV", number>;
	normalizedRows: {
		levels: number;
		summaries: number;
		tickers: number;
		trades: number;
		ohlcv: number;
	};
};

type HttpQuery = {
	endpoint: URL;
	headers: Record<string, string>;
	parameters: Record<string, string>;
};

function clickHouseArray(values: string[]): string {
	return `[${values
		.map(
			(value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`,
		)
		.join(",")}]`;
}

function validateInput(input: CanonicalMarketReplayWindow): void {
	if (input.captureBundleIds.length === 0) {
		throw new Error("At least one capture bundle is required");
	}
	if (input.captureBundleIds.some((value) => value.trim().length === 0)) {
		throw new Error("Capture bundle ids must be non-empty");
	}
	if (!input.exchange.trim() || !input.tradingPair.trim()) {
		throw new Error("Exchange and trading pair are required");
	}
	if (
		!Number.isSafeInteger(input.startTimeMs) ||
		!Number.isSafeInteger(input.endTimeMs) ||
		input.startTimeMs < 0 ||
		input.endTimeMs <= input.startTimeMs
	) {
		throw new Error("Replay export requires a bounded increasing time window");
	}
}

function httpQuery(input: CanonicalMarketReplayWindow): HttpQuery {
	const endpoint = new URL(input.clickhouseUrl);
	const embeddedUsername = decodeURIComponent(endpoint.username);
	const embeddedPassword = decodeURIComponent(endpoint.password);
	endpoint.username = "";
	endpoint.password = "";
	endpoint.searchParams.set("database", "market_data");
	return {
		endpoint,
		headers: {
			"X-ClickHouse-User": input.username || embeddedUsername || "default",
			"X-ClickHouse-Key": input.password ?? embeddedPassword,
		},
		parameters: {
			capture_bundle_ids: clickHouseArray(input.captureBundleIds),
			exchange: input.exchange,
			trading_pair: input.tradingPair,
			start_time_ms: String(input.startTimeMs),
			end_time_ms: String(input.endTimeMs),
		},
	};
}

async function executeQuery(
	http: HttpQuery,
	query: string,
	format: "JSONEachRow" | "Parquet",
): Promise<Uint8Array> {
	const endpoint = new URL(http.endpoint);
	for (const [name, value] of Object.entries(http.parameters)) {
		endpoint.searchParams.set(`param_${name}`, value);
	}
	const response = await fetch(endpoint, {
		method: "POST",
		headers: http.headers,
		body: `${query.trim()}\nFORMAT ${format}`,
	});
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (!response.ok) {
		const detail = new TextDecoder().decode(bytes).slice(0, 2_000);
		throw new Error(
			`ClickHouse replay export failed (${response.status}): ${detail}`,
		);
	}
	return bytes;
}

const WINDOW_FILTER = `
capture_bundle_id IN ({capture_bundle_ids:Array(String)})
AND exchange = {exchange:String}
AND trading_pair = {trading_pair:String}
AND source_time_ms >= {start_time_ms:UInt64}
AND source_time_ms < {end_time_ms:UInt64}
`;

async function rowCount(http: HttpQuery, table: string): Promise<number> {
	const bytes = await executeQuery(
		http,
		`SELECT count() AS rows FROM ${table} WHERE ${WINDOW_FILTER}`,
		"JSONEachRow",
	);
	const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
		rows: string;
	};
	return Number(parsed.rows);
}

async function promotionReceiptIds(http: HttpQuery): Promise<string[]> {
	const bytes = await executeQuery(
		http,
		`SELECT DISTINCT promotion.receipt_id
		 FROM market_data.cex_order_book_capture_promotions AS promotion
		 INNER JOIN
		 (
		   SELECT DISTINCT capture_bundle_id, exchange, trading_pair, asset_type,
		          feed, provider, depth_limit, construction_mode, schema_version,
		          checksum_algorithm
		   FROM market_data.cex_order_book_depth_summary_replay_qualified
		   WHERE ${WINDOW_FILTER}
		 ) AS qualified
		 ON promotion.capture_bundle_id = qualified.capture_bundle_id
		 AND promotion.exchange = qualified.exchange
		 AND promotion.trading_pair = qualified.trading_pair
		 AND promotion.asset_type = qualified.asset_type
		 AND promotion.feed = qualified.feed
		 AND promotion.provider = qualified.provider
		 AND promotion.depth_limit = qualified.depth_limit
		 AND promotion.construction_mode = qualified.construction_mode
		 AND promotion.schema_version = qualified.schema_version
		 AND promotion.checksum_algorithm = qualified.checksum_algorithm
		 WHERE promotion.status = 'passing'
		   AND promotion.seam_verified = 1
		   AND promotion.coverage_verified = 1
		   AND promotion.window_start_ms <= {start_time_ms:UInt64}
		   AND promotion.window_end_ms >= {end_time_ms:UInt64}
		 ORDER BY promotion.receipt_id`,
		"JSONEachRow",
	);
	return parseJsonEachRow<{ receipt_id: string }>(bytes).map(
		({ receipt_id }) => receipt_id,
	);
}

async function assertConflictFree(http: HttpQuery): Promise<void> {
	const bytes = await executeQuery(
		http,
		`SELECT count() AS conflicts
		 FROM
		 (
			 SELECT snapshot_id
			 FROM market_data.cex_order_book_levels_conflicts
			 WHERE capture_bundle_id IN ({capture_bundle_ids:Array(String)})
			   AND exchange = {exchange:String}
			   AND trading_pair = {trading_pair:String}
			 UNION ALL
			 SELECT snapshot_id
			 FROM market_data.cex_order_book_depth_summary_conflicts
			 WHERE capture_bundle_id IN ({capture_bundle_ids:Array(String)})
			   AND exchange = {exchange:String}
			   AND trading_pair = {trading_pair:String}
		 ) AS conflicts
		 WHERE snapshot_id IN
		 (
			 SELECT snapshot_id
			 FROM market_data.cex_order_book_depth_summary
			 WHERE ${WINDOW_FILTER}
		 )`,
		"JSONEachRow",
	);
	const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
		conflicts: string;
	};
	if (Number(parsed.conflicts) > 0) {
		throw new Error(
			"Canonical order-book export blocked by checksum conflicts in the selected replay window",
		);
	}
}

function parseJsonEachRow<T>(bytes: Uint8Array): T[] {
	const text = new TextDecoder().decode(bytes).trim();
	return text ? text.split("\n").map((line) => JSON.parse(line) as T) : [];
}

export async function validateCanonicalMarketReplayWindow(
	input: CanonicalMarketReplayWindow,
): Promise<CanonicalMarketReplayValidation> {
	validateInput(input);
	const http = httpQuery(input);
	await assertConflictFree(http);
	const [rawBytes, levels, summaries, tickers, trades, ohlcv] =
		await Promise.all([
			executeQuery(
				http,
				`SELECT feed, count() AS rows
				 FROM market_data.cex_stream_events
				 WHERE ${WINDOW_FILTER}
				 GROUP BY feed`,
				"JSONEachRow",
			),
			rowCount(http, "market_data.cex_order_book_levels_replay_qualified"),
			rowCount(
				http,
				"market_data.cex_order_book_depth_summary_replay_qualified",
			),
			rowCount(http, "market_data.cex_ticker_events"),
			rowCount(http, "market_data.cex_trades"),
			rowCount(http, "market_data.cex_ohlcv FINAL"),
		]);
	const rawRowsByFeed = {
		ORDERBOOK: 0,
		TICKER: 0,
		TRADES: 0,
		OHLCV: 0,
	};
	for (const row of parseJsonEachRow<{ feed: string; rows: string }>(
		rawBytes,
	)) {
		if (row.feed in rawRowsByFeed) {
			rawRowsByFeed[row.feed as keyof typeof rawRowsByFeed] = Number(row.rows);
		}
	}
	const normalizedRows = { levels, summaries, tickers, trades, ohlcv };
	const missingRawFeeds = Object.entries(rawRowsByFeed)
		.filter(([, rows]) => rows === 0)
		.map(([feed]) => feed);
	const missingNormalizedFeeds = Object.entries(normalizedRows)
		.filter(([, rows]) => rows === 0)
		.map(([feed]) => feed);
	if (missingRawFeeds.length > 0 || missingNormalizedFeeds.length > 0) {
		throw new Error(
			`Replay window is incomplete; missing raw feeds: ${missingRawFeeds.join(",") || "none"}; missing normalized rows: ${missingNormalizedFeeds.join(",") || "none"}`,
		);
	}
	return { rawRowsByFeed, normalizedRows };
}

function assertParquet(bytes: Uint8Array, label: string): void {
	const decoder = new TextDecoder();
	if (
		bytes.length < 8 ||
		decoder.decode(bytes.subarray(0, 4)) !== "PAR1" ||
		decoder.decode(bytes.subarray(-4)) !== "PAR1"
	) {
		throw new Error(`${label} export did not produce a valid Parquet envelope`);
	}
}

export async function exportCanonicalOrderBookParquet(
	input: CanonicalOrderBookParquetExport,
): Promise<CanonicalOrderBookParquetExportResult> {
	validateInput(input);
	const http = httpQuery(input);
	await assertConflictFree(http);
	const levelsTable = "market_data.cex_order_book_levels_replay_qualified";
	const summaryTable =
		"market_data.cex_order_book_depth_summary_replay_qualified";
	const [levelRows, summaryRows, receiptIds] = await Promise.all([
		rowCount(http, levelsTable),
		rowCount(http, summaryTable),
		promotionReceiptIds(http),
	]);
	if (levelRows === 0 || summaryRows === 0) {
		throw new Error(
			"Qualified order-book export has no complete replay-eligible rows for the selected capture window",
		);
	}
	const [levels, summary] = await Promise.all([
		executeQuery(
			http,
			`SELECT * FROM ${levelsTable} WHERE ${WINDOW_FILTER}
			 ORDER BY source_time_ms, snapshot_id, side, level_index`,
			"Parquet",
		),
		executeQuery(
			http,
			`SELECT * FROM ${summaryTable} WHERE ${WINDOW_FILTER}
			 ORDER BY source_time_ms, snapshot_id`,
			"Parquet",
		),
	]);
	assertParquet(levels, "Order-book levels");
	assertParquet(summary, "Order-book depth summary");
	await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
	const levelsPath = join(input.outputDirectory, "order_book_levels.parquet");
	const summaryPath = join(
		input.outputDirectory,
		"order_book_depth_summary.parquet",
	);
	await Promise.all([
		writeFile(levelsPath, levels, { flag: "wx", mode: 0o600 }),
		writeFile(summaryPath, summary, { flag: "wx", mode: 0o600 }),
	]);
	return {
		levelsPath,
		summaryPath,
		levelRows,
		summaryRows,
		promotionReceiptIds: receiptIds,
	};
}

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

if (import.meta.main) {
	const result = await exportCanonicalOrderBookParquet({
		clickhouseUrl:
			process.env.CLICKHOUSE_URL?.trim() ||
			`http://${process.env.CLICKHOUSE_HOST?.trim() || "localhost"}:${process.env.CLICKHOUSE_PORT?.trim() || "8123"}`,
		username: process.env.CLICKHOUSE_USER?.trim(),
		password: process.env.CLICKHOUSE_PASSWORD,
		outputDirectory: requiredEnv("CEX_BROKER_REPLAY_EXPORT_DIRECTORY"),
		captureBundleIds: requiredEnv("CEX_BROKER_REPLAY_CAPTURE_BUNDLE_IDS")
			.split(",")
			.map((value) => value.trim()),
		exchange: requiredEnv("CEX_BROKER_REPLAY_EXCHANGE"),
		tradingPair: requiredEnv("CEX_BROKER_REPLAY_TRADING_PAIR"),
		startTimeMs: Number(requiredEnv("CEX_BROKER_REPLAY_START_TIME_MS")),
		endTimeMs: Number(requiredEnv("CEX_BROKER_REPLAY_END_TIME_MS")),
	});
	console.info(JSON.stringify(result));
}
