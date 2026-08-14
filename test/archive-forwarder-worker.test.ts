import { describe, expect, test } from "bun:test";
import type { RowInserter } from "../services/archive-forwarder/insert";
import { StrategyArchiveSpool } from "../services/archive-forwarder/strategy-spool";
import {
	retryDelayMs,
	StrategySpoolWorker,
} from "../services/archive-forwarder/strategy-worker";
import type { ArchiveBatchRequest } from "../services/archive-forwarder/types";

function batch(): ArchiveBatchRequest {
	return {
		source: "hb_runtime",
		deployment_id: "maker-a",
		rows: [
			{
				table: "strategy_data.policy_evaluation_events",
				row: { schema_version: "1", seq: 1 },
			},
			{
				table: "strategy_data.inventory_settlement_events",
				row: { schema_version: "1", seq: 2 },
			},
		],
	};
}

describe("strategy spool retry worker", () => {
	test("uses the specified exponential schedule and jitter bounds", () => {
		expect(retryDelayMs(0, () => 0.5)).toBe(1_000);
		expect(retryDelayMs(1, () => 0.5)).toBe(2_000);
		expect(retryDelayMs(5, () => 0.5)).toBe(32_000);
		expect(retryDelayMs(6, () => 0.5)).toBe(60_000);
		expect(retryDelayMs(20, () => 0)).toBe(48_000);
		expect(retryDelayMs(20, () => 1)).toBe(72_000);
	});

	test("inserts each table with its persisted stable deduplication token", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		spool.admit(batch());
		const calls: Array<{ table: string; token?: string }> = [];
		const inserter: RowInserter = async (table, _rows, options) => {
			calls.push({ table, token: options?.deduplicationToken });
		};
		const worker = new StrategySpoolWorker({ spool, inserter });

		expect(await worker.drainOnce()).toEqual({
			completed: 2,
			retried: 0,
			terminal: 0,
			expired: 0,
		});
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => /^[a-f0-9]{64}$/.test(call.token ?? ""))).toBe(
			true,
		);
		expect(spool.stats().queuedBatches).toBe(0);
		spool.close();
	});

	test("retries only the failed sibling after the first delay", async () => {
		let now = 10_000;
		const spool = new StrategyArchiveSpool({
			path: ":memory:",
			now: () => now,
		});
		spool.admit(batch());
		const attempts = new Map<string, number>();
		const inserter: RowInserter = async (table) => {
			attempts.set(table, (attempts.get(table) ?? 0) + 1);
			if (
				table === "strategy_data.policy_evaluation_events" &&
				attempts.get(table) === 1
			) {
				throw new Error("connection reset");
			}
		};
		const worker = new StrategySpoolWorker({
			spool,
			inserter,
			now: () => now,
			random: () => 0.5,
		});

		expect(await worker.drainOnce()).toMatchObject({
			completed: 1,
			retried: 1,
		});
		expect(spool.stats()).toMatchObject({ queuedBatches: 1, queuedWork: 1 });
		expect(await worker.drainOnce()).toMatchObject({
			completed: 0,
			retried: 0,
		});
		now += 1_000;
		expect(await worker.drainOnce()).toMatchObject({
			completed: 1,
			retried: 0,
		});
		expect(attempts.get("strategy_data.inventory_settlement_events")).toBe(1);
		expect(attempts.get("strategy_data.policy_evaluation_events")).toBe(2);
		spool.close();
	});

	test("makes schema and authentication failures terminal without hot-looping", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		spool.admit({ ...batch(), rows: [batch().rows[0]] });
		let calls = 0;
		const worker = new StrategySpoolWorker({
			spool,
			inserter: async () => {
				calls += 1;
				throw new Error("unknown column archive_event_id");
			},
		});
		expect(await worker.drainOnce()).toMatchObject({ terminal: 1 });
		expect(await worker.drainOnce()).toMatchObject({ terminal: 0, retried: 0 });
		expect(calls).toBe(1);
		expect(spool.stats().terminalWork).toBe(1);
		spool.close();
	});
});
