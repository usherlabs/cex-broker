import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { ensureArchiveSchema } from "../services/archive-forwarder/schema";
import { ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELD_NAMES } from "../src/helpers/market-data-archive/summary-v2-conformance";

const CLICKHOUSE_URL =
	process.env.CLICKHOUSE_TEST_URL?.trim() ||
	`http://${process.env.CLICKHOUSE_HOST?.trim() || "localhost"}:${process.env.CLICKHOUSE_PORT?.trim() || "18123"}`;
const CLICKHOUSE_USERNAME = process.env.CLICKHOUSE_USER?.trim() || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
const PROBE_TIMEOUT_MS = 10_000;
const fixtureUrl = new URL(
	"./fixtures/cex-order-book-depth-summary-v2-conformance/v1/fixture.json",
	import.meta.url,
);

type Fixture = {
	accepted_cases: Array<{
		expected_writer: { row: Record<string, unknown> };
		expected_supported_view: Record<string, unknown>;
	}>;
};

let client: ClickHouseClient | undefined;
let clickhouseAvailable = false;
let fixture: Fixture;

async function probeClickHouse(): Promise<string | undefined> {
	const probe = createClient({
		url: CLICKHOUSE_URL,
		username: CLICKHOUSE_USERNAME,
		password: CLICKHOUSE_PASSWORD,
	});
	try {
		const result = await probe.query({
			query: "SELECT 1 AS ok",
			format: "JSONEachRow",
			abort_signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		const rows = (await result.json()) as Array<{ ok: number }>;
		return rows[0]?.ok === 1
			? undefined
			: "probe query did not return SELECT 1";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		await probe.close();
	}
}

async function cleanup(): Promise<void> {
	if (!client) return;
	await client.command({
		query: `
			ALTER TABLE market_data.cex_order_book_depth_summary
			DELETE WHERE startsWith(capture_bundle_id, 'summary-v2-fixture-bundle:')
		`,
	});
	await client.command({
		query: "OPTIMIZE TABLE market_data.cex_order_book_depth_summary FINAL",
	});
}

const decimalScalarFields = [
	"observed_farthest_bid",
	"observed_farthest_ask",
	"retained_farthest_bid",
	"retained_farthest_ask",
	"best_bid",
	"best_ask",
	"best_bid_amount",
	"best_ask_amount",
	"mid_price",
	"spread",
] as const;
const decimalArrayFields = [
	"bid_boundary_price_by_band",
	"ask_boundary_price_by_band",
	"bid_depth_by_band",
	"ask_depth_by_band",
] as const;

function typedProjectionSql(): string {
	return ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELD_NAMES.map((field) => {
		if ((decimalScalarFields as readonly string[]).includes(field)) {
			return `toDecimalString(${field}, 18) AS ${field}`;
		}
		if ((decimalArrayFields as readonly string[]).includes(field)) {
			return `arrayMap(value -> toDecimalString(value, 18), ${field}) AS ${field}`;
		}
		return field;
	}).join(",\n");
}

describe("ClickHouse summary-v2 conformance fixture", () => {
	beforeAll(async () => {
		fixture = (await Bun.file(fixtureUrl).json()) as Fixture;
		const failure = await probeClickHouse();
		if (failure) {
			if (process.env.CLICKHOUSE_REQUIRED === "1") {
				throw new Error(
					`Required ClickHouse integration service is unavailable at ${CLICKHOUSE_URL}: ${failure}`,
				);
			}
			return;
		}
		clickhouseAvailable = true;
		const bootstrap = createClient({
			url: CLICKHOUSE_URL,
			username: CLICKHOUSE_USERNAME,
			password: CLICKHOUSE_PASSWORD,
		});
		await bootstrap.command({
			query: "CREATE DATABASE IF NOT EXISTS market_data",
		});
		await bootstrap.close();
		client = createClient({
			url: CLICKHOUSE_URL,
			database: "market_data",
			username: CLICKHOUSE_USERNAME,
			password: CLICKHOUSE_PASSWORD,
		});
		await ensureArchiveSchema(client);
		await cleanup();
	});

	afterAll(async () => {
		if (!clickhouseAvailable || !client) return;
		await cleanup();
		await client.close();
	});

	test("real supported-view output matches the fixture typed projection", async () => {
		if (!clickhouseAvailable || !client) return;
		await client.insert({
			table: "market_data.cex_order_book_depth_summary",
			values: fixture.accepted_cases.map(
				({ expected_writer }) => expected_writer.row,
			),
			format: "JSONEachRow",
		});
		const result = await client.query({
			query: `
				SELECT ${typedProjectionSql()}
				FROM market_data.cex_order_book_depth_summary_canonical
				WHERE startsWith(capture_bundle_id, 'summary-v2-fixture-bundle:')
				ORDER BY source_time_ms, capture_bundle_id, exchange, trading_pair,
					raw_capture_id, snapshot_id, schema_version
			`,
			format: "JSONEachRow",
		});
		const actual = (await result.json()) as Array<Record<string, unknown>>;
		expect(actual).toEqual(
			fixture.accepted_cases.map(
				({ expected_supported_view }) => expected_supported_view,
			),
		);
	});
});
