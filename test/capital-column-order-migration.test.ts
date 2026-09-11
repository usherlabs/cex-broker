import { describe, expect, test } from "bun:test";
import {
	parseCreateTable,
	splitTopLevelCommas,
} from "../services/archive-forwarder/scripts/capital-column-order-migration";

// The integration fixture proves canonical order, migration, reapply and
// refusal against a live server. These two stay because they pin the only
// server-independent failure mode: silently misreading fiet.sql. A naive
// comma split or a broken paren/quote scan would corrupt column definitions
// and build wrong ALTERs (or false refusals) long before any server round.
describe("capital column-order migration pure helpers", () => {
	test("splits top-level commas without touching nested lists and literals", () => {
		expect(
			splitTopLevelCommas(
				"`a` String, `b` Enum8('x' = 1, 'y' = 2), CONSTRAINT c CHECK a IN ('p,q', 'r')",
			),
		).toEqual([
			"`a` String",
			" `b` Enum8('x' = 1, 'y' = 2)",
			" CONSTRAINT c CHECK a IN ('p,q', 'r')",
		]);
		expect(splitTopLevelCommas("`d` String DEFAULT 'a,b(c)'")).toEqual([
			"`d` String DEFAULT 'a,b(c)'",
		]);
	});

	test("parses columns, sorted constraints and tail", () => {
		const parsed = parseCreateTable(
			"CREATE TABLE IF NOT EXISTS d.t (`b` UInt8, `a` String DEFAULT 'x', CONSTRAINT z CHECK b > 0, CONSTRAINT a CHECK length(a) > 0) ENGINE = MergeTree ORDER BY b",
		);
		expect(parsed.columns.map((column) => column.name)).toEqual(["b", "a"]);
		expect(parsed.constraints).toEqual([
			"CONSTRAINT a CHECK length(a) > 0",
			"CONSTRAINT z CHECK b > 0",
		]);
		expect(parsed.tail).toBe("ENGINE = MergeTree ORDER BY b");
	});
});
