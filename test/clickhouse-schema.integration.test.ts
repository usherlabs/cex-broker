import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { ensureMarketDataSchema } from "../services/archive-forwarder/schema";
import { handleArchiveBatch } from "../services/archive-forwarder/router";
import { createClickHouseInserter } from "../services/archive-forwarder/insert";

const CLICKHOUSE_URL =
	process.env.CLICKHOUSE_TEST_URL?.trim() ||
	`http://${process.env.CLICKHOUSE_HOST?.trim() || "localhost"}:${process.env.CLICKHOUSE_PORT?.trim() || "18123"}`;

const TEST_DEPLOYMENT = "clickhouse-integration-test";
const TEST_EVENT_MS = 1_900_000_000_000;

let client: ClickHouseClient;
let clickhouseAvailable = false;

async function pingClickHouse(): Promise<boolean> {
	try {
		const probe = createClient({
			url: CLICKHOUSE_URL,
			database: "market_data",
		});
		await probe.ping();
		await probe.close();
		return true;
	} catch {
		return false;
	}
}

async function tableEngine(name: string): Promise<string | null> {
	const result = await client.query({
		query: `
			SELECT engine
			FROM system.tables
			WHERE database = 'market_data' AND name = {name:String}
		`,
		query_params: { name },
		format: "JSONEachRow",
	});
	const rows = (await result.json()) as Array<{ engine: string }>;
	return rows[0]?.engine ?? null;
}

async function cleanupTestRows(): Promise<void> {
	await client.command({
		query: `
			ALTER TABLE orderbook_snapshots
			DELETE WHERE deployment_id = {deployment_id:String}
		`,
		query_params: { deployment_id: TEST_DEPLOYMENT },
	});
	await client.command({
		query: `
			ALTER TABLE candles
			DELETE WHERE deployment_id = {deployment_id:String}
		`,
		query_params: { deployment_id: TEST_DEPLOYMENT },
	});
}

