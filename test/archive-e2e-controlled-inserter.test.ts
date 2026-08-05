import { describe, expect, test } from "bun:test";
import type { RowInserter } from "../services/archive-forwarder/insert";
import {
	createBlockedInserter,
	createScriptedInserter,
} from "./e2e/archive/support/controlled-inserter";

const TABLE = "market_data.candles" as const;

describe("archive E2E controlled inserters", () => {
	test("holds insertion until its explicit barrier is released", async () => {
		const calls: unknown[] = [];
		const delegate: RowInserter = async (_table, rows) => {
			calls.push(rows);
		};
		const controlled = createBlockedInserter(delegate);
		const pending = controlled.inserter(TABLE, [{ id: "row-1" }]);
		await controlled.requestStarted.promise;
		expect(controlled.attempts).toBe(1);
		expect(calls).toEqual([]);
		controlled.release();
		await pending;
		expect(calls).toEqual([[{ id: "row-1" }]]);
	});

	test("fails the scripted attempts and then invokes production storage", async () => {
		let stored = 0;
		const controlled = createScriptedInserter(async () => {
			stored += 1;
		}, 1);
		await expect(controlled.inserter(TABLE, [{}])).rejects.toThrow(
			"scripted ClickHouse Local insertion failure 1",
		);
		await controlled.inserter(TABLE, [{}]);
		expect(controlled.attempts).toBe(2);
		expect(stored).toBe(1);
	});
});
