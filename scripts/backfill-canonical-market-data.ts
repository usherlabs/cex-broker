#!/usr/bin/env bun
import { createClient } from "@clickhouse/client";
import type {
	BrokerArchiveRow,
	BrokerArchiveSource,
} from "../src/helpers/broker-execution-archive/types";
import {
	buildLegacyOhlcvBackfillRow,
	buildLegacyOrderBookBackfillRows,
	type LegacyCandle,
	type LegacyOrderBookSnapshot,
} from "../src/helpers/market-data-archive/legacy-backfill";

const startTimeMs = Number(process.env.CEX_BROKER_BACKFILL_START_TIME_MS);
const endTimeMs = Number(process.env.CEX_BROKER_BACKFILL_END_TIME_MS);
if (
	!Number.isSafeInteger(startTimeMs) ||
	!Number.isSafeInteger(endTimeMs) ||
	startTimeMs < 0 ||
	endTimeMs <= startTimeMs
) {
	throw new Error(
		"CEX_BROKER_BACKFILL_START_TIME_MS and CEX_BROKER_BACKFILL_END_TIME_MS must define a bounded increasing window",
	);
}

const clickhouse = createClient({
	url:
		process.env.CLICKHOUSE_URL?.trim() ||
		`http://${process.env.CLICKHOUSE_HOST?.trim() || "localhost"}:${process.env.CLICKHOUSE_PORT?.trim() || "8123"}`,
	database: "market_data",
});
const confirmed = process.env.CEX_BROKER_CANONICAL_BACKFILL_CONFIRM === "true";

function numberField(row: Record<string, unknown>, field: string): number {
	const value = Number(row[field]);
	if (!Number.isFinite(value)) throw new Error(`Invalid legacy ${field}`);
	return value;
}

function numberArray(row: Record<string, unknown>, field: string): number[] {
	const value = row[field];
	if (!Array.isArray(value)) throw new Error(`Invalid legacy ${field}`);
	return value.map((entry) => Number(entry));
}

function sourceField(value: unknown): BrokerArchiveSource {
	return value === "broker_read" ? "broker_read" : "broker_write";
}

function orderBookInput(row: Record<string, unknown>): LegacyOrderBookSnapshot {
	return {
		source: sourceField(row.source),
		deployment_id: String(row.deployment_id),
		account_selector: String(row.account_selector ?? ""),
		exchange: String(row.exchange),
		asset_type:
			row.asset_type === "swap" || row.asset_type === "future"
				? row.asset_type
				: "spot",
		symbol: String(row.symbol),
		event_time_ms: numberField(row, "event_time_ms"),
		received_time_ms: numberField(row, "received_time_ms"),
		depth_limit: numberField(row, "depth_limit"),
		bids_price: numberArray(row, "bids_price"),
		bids_size: numberArray(row, "bids_size"),
		asks_price: numberArray(row, "asks_price"),
		asks_size: numberArray(row, "asks_size"),
		sequence:
			row.sequence === null || row.sequence === undefined
				? undefined
				: numberField(row, "sequence"),
	};
}

function candleInput(row: Record<string, unknown>): LegacyCandle {
	return {
		source: sourceField(row.source),
		deployment_id: String(row.deployment_id),
		account_selector: String(row.account_selector ?? ""),
		exchange: String(row.exchange),
		asset_type:
			row.asset_type === "swap" || row.asset_type === "future"
				? row.asset_type
				: "spot",
		symbol: String(row.symbol),
		timeframe: String(row.timeframe),
		open_time_ms: numberField(row, "open_time_ms"),
		open: numberField(row, "open"),
		high: numberField(row, "high"),
		low: numberField(row, "low"),
		close: numberField(row, "close"),
		volume: numberField(row, "volume"),
		quote_volume:
			row.quote_volume === null || row.quote_volume === undefined
				? undefined
				: numberField(row, "quote_volume"),
		is_closed: numberField(row, "is_closed") === 1 ? 1 : 0,
		broker_version: numberField(row, "broker_version"),
	};
}

async function readLegacyRows(
	table: "orderbook_snapshots" | "candles",
	timeField: "event_time_ms" | "open_time_ms",
): Promise<Record<string, unknown>[]> {
	const result = await clickhouse.query({
		query: `
			SELECT * FROM market_data.${table}${table === "candles" ? " FINAL" : ""}
			WHERE ${timeField} >= {start:UInt64} AND ${timeField} < {end:UInt64}
			ORDER BY exchange, symbol, ${timeField}
		`,
		query_params: { start: startTimeMs, end: endTimeMs },
		format: "JSONEachRow",
	});
	return (await result.json()) as Record<string, unknown>[];
}

async function insertRows(rows: BrokerArchiveRow[]): Promise<void> {
	const byTable = new Map<string, BrokerArchiveRow[]>();
	for (const entry of rows) {
		const entries = byTable.get(entry.table) ?? [];
		entries.push(entry);
		byTable.set(entry.table, entries);
	}
	for (const [table, entries] of byTable) {
		await clickhouse.insert({
			table,
			values: entries.map(({ row }) => row),
			format: "JSONEachRow",
		});
	}
}

try {
	const [legacyBooks, legacyCandles] = await Promise.all([
		readLegacyRows("orderbook_snapshots", "event_time_ms"),
		readLegacyRows("candles", "open_time_ms"),
	]);
	const canonicalRows = [
		...legacyBooks.flatMap((row) =>
			buildLegacyOrderBookBackfillRows(orderBookInput(row)),
		),
		...legacyCandles.map((row) =>
			buildLegacyOhlcvBackfillRow(candleInput(row)),
		),
	];
	console.info(
		JSON.stringify({
			window: { start_time_ms: startTimeMs, end_time_ms: endTimeMs },
			legacy_order_books: legacyBooks.length,
			legacy_candles: legacyCandles.length,
			canonical_rows: canonicalRows.length,
			mode: confirmed ? "write" : "dry_run",
		}),
	);
	if (confirmed) await insertRows(canonicalRows);
} finally {
	await clickhouse.close();
}