describe("ClickHouse market_data schema integration", () => {
	beforeAll(async () => {
		clickhouseAvailable = await pingClickHouse();
		if (!clickhouseAvailable) {
			return;
		}
		client = createClient({
			url: CLICKHOUSE_URL,
			database: "market_data",
		});
		await ensureMarketDataSchema(client);
		await cleanupTestRows();
	});

	afterAll(async () => {
		if (!clickhouseAvailable) {
			return;
		}
		await cleanupTestRows();
		await client.close();
	});

	test("orderbook_tob and orderbook_depth are views over orderbook_snapshots", async () => {
		if (!clickhouseAvailable) {
			console.warn(`Skipping: ClickHouse unavailable at ${CLICKHOUSE_URL}`);
			return;
		}

		expect(await tableEngine("orderbook_snapshots")).toBe("MergeTree");
		expect(await tableEngine("orderbook_tob")).toBe("View");
		expect(await tableEngine("orderbook_depth")).toBe("View");
		expect(await tableEngine("candles_closed")).toBe("View");
	});

	test("orderbook views reflect inserts into orderbook_snapshots", async () => {
		if (!clickhouseAvailable) {
			return;
		}

		const row = {
			source: "broker_write",
			deployment_id: TEST_DEPLOYMENT,
			account_selector: "",
			exchange: "binance",
			asset_type: "spot",
			symbol: "TEST/CH",
			event_time_ms: TEST_EVENT_MS,
			received_time_ms: TEST_EVENT_MS + 1,
			best_bid: 100,
			best_ask: 101,
			bid_size: 1.5,
			ask_size: 2,
			mid: 100.5,
			spread_bps: 99.5,
			depth_limit: 2,
			bid_levels: 2,
			ask_levels: 2,
			bids_price: [100, 99.5],
			bids_size: [1.5, 2],
			asks_price: [101, 101.5],
			asks_size: [2, 1.5],
			sequence: 42,
		};

		await client.insert({
			table: "orderbook_snapshots",
			values: [row],
			format: "JSONEachRow",
		});

		const snapshotCount = await client.query({
			query: `
				SELECT count() AS c
				FROM orderbook_snapshots
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
					AND event_time_ms = {event_time_ms:UInt64}
			`,
			query_params: {
				deployment_id: TEST_DEPLOYMENT,
				event_time_ms: TEST_EVENT_MS,
			},
			format: "JSONEachRow",
		});
		expect(Number(((await snapshotCount.json()) as Array<{ c: string }>)[0]?.c)).toBe(
			1,
		);

		const tob = await client.query({
			query: `
				SELECT best_bid, best_ask, mid, spread_bps, sequence
				FROM orderbook_tob
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
					AND event_time_ms = {event_time_ms:UInt64}
			`,
			query_params: {
				deployment_id: TEST_DEPLOYMENT,
				event_time_ms: TEST_EVENT_MS,
			},
			format: "JSONEachRow",
		});
		const tobRow = (await tob.json())[0] as Record<string, unknown>;
		expect(Number(tobRow.best_bid)).toBe(100);
		expect(Number(tobRow.best_ask)).toBe(101);
		expect(Number(tobRow.mid)).toBe(100.5);
		expect(Number(tobRow.sequence)).toBe(42);

		const depth = await client.query({
			query: `
				SELECT depth_limit, bid_levels, ask_levels, bids_price, asks_price
				FROM orderbook_depth
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
					AND event_time_ms = {event_time_ms:UInt64}
			`,
			query_params: {
				deployment_id: TEST_DEPLOYMENT,
				event_time_ms: TEST_EVENT_MS,
			},
			format: "JSONEachRow",
		});
		const depthRow = (await depth.json())[0] as Record<string, unknown>;
		expect(Number(depthRow.depth_limit)).toBe(2);
		expect(Number(depthRow.bid_levels)).toBe(2);
		expect(Number(depthRow.ask_levels)).toBe(2);
		expect(depthRow.bids_price).toEqual([100, 99.5]);
		expect(depthRow.asks_price).toEqual([101, 101.5]);
	});

	test("candles_closed view returns only closed bars", async () => {
		if (!clickhouseAvailable) {
			return;
		}

		const openTimeMs = TEST_EVENT_MS + 60_000;
		await client.insert({
			table: "candles",
			values: [
				{
					source: "broker_write",
					deployment_id: TEST_DEPLOYMENT,
					account_selector: "",
					exchange: "binance",
					asset_type: "spot",
					symbol: "TEST/CH",
					timeframe: "1m",
					open_time_ms: openTimeMs,
					open: 1,
					high: 2,
					low: 0.5,
					close: 1.5,
					volume: 10,
					is_closed: 0,
					broker_version: openTimeMs,
				},
				{
					source: "broker_write",
					deployment_id: TEST_DEPLOYMENT,
					account_selector: "",
					exchange: "binance",
					asset_type: "spot",
					symbol: "TEST/CH",
					timeframe: "1m",
					open_time_ms: openTimeMs + 60_000,
					open: 2,
					high: 3,
					low: 1.5,
					close: 2.5,
					volume: 12,
					is_closed: 1,
					broker_version: openTimeMs + 60_000,
				},
			],
			format: "JSONEachRow",
		});

		const closed = await client.query({
			query: `
				SELECT count() AS c
				FROM candles_closed
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
			`,
			query_params: { deployment_id: TEST_DEPLOYMENT },
			format: "JSONEachRow",
		});
		expect(Number(((await closed.json()) as Array<{ c: string }>)[0]?.c)).toBe(1);

		const forming = await client.query({
			query: `
				SELECT count() AS c
				FROM candles FINAL
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/CH'
					AND is_closed = 0
			`,
			query_params: { deployment_id: TEST_DEPLOYMENT },
			format: "JSONEachRow",
		});
		expect(Number(((await forming.json()) as Array<{ c: string }>)[0]?.c)).toBe(1);
	});

	test("archive forwarder inserts into base tables (not views)", async () => {
		if (!clickhouseAvailable) {
			return;
		}

		const eventMs = TEST_EVENT_MS + 120_000;
		const result = await handleArchiveBatch(createClickHouseInserter(client), {
			source: "broker_write",
			deployment_id: TEST_DEPLOYMENT,
			rows: [
				{
					table: "market_data.orderbook_snapshots",
					row: {
						source: "broker_write",
						deployment_id: TEST_DEPLOYMENT,
						account_selector: "",
						exchange: "binance",
						asset_type: "spot",
						symbol: "TEST/FWD",
						event_time_ms: eventMs,
						received_time_ms: eventMs + 1,
						best_bid: 50,
						best_ask: 51,
						bid_size: 1,
						ask_size: 1,
						mid: 50.5,
						spread_bps: 10,
						depth_limit: 1,
						bid_levels: 1,
						ask_levels: 1,
						bids_price: [50],
						bids_size: [1],
						asks_price: [51],
						asks_size: [1],
					},
				},
			],
		});

		expect(result.failed).toBe(0);
		expect(result.inserted).toBe(1);

		const viaView = await client.query({
			query: `
				SELECT best_bid, best_ask
				FROM orderbook_tob
				WHERE deployment_id = {deployment_id:String}
					AND symbol = 'TEST/FWD'
					AND event_time_ms = {event_time_ms:UInt64}
			`,
			query_params: {
				deployment_id: TEST_DEPLOYMENT,
				event_time_ms: eventMs,
			},
			format: "JSONEachRow",
		});
		expect((await viaView.json())[0]).toMatchObject({
			best_bid: 50,
			best_ask: 51,
		});
	});
});
