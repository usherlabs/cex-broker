import { describe, expect, test } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";
import {
	applyHistoricalOrderBookRetirement,
	inventoryHistoricalOrderBookSchema,
	verifyHistoricalOrderBookRetirement,
} from "../services/archive-forwarder/scripts/order-book-schema-retirement";

type MockResult = Record<string, unknown>[];

function mockClient(responses: MockResult[]): {
	client: ClickHouseClient;
	queries: string[];
	commands: string[];
} {
	const queries: string[] = [];
	const commands: string[] = [];
	let queryIndex = 0;
	return {
		client: {
			query: async ({ query }: { query: string }) => {
				queries.push(query);
				const rows = responses[queryIndex++] ?? [];
				return { json: async () => rows };
			},
			command: async ({ query }: { query: string }) => {
				commands.push(query);
			},
		} as unknown as ClickHouseClient,
		queries,
		commands,
	};
}

const approval = {
	confirmDestructive: true,
	writersStopped: true,
	sourceRejectionDeployed: true,
	backupLocation: "s3://audit/cex-order-book-retirement/",
	maintenanceApproval: "change-1234",
};

describe("terminal order-book schema retirement tooling", () => {
	test("inventory is read-only and reports rows, objects, columns, and mutations", async () => {
		const { client, queries, commands } = mockClient([
			[{ external_rows: "3" }],
			[{ external_rows: "4" }],
			[
				{
					name: "cex_order_book_levels",
					engine: "MergeTree",
					engine_full: "TTL ...",
				},
			],
			[
				{
					table: "cex_order_book_levels",
					name: "capture_origin",
					type: "String",
				},
			],
			[
				{
					table: "cex_order_book_levels",
					mutation_id: "m1",
					command: "DELETE",
					is_done: 0,
					latest_fail_reason: "",
				},
			],
		]);
		const result = await inventoryHistoricalOrderBookSchema(client);
		expect(result.externalRows).toEqual({
			cex_order_book_levels: 3,
			cex_order_book_depth_summary: 4,
		});
		expect(queries).toHaveLength(5);
		expect(commands).toHaveLength(0);
		expect(queries.join("\n")).toContain("system.tables");
		expect(queries.join("\n")).toContain("system.columns");
		expect(queries.join("\n")).toContain("system.mutations");
	});

	test("apply fails before any command unless every destructive precondition is explicit", async () => {
		for (const incomplete of [
			{ ...approval, confirmDestructive: false },
			{ ...approval, writersStopped: false },
			{ ...approval, sourceRejectionDeployed: false },
			{ ...approval, backupLocation: "" },
			{ ...approval, maintenanceApproval: "" },
		]) {
			const { client, commands } = mockClient([]);
			await expect(
				applyHistoricalOrderBookRetirement(client, incomplete),
			).rejects.toThrow();
			expect(commands).toHaveLength(0);
		}
	});

	test("apply waits for mutations before TTL, drops, and column retirement", async () => {
		const { client, commands } = mockClient([
			[
				{
					table: "cex_order_book_levels",
					mutation_id: "m1",
					is_done: 0,
					latest_fail_reason: "",
				},
			],
			[
				{
					table: "cex_order_book_levels",
					mutation_id: "m1",
					is_done: 1,
					latest_fail_reason: "",
				},
				{
					table: "cex_order_book_depth_summary",
					mutation_id: "m2",
					is_done: 1,
					latest_fail_reason: "",
				},
			],
		]);
		await applyHistoricalOrderBookRetirement(client, approval, {
			mutationPollIntervalMs: 0,
			mutationTimeoutMs: 1_000,
		});
		expect(commands.slice(0, 2)).toEqual([
			"ALTER TABLE market_data.cex_order_book_levels DELETE WHERE source = 'external_backfill'",
			"ALTER TABLE market_data.cex_order_book_depth_summary DELETE WHERE source = 'external_backfill'",
		]);
		const joined = commands.join("\n");
		expect(joined).toContain("MODIFY TTL");
		expect(joined).toContain("INTERVAL 90 DAY");
		expect(joined).toContain("DROP VIEW IF EXISTS");
		expect(joined).toContain("DROP TABLE IF EXISTS");
		expect(joined).toContain("DROP COLUMN IF EXISTS capture_origin");
	});

	test("mutation failure and timeout stop before destructive follow-up", async () => {
		const failed = mockClient([
			[
				{
					table: "cex_order_book_levels",
					mutation_id: "m1",
					is_done: 0,
					latest_fail_reason: "disk failure",
				},
			],
		]);
		await expect(
			applyHistoricalOrderBookRetirement(failed.client, approval, {
				mutationPollIntervalMs: 0,
				mutationTimeoutMs: 10,
			}),
		).rejects.toThrow("disk failure");
		expect(failed.commands).toHaveLength(2);

		const timedOut = mockClient([
			[
				{
					table: "cex_order_book_levels",
					mutation_id: "m1",
					is_done: 0,
					latest_fail_reason: "",
				},
			],
		]);
		await expect(
			applyHistoricalOrderBookRetirement(timedOut.client, approval, {
				mutationPollIntervalMs: 1,
				mutationTimeoutMs: 0,
			}),
		).rejects.toThrow("timed out");
		expect(timedOut.commands).toHaveLength(2);
	});

	test("verify requires terminal absence and exact unconditional TTLs", async () => {
		const good = mockClient([
			[{ external_rows: "0" }],
			[{ external_rows: "0" }],
			[
				{
					name: "cex_order_book_levels",
					engine: "MergeTree",
					engine_full: "TTL toDateTime(...) + INTERVAL 90 DAY",
				},
				{
					name: "cex_order_book_depth_summary",
					engine: "MergeTree",
					engine_full: "TTL toDateTime(...) + INTERVAL 90 DAY",
				},
			],
			[],
			[],
		]);
		await expect(
			verifyHistoricalOrderBookRetirement(good.client),
		).resolves.toBeUndefined();

		const obsolete = mockClient([
			[{ external_rows: "0" }],
			[{ external_rows: "0" }],
			[
				{
					name: "cex_order_book_levels",
					engine: "MergeTree",
					engine_full: "TTL x + INTERVAL 90 DAY",
				},
				{
					name: "cex_order_book_depth_summary",
					engine: "MergeTree",
					engine_full: "TTL x + INTERVAL 90 DAY",
				},
				{
					name: "cex_archive_cluster_identity",
					engine: "MergeTree",
					engine_full: "MergeTree",
				},
			],
			[],
			[],
		]);
		await expect(
			verifyHistoricalOrderBookRetirement(obsolete.client),
		).rejects.toThrow("obsolete ClickHouse objects remain");
	});
});
