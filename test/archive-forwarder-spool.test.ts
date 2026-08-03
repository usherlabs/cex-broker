import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	StrategyArchiveSpool,
	StrategySpoolQuotaError,
	StrategySpoolUnavailableError,
} from "../services/archive-forwarder/strategy-spool";
import type { ArchiveBatchRequest } from "../services/archive-forwarder/types";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function spoolPath(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "cex-forwarder-spool-"));
	tempDirs.push(directory);
	return path.join(directory, "spool.sqlite");
}

function strategyBatch(
	tables = [
		"strategy_data.policy_evaluation_events",
		"strategy_data.inventory_settlement_events",
	],
): ArchiveBatchRequest {
	return {
		source: "hb_runtime",
		deployment_id: "maker-a",
		rows: tables.map((table, index) => ({
			table,
			row: {
				source: "hb_runtime",
				deployment_id: "maker-a",
				schema_version: "1",
				seq: index + 1,
				payload_json: JSON.stringify({ index }),
			},
		})),
	};
}

describe("strategy archive SQLite spool", () => {
	test("atomically admits one work item per represented table", () => {
		const spool = new StrategyArchiveSpool({ path: spoolPath() });
		const admitted = spool.admit(strategyBatch());
		const stats = spool.stats();
		const due = spool.dueWork();

		expect(admitted.accountedBytes).toBeGreaterThan(0);
		expect(stats.queuedBatches).toBe(1);
		expect(stats.queuedWork).toBe(2);
		expect(stats.accountedBytes).toBe(admitted.accountedBytes);
		expect(due.map((work) => work.table).sort()).toEqual([
			"strategy_data.inventory_settlement_events",
			"strategy_data.policy_evaluation_events",
		]);
		expect(new Set(due.map((work) => work.dedupeToken)).size).toBe(2);
		spool.close();
	});

	test("preserves incomplete work and stable tokens across restart", () => {
		const file = spoolPath();
		const first = new StrategyArchiveSpool({ path: file });
		first.admit(strategyBatch());
		const before = first.dueWork();
		first.complete(before[0]);
		const remainingToken = first.dueWork()[0].dedupeToken;
		first.close();

		const restarted = new StrategyArchiveSpool({ path: file });
		expect(restarted.stats()).toMatchObject({
			queuedBatches: 1,
			queuedWork: 1,
		});
		expect(restarted.dueWork()[0].dedupeToken).toBe(remainingToken);
		restarted.close();
	});

	test("deletes a batch only after every table completes", () => {
		const spool = new StrategyArchiveSpool({ path: spoolPath() });
		spool.admit(strategyBatch());
		const [first, second] = spool.dueWork();
		spool.complete(first);
		expect(spool.stats()).toMatchObject({ queuedBatches: 1, queuedWork: 1 });
		spool.complete(second);
		expect(spool.stats()).toMatchObject({
			queuedBatches: 0,
			queuedWork: 0,
			accountedBytes: 0,
		});
		spool.close();
	});

	test("rejects atomically when deterministic accounting exceeds quota", () => {
		const probe = new StrategyArchiveSpool({ path: ":memory:" });
		const required = probe.accountedBytes(strategyBatch());
		probe.close();
		const spool = new StrategyArchiveSpool({
			path: spoolPath(),
			limits: { maxBytes: required - 1 },
		});
		expect(() => spool.admit(strategyBatch())).toThrow(StrategySpoolQuotaError);
		expect(spool.stats()).toMatchObject({ queuedBatches: 0, queuedWork: 0 });
		spool.close();
	});

	test("expires work at the fixed retention boundary", () => {
		let now = 10_000;
		const spool = new StrategyArchiveSpool({
			path: spoolPath(),
			now: () => now,
			limits: { retentionMs: 1_000 },
		});
		spool.admit(strategyBatch());
		now = 10_999;
		expect(spool.expire()).toBe(0);
		now = 11_000;
		expect(spool.expire()).toBe(2);
		expect(spool.stats()).toMatchObject({ queuedBatches: 0, queuedWork: 0 });
		spool.close();
	});

	test("reschedules transient work and retains terminal failures", () => {
		let now = 10_000;
		const spool = new StrategyArchiveSpool({
			path: spoolPath(),
			now: () => now,
		});
		spool.admit(strategyBatch(["strategy_data.policy_evaluation_events"]));
		const work = spool.dueWork()[0];
		spool.reschedule(work, {
			nextAttemptAtMs: 11_000,
			errorClass: "connection",
		});
		expect(spool.dueWork()).toHaveLength(0);
		now = 11_000;
		expect(spool.dueWork()[0].attemptCount).toBe(1);
		spool.markTerminal(spool.dueWork()[0], "schema");
		expect(spool.dueWork()).toHaveLength(0);
		expect(spool.stats()).toMatchObject({ terminalWork: 1, queuedWork: 1 });
		spool.close();
	});

	test("serializes concurrent quota reservation without over-admission", async () => {
		const probe = new StrategyArchiveSpool({ path: ":memory:" });
		const required = probe.accountedBytes(strategyBatch());
		probe.close();
		const spool = new StrategyArchiveSpool({
			path: spoolPath(),
			limits: { maxBytes: required },
		});
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, () =>
				Promise.resolve().then(() => spool.admit(strategyBatch())),
			),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(7);
		expect(spool.stats().queuedBatches).toBe(1);
		spool.close();
	});

	test("fails closed when the SQLite file is corrupt", () => {
		const file = spoolPath();
		writeFileSync(file, "not-a-sqlite-database");
		expect(() => new StrategyArchiveSpool({ path: file })).toThrow(
			StrategySpoolUnavailableError,
		);
	});

	test("wraps post-start write failures as spool unavailability", () => {
		const spool = new StrategyArchiveSpool({ path: spoolPath() });
		spool.close();
		expect(() => spool.admit(strategyBatch())).toThrow(
			StrategySpoolUnavailableError,
		);
	});

	test("health fails when an on-disk spool becomes read-only", () => {
		const file = spoolPath();
		const spool = new StrategyArchiveSpool({ path: file });
		chmodSync(file, 0o444);
		try {
			// The existing connection can retain write access on some Unix filesystems;
			// a reopened connection must still prove the persisted path is writable.
			spool.close();
			const readOnly = new StrategyArchiveSpool({ path: file });
			expect(() => readOnly.assertWritable()).toThrow(
				StrategySpoolUnavailableError,
			);
			readOnly.close();
		} finally {
			chmodSync(file, 0o644);
		}
	});
});
