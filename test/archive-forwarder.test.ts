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
import {
	isSupportedTable,
	SUPPORTED_TABLES,
} from "../services/archive-forwarder/types";

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

	test("rejects rows whose source disagrees with the archive envelope", () => {
		const parsed = parseArchiveBatchRequest({
			source: "broker_read",
			deployment_id: "deploy-a",
			rows: [
				{
					table: "market_data.cex_trades",
					row: { source: "broker_write", trade_id: "t-1" },
				},
			],
		});

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.batch.rows).toHaveLength(0);
		expect(parsed.rejectedRowCount).toBe(1);
		expect(parsed.rejectedRowsByTable).toEqual({
			"market_data.cex_trades": 1,
		});
	});

	test("rejects same-batch order-book logical-key checksum conflicts", () => {
		const common = {
			source: "broker_read",
			deployment_id: "deploy-a",
			capture_bundle_id: "bundle-a",
			exchange: "binance",
			symbol: "BTC/USDT",
			trading_pair: "BTC-USDT",
			source_symbol: "BTC/USDT",
			asset_type: "spot",
			feed: "ORDERBOOK",
			provider: "ccxt:binance",
			source_mode: "broker_public_feed_v1",
			source_time_ms: 1_000,
			received_time_ms: 1_001,
			raw_capture_id: "raw-a",
			raw_capture_scope: "ccxt_normalized_object",
			snapshot_id: "snapshot-a",
			schema_version: "1.0.0",
			checksum_algorithm: "sha256",
			raw_checksum: "raw-checksum-a",
			provenance_complete: 1,
			construction_mode: "sampled_top_n_snapshot",
			gap_policy: "record_gap",
			depth_limit: 25,
			sequence: null,
			exact_l2_reconstruction_complete: 0,
			side: "bid",
			level_index: 0,
			price: "100.000000000000000000",
			amount: "2.000000000000000000",
			notional: "200.000000000000000000",
			mid_price: "100.500000000000000000",
			spread_from_mid_bps: 49.75,
		};
		const parsed = parseArchiveBatchRequest({
			source: "broker_read",
			deployment_id: "deploy-a",
			rows: [
				{
					table: "market_data.cex_order_book_levels",
					row: { ...common, normalized_row_checksum: "a" },
				},
				{
					table: "market_data.cex_order_book_levels",
					row: { ...common, normalized_row_checksum: "b" },
				},
			],
		});

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.batch.rows).toHaveLength(0);
		expect(parsed.rejectedRowCount).toBe(2);
		expect(parsed.checksumConflictsByTable).toEqual({
			"market_data.cex_order_book_levels": 2,
		});
	});

	test("accepts the broker execution and account balance archive tables", () => {
		expect(isSupportedTable("broker_execution.transfer_events")).toBe(true);
		expect(isSupportedTable("broker_execution.fill_events")).toBe(true);
		expect(isSupportedTable("broker_account.balance_snapshots")).toBe(true);
		expect(isSupportedTable("broker_stream_health.snapshots")).toBe(true);
		expect(isSupportedTable("broker_account.unknown")).toBe(false);

		const parsed = parseArchiveBatchRequest({
			source: "broker_write",
			deployment_id: "deploy-a",
			rows: [
				{
					table: "broker_execution.transfer_events",
					row: { external_id: "wd-1", event_kind: "withdrawal" },
				},
				{
					table: "broker_execution.fill_events",
					row: { order_id: "o-1", trade_id: "t-1" },
				},
				{
					table: "broker_account.balance_snapshots",
					row: { observation_id: "obs-1", balance_scope: "spot" },
				},
			],
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		expect(parsed.rejectedRowCount).toBe(0);
		expect(parsed.batch.rows).toHaveLength(3);
	});

	test("names the offending tables in rejectedTables so a bad rollout is visible", () => {
		const parsed = parseArchiveBatchRequest({
			source: "broker_write",
			deployment_id: "deploy-a",
			rows: [
				{ table: "broker_execution.order_events", row: { order_id: "1" } },
				{ table: "broker_execution.mystery_table", row: { x: 1 } },
				{ table: 123, row: {} },
			],
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		expect(parsed.rejectedRowCount).toBe(2);
		expect(parsed.batch.rows).toHaveLength(1);
		expect(parsed.rejectedTables).toEqual(
			expect.arrayContaining(["broker_execution.mystery_table", "(malformed)"]),
		);
		expect(parsed.rejectedRowsByTable).toEqual({
			"broker_execution.mystery_table": 1,
			"(malformed)": 1,
		});
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

	test("accepts control-plane snapshots and policy replay cursors", () => {
		const parsed = parseArchiveBatchRequest({
			source: "hb_runtime",
			deployment_id: "deploy-a",
			rows: [
				{
					table: "strategy_data.policy_evaluation_events",
					row: {
						event_time_ms: 1,
						source_cursor: "block:12345680:log:3",
					},
				},
				{
					table: "strategy_data.market_identity",
					row: { event_time_ms: 2, canonical_core_pool_id: "pool-1" },
				},
				{
					table: "strategy_data.symbol_mapping",
					row: {
						event_time_ms: 3,
						exchange: "binance",
						trading_pair: "BTC-USDT",
					},
				},
			],
		});

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		expect(parsed.rejectedRowCount).toBe(0);
		expect(parsed.batch.rows).toHaveLength(3);
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
				table: "broker_account.balance_snapshots",
				row: { observation_id: "obs-1" },
			},
			{
				table: "strategy_data.inventory_settlement_events",
				row: { event_time_ms: 1 },
			},
			{
				table: "strategy_data.market_identity",
				row: { event_time_ms: 2 },
			},
			{
				table: "strategy_data.symbol_mapping",
				row: { event_time_ms: 3 },
			},
			{
				table: "market_data.unknown_table",
				row: { symbol: "ETH/USDT" },
			},
		];

		const grouped = groupRowsByTable(rows);
		expect(grouped.get("market_data.candles")).toHaveLength(1);
		expect(grouped.get("broker_execution.order_events")).toHaveLength(1);
		expect(grouped.get("broker_account.balance_snapshots")).toHaveLength(1);
		expect(
			grouped.get("strategy_data.inventory_settlement_events"),
		).toHaveLength(1);
		expect(grouped.get("strategy_data.market_identity")).toHaveLength(1);
		expect(grouped.get("strategy_data.symbol_mapping")).toHaveLength(1);
		expect(countSkippedRows(rows)).toBe(1);
		expect(isSupportedTable("market_data.candles")).toBe(true);
		expect(isSupportedTable("broker_execution.order_events")).toBe(true);
		expect(isSupportedTable("broker_account.balance_snapshots")).toBe(true);
		expect(isSupportedTable("strategy_data.policy_evaluation_events")).toBe(
			true,
		);
		expect(isSupportedTable("strategy_data.market_identity")).toBe(true);
		expect(isSupportedTable("strategy_data.symbol_mapping")).toBe(true);
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

describe("archive forwarder retry deduplication", () => {
	const rows = [
		{ table: "market_data.cex_stream_events", row: { event_time_ms: 1 } },
		{ table: "market_data.cex_ohlcv", row: { open_time_ms: 1 } },
	];

	function recordingInserter(failTable?: string) {
		const calls: Array<{ table: string; token?: string }> = [];
		const inserter = async (
			table: string,
			_rows: Record<string, unknown>[],
			options?: { deduplicationToken?: string },
		) => {
			calls.push({ table, token: options?.deduplicationToken });
			if (table === failTable) {
				throw new Error("ClickHouse unavailable");
			}
		};
		return { calls, inserter };
	}

	test("a batch retried under its original id repeats every table's token", async () => {
		const batch = {
			source: "broker_write",
			deployment_id: "deploy-1",
			batch_id: "batch-1",
			rows,
		};
		// First attempt: one table lands, the sibling fails, so the sender re-posts
		// the whole batch — the landed table included.
		const attempt = recordingInserter("market_data.cex_ohlcv");
		const first = await handleArchiveBatch(attempt.inserter, batch);
		expect(first.inserted).toBe(1);
		expect(first.failedTables).toEqual(["market_data.cex_ohlcv"]);

		const retry = recordingInserter();
		await handleArchiveBatch(retry.inserter, batch);

		expect(retry.calls).toEqual(attempt.calls);
		expect(
			retry.calls.every((call) => /^[a-f0-9]{64}$/.test(call.token ?? "")),
		).toBe(true);
		// Distinct tables in one batch must not share a token, or the second
		// insert of the batch would be discarded as a repeat of the first.
		expect(new Set(retry.calls.map((call) => call.token)).size).toBe(2);
	});

	test("a different batch id produces different tokens for the same rows", async () => {
		const first = recordingInserter();
		await handleArchiveBatch(first.inserter, {
			source: "broker_write",
			deployment_id: "deploy-1",
			batch_id: "batch-1",
			rows,
		});
		const second = recordingInserter();
		await handleArchiveBatch(second.inserter, {
			source: "broker_write",
			deployment_id: "deploy-1",
			batch_id: "batch-2",
			rows,
		});

		expect(second.calls.map(({ token }) => token)).not.toEqual(
			first.calls.map(({ token }) => token),
		);
	});

	test("a sender that claims no retry identity gets unique per-attempt tokens", async () => {
		// Token-less inserts are not exempt from deduplication: ClickHouse dedupes
		// token-less blocks by content hash inside the window, collapsing
		// legitimate byte-identical deliveries. A unique token per attempt keeps
		// every delivery physically auditable.
		const first = recordingInserter();
		await handleArchiveBatch(first.inserter, {
			source: "broker_write",
			deployment_id: "deploy-1",
			rows,
		});
		expect(
			first.calls.every((call) => /^[a-f0-9]{64}$/.test(call.token ?? "")),
		).toBe(true);
		expect(new Set(first.calls.map(({ token }) => token)).size).toBe(2);

		const second = recordingInserter();
		await handleArchiveBatch(second.inserter, {
			source: "broker_write",
			deployment_id: "deploy-1",
			rows,
		});
		expect(second.calls.map(({ token }) => token)).not.toEqual(
			first.calls.map(({ token }) => token),
		);
	});

	test("a blank batch id is rejected rather than silently losing deduplication", () => {
		expect(
			parseArchiveBatchRequest({
				source: "broker_write",
				deployment_id: "deploy-1",
				batch_id: "   ",
				rows,
			}).ok,
		).toBe(false);
		expect(
			parseArchiveBatchRequest({
				source: "broker_write",
				deployment_id: "deploy-1",
				batch_id: 7,
				rows,
			}).ok,
		).toBe(false);
		const parsed = parseArchiveBatchRequest({
			source: "broker_write",
			deployment_id: "deploy-1",
			batch_id: "batch-1",
			rows,
		});
		expect(parsed.ok && parsed.batch.batch_id).toBe("batch-1");
	});
});

describe("archive forwarder schema init", () => {
	test("every token-deduplicated table the forwarder writes carries the dedup window", async () => {
		// Without this setting on the table, the retry tokens are accepted and
		// ignored, and a redelivered batch duplicates silently.
		const statements: string[] = [];
		const client = {
			command: async ({ query }: { query: string }) => {
				statements.push(query);
			},
		} as unknown as ClickHouseClient;

		await ensureArchiveSchema(client);

		const tokenDeduplicatedTables = SUPPORTED_TABLES.filter((table) =>
			["market_data.", "broker_execution.", "broker_account."].some((prefix) =>
				table.startsWith(prefix),
			),
		);
		for (const table of tokenDeduplicatedTables) {
			const applied = statements.some(
				(query) =>
					query.includes(table) &&
					/MODIFY SETTING non_replicated_deduplication_window = 1000000/.test(
						query,
					),
			);
			expect(`${table}:${applied}`).toBe(`${table}:true`);
		}
	});

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
				"broker_account",
				"broker_stream_health",
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
				"market_data.cex_order_book_levels",
				"market_data.cex_order_book_depth_summary",
				"market_data.cex_ohlcv",
				"broker_execution.order_events",
				"broker_execution.market_metadata_snapshots",
				"broker_execution.transfer_events",
				"broker_execution.fill_events",
				"broker_account.balance_snapshots",
				"broker_stream_health.snapshots",
				"broker_stream_health.replay_conflicts",
				"strategy_data.policy_evaluation_events",
				"strategy_data.strategy_policy_snapshots",
				"strategy_data.market_identity",
				"strategy_data.symbol_mapping",
				"strategy_data.inventory_settlement_events",
			]),
		);
		const marketSchema = statements.join("\n");
		expect(marketSchema).toContain(
			"ENGINE = ReplacingMergeTree(broker_version)",
		);
		expect(marketSchema).toContain(
			"CREATE OR REPLACE VIEW market_data.cex_order_book_levels_canonical",
		);
		expect(marketSchema).toContain(
			"CREATE OR REPLACE VIEW market_data.cex_order_book_levels_conflicts",
		);
		expect(marketSchema).toContain(
			"CREATE OR REPLACE VIEW market_data.cex_order_book_depth_summary_canonical",
		);
		expect(marketSchema).toContain(
			"CREATE OR REPLACE VIEW market_data.cex_order_book_depth_summary_conflicts",
		);
		expect(marketSchema).toContain(
			"ORDER BY (exchange, trading_pair, capture_bundle_id, source_time_ms, raw_capture_id, snapshot_id, schema_version, side, level_index)",
		);
		expect(marketSchema).toContain(
			"ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS capture_bundle_id",
		);

		const balanceTable = statements.find((query) =>
			/CREATE TABLE IF NOT EXISTS\s+broker_account\.balance_snapshots/i.test(
				query,
			),
		);
		expect(balanceTable).toContain(
			"broker_observed_timestamp DateTime64(3, 'UTC')",
		);
		expect(balanceTable).toContain(
			"exchange_timestamp Nullable(DateTime64(3, 'UTC'))",
		);
		expect(balanceTable).toContain("free_balances Map(String, String)");
		expect(balanceTable).toContain("used_balances Map(String, String)");
		expect(balanceTable).toContain("total_balances Map(String, String)");
		expect(balanceTable).toContain(
			"ORDER BY (exchange, account_selector, balance_scope, broker_observed_timestamp, observation_id)",
		);
		expect(balanceTable).not.toContain("TTL");

		const streamHealthTable = statements.find((query) =>
			/CREATE TABLE IF NOT EXISTS\s+broker_stream_health\.snapshots/i.test(
				query,
			),
		);
		expect(streamHealthTable).toContain("heartbeat_at DateTime64(3, 'UTC')");
		expect(streamHealthTable).toContain(
			"state Enum8('connecting' = 1, 'connected' = 2, 'disconnected' = 3, 'error' = 4)",
		);
		expect(streamHealthTable).toContain("payload_sha256 FixedString(64)");
		expect(streamHealthTable).not.toContain("TTL");
	});
});
