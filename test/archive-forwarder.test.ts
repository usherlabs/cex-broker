import { describe, expect, test } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";
import {
	countSkippedRows,
	groupRowsByTable,
	insertArchiveRows,
} from "../services/archive-forwarder/insert";
import {
	handleArchiveBatch,
	parseArchiveBatchRequest,
} from "../services/archive-forwarder/router";
import { ensureArchiveSchema } from "../services/archive-forwarder/schema";
import { isSupportedTable } from "../services/archive-forwarder/types";

describe("archive forwarder batch parsing", () => {
	test("parseArchiveBatchRequest accepts broker_write payloads", () => {
		const parsed = parseArchiveBatchRequest({
			source: "broker_write",
			deployment_id: "deploy-a",
			rows: [
				{
					table: "market_data.candles",
					row: { symbol: "BTC/USDT", open_time_ms: 1_000 },
				},
			],
		});

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		expect(parsed.rejectedRowCount).toBe(0);
		expect(parsed.batch).toEqual({
			source: "broker_write",
			deployment_id: "deploy-a",
			rows: [
				{
					table: "market_data.candles",
					row: { symbol: "BTC/USDT", open_time_ms: 1_000 },
				},
			],
		});
	});

	test("parseArchiveBatchRequest rejects invalid payloads", () => {
		expect(parseArchiveBatchRequest(null).ok).toBe(false);
		expect(parseArchiveBatchRequest({ source: "x" }).ok).toBe(false);
	});

	test("parseArchiveBatchRequest rejects array rows and malformed entries", () => {
		const parsed = parseArchiveBatchRequest({
			source: "broker_write",
			deployment_id: "deploy-a",
			rows: [
				{ table: "market_data.candles", row: { open_time_ms: 1 } },
				{ table: "market_data.candles", row: [] },
				{ table: "market_data.candles", row: null },
			],
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		expect(parsed.inputRowCount).toBe(3);
		expect(parsed.rejectedRowCount).toBe(2);
		expect(parsed.batch.rows).toHaveLength(1);
	});

	test("parseArchiveBatchRequest accepts broker_execution and strategy_data, rejects unknown tables", () => {
		const parsed = parseArchiveBatchRequest({
			source: "hb_runtime",
			deployment_id: "deploy-a",
			rows: [
				{ table: "market_data.candles", row: { open_time_ms: 1 } },
				{ table: "broker_execution.order_events", row: { order_id: "1" } },
				{
					table: "strategy_data.policy_evaluation_events",
					row: { event_time_ms: 1 },
				},
				{ table: "market_data.unknown_table", row: { symbol: "BTC/USDT" } },
			],
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		expect(parsed.rejectedRowCount).toBe(1);
		expect(parsed.batch.rows).toHaveLength(3);
		expect(parsed.batch.rows.map((row) => row.table)).toEqual([
			"market_data.candles",
			"broker_execution.order_events",
			"strategy_data.policy_evaluation_events",
		]);
	});
});

describe("archive forwarder routing", () => {
	test("groups every supported archive database and skips unknown tables", () => {
		const rows = [
			{
				table: "market_data.candles",
				row: { symbol: "BTC/USDT" },
			},
			{
				table: "broker_execution.order_events",
				row: { order_id: "1" },
			},
			{
				table: "strategy_data.inventory_settlement_events",
				row: { event_time_ms: 1 },
			},
			{
				table: "market_data.unknown_table",
				row: { symbol: "ETH/USDT" },
			},
		];

		const grouped = groupRowsByTable(rows);
		expect(grouped.get("market_data.candles")).toHaveLength(1);
		expect(grouped.get("broker_execution.order_events")).toHaveLength(1);
		expect(
			grouped.get("strategy_data.inventory_settlement_events"),
		).toHaveLength(1);
		expect(countSkippedRows(rows)).toBe(1);
		expect(isSupportedTable("market_data.candles")).toBe(true);
		expect(isSupportedTable("broker_execution.order_events")).toBe(true);
		expect(isSupportedTable("strategy_data.policy_evaluation_events")).toBe(
			true,
		);
		expect(isSupportedTable("market_data.unknown_table")).toBe(false);
	});

	test("insertArchiveRows calls inserter per supported table", async () => {
		const inserts: Array<{ table: string; count: number }> = [];
		const result = await insertArchiveRows(
			async (table, tableRows) => {
				inserts.push({ table, count: tableRows.length });
			},
			[
				{ table: "market_data.candles", row: { open_time_ms: 1 } },
				{ table: "market_data.candles", row: { open_time_ms: 2 } },
				{ table: "market_data.unknown_table", row: { order_id: "9" } },
			],
		);

		expect(result).toEqual({
			inserted: 2,
			skipped: 1,
			failed: 0,
			byTable: { "market_data.candles": 2 },
			failedTables: [],
		});
		expect(inserts).toEqual([{ table: "market_data.candles", count: 2 }]);
	});

	test("insertArchiveRows routes broker_execution and strategy_data tables", async () => {
		const inserts: Array<{ table: string; count: number }> = [];
		const result = await insertArchiveRows(
			async (table, tableRows) => {
				inserts.push({ table, count: tableRows.length });
			},
			[
				{ table: "broker_execution.order_events", row: { order_id: "1" } },
				{
					table: "strategy_data.policy_evaluation_events",
					row: { event_time_ms: 1 },
				},
				{
					table: "strategy_data.policy_evaluation_events",
					row: { event_time_ms: 2 },
				},
			],
		);

		expect(result.inserted).toBe(3);
		expect(result.skipped).toBe(0);
		expect(inserts).toContainEqual({
			table: "broker_execution.order_events",
			count: 1,
		});
		expect(inserts).toContainEqual({
			table: "strategy_data.policy_evaluation_events",
			count: 2,
		});
	});

	test("insertArchiveRows continues when one table insert fails", async () => {
		const inserts: string[] = [];
		const result = await insertArchiveRows(
			async (table) => {
				if (table === "market_data.cex_trades") {
					throw new Error("table missing");
				}
				inserts.push(table);
			},
			[
				{ table: "market_data.candles", row: { open_time_ms: 1 } },
				{ table: "market_data.cex_trades", row: { trade_id: "t-1" } },
				{ table: "market_data.orderbook_snapshots", row: { best_bid: 1 } },
			],
		);

		expect(result.inserted).toBe(2);
		expect(result.failed).toBe(1);
		expect(result.failedTables).toEqual(["market_data.cex_trades"]);
		expect(inserts).toEqual([
			"market_data.candles",
			"market_data.orderbook_snapshots",
		]);
	});

	test("handleArchiveBatch processes valid requests", async () => {
		const inserted: string[] = [];
		const result = await handleArchiveBatch(
			async (table) => {
				inserted.push(table);
			},
			{
				source: "broker_write",
				deployment_id: "deploy-a",
				rows: [{ table: "market_data.candles", row: { symbol: "BTC/USDT" } }],
			},
		);

		expect(result.inserted).toBe(1);
		expect(inserted).toEqual(["market_data.candles"]);
	});
});

describe("archive forwarder schema init", () => {
	test("ensureArchiveSchema applies every archive database from its SQL files", async () => {
		const statements: string[] = [];
		const client = {
			command: async ({ query }: { query: string }) => {
				statements.push(query);
			},
		} as unknown as ClickHouseClient;

		await ensureArchiveSchema(client);

		const createdDatabases = statements
			.map(
				(query) => query.match(/CREATE DATABASE IF NOT EXISTS\s+(\w+)/i)?.[1],
			)
			.filter((name): name is string => Boolean(name));
		expect(createdDatabases).toEqual(
			expect.arrayContaining([
				"market_data",
				"broker_execution",
				"strategy_data",
			]),
		);

		const createdTables = statements
			.map(
				(query) => query.match(/CREATE TABLE IF NOT EXISTS\s+([\w.]+)/i)?.[1],
			)
			.filter((name): name is string => Boolean(name));
		expect(createdTables).toEqual(
			expect.arrayContaining([
				"broker_execution.order_events",
				"broker_execution.market_metadata_snapshots",
				"strategy_data.policy_evaluation_events",
				"strategy_data.strategy_policy_snapshots",
				"strategy_data.inventory_settlement_events",
			]),
		);
	});
});
