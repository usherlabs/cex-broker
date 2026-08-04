import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	classifyStrategyArchiveBatch,
	validateStrategyArchiveBatch,
} from "../services/archive-forwarder/strategy-contract";
import fixture from "./fixtures/archive_forwarder_envelope.json";

const PINNED_MAKER_FIXTURE_SHA256 =
	"5c9fd679a5a05ebce5f5158f4cc376360f24a34d9a07edeee43e94e564db3ee7";

const strategyTables = [
	"strategy_data.policy_evaluation_events",
	"strategy_data.strategy_policy_snapshots",
	"strategy_data.market_identity",
	"strategy_data.symbol_mapping",
	"strategy_data.inventory_settlement_events",
] as const;

function v2Row(
	table: (typeof strategyTables)[number],
	seq: number,
	source = "hb_runtime",
) {
	return {
		table,
		row: {
			source,
			deployment_id: "maker-a",
			schema_version: "2",
			producer_id: `${source}:maker-a:controller-a`,
			producer_run_id: "run-a",
			stream_name: table,
			stream_seq: 1,
			seq,
			archive_event_id: `run-a:${table}:1`,
		},
	};
}

function batch(rows: unknown[], source = "hb_runtime") {
	return { source, deployment_id: "maker-a", rows };
}

describe("Maker strategy archive contract", () => {
	test("pins the exact Maker v2 fixture bytes and accepts every row", async () => {
		const bytes = await Bun.file(
			new URL("./fixtures/archive_forwarder_envelope.json", import.meta.url),
		).arrayBuffer();
		expect(
			createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
		).toBe(PINNED_MAKER_FIXTURE_SHA256);
		expect(validateStrategyArchiveBatch(fixture).ok).toBe(true);
	});

	test("accepts one v2 row for every approved strategy table", () => {
		const rows = strategyTables.map((table, index) => v2Row(table, index + 1));
		expect(validateStrategyArchiveBatch(batch(rows))).toEqual({ ok: true });
	});

	test("accepts maker_replay v2 rows for every approved strategy table", () => {
		const rows = strategyTables.map((table, index) =>
			v2Row(table, index + 1, "maker_replay"),
		);
		expect(validateStrategyArchiveBatch(batch(rows, "maker_replay"))).toEqual({
			ok: true,
		});
		expect(classifyStrategyArchiveBatch(batch(rows, "maker_replay"))).toBe(
			"strategy_replay",
		);
	});

	test.each([
		undefined,
		"",
		"1",
	])("accepts legacy schema version %p without v2 identity", (schemaVersion) => {
		const row: Record<string, unknown> = {
			source: "hb_runtime",
			deployment_id: "maker-a",
			seq: 1,
		};
		if (schemaVersion !== undefined) row.schema_version = schemaVersion;
		expect(
			validateStrategyArchiveBatch(
				batch([{ table: "strategy_data.policy_evaluation_events", row }]),
			).ok,
		).toBe(true);
	});

	test.each([
		["unknown version", { schema_version: "3" }],
		["missing producer id", { producer_id: "" }],
		["zero stream sequence", { stream_seq: 0 }],
		["fractional seq", { seq: 1.5 }],
	])("rejects v2 %s", (_name, override) => {
		const entry = v2Row("strategy_data.policy_evaluation_events", 1);
		Object.assign(entry.row, override);
		expect(validateStrategyArchiveBatch(batch([entry])).ok).toBe(false);
	});

	test("accepts lossless decimal UInt64 strings and rejects overflow", () => {
		const entry = v2Row("strategy_data.policy_evaluation_events", 1);
		Object.assign(entry.row, {
			stream_seq: "18446744073709551615",
			seq: "18446744073709551615",
		});
		expect(validateStrategyArchiveBatch(batch([entry])).ok).toBe(true);
		entry.row.seq = "18446744073709551616";
		expect(validateStrategyArchiveBatch(batch([entry])).ok).toBe(false);
	});

	test("rejects empty envelope identity and empty rows", () => {
		expect(validateStrategyArchiveBatch({ ...batch([]), source: " " }).ok).toBe(
			false,
		);
		expect(
			validateStrategyArchiveBatch({ ...batch([]), deployment_id: "" }).ok,
		).toBe(false);
		expect(validateStrategyArchiveBatch(batch([])).ok).toBe(false);
	});

	test("rejects mixed tables, mixed sources, and row provenance mismatch", () => {
		const strategy = v2Row("strategy_data.policy_evaluation_events", 1);
		expect(
			validateStrategyArchiveBatch(
				batch([
					strategy,
					{ table: "market_data.cex_trades", row: { source: "hb_runtime" } },
				]),
			).ok,
		).toBe(false);
		expect(
			classifyStrategyArchiveBatch({
				source: "broker_write",
				deployment_id: "maker-a",
				rows: [strategy],
			}),
		).toBe("invalid_strategy_source");
		strategy.row.deployment_id = "maker-b";
		expect(validateStrategyArchiveBatch(batch([strategy])).ok).toBe(false);
	});

	test("classifies non-strategy traffic for the direct path", () => {
		expect(
			classifyStrategyArchiveBatch({
				source: "broker_read",
				deployment_id: "broker-a",
				rows: [
					{ table: "market_data.cex_trades", row: { source: "broker_read" } },
				],
			}),
		).toBe("direct");
	});

	test("rejects reserved strategy sources on non-strategy and mixed batches", () => {
		for (const source of ["hb_runtime", "maker_replay"]) {
			expect(
				classifyStrategyArchiveBatch({
					source,
					deployment_id: "maker-a",
					rows: [
						{
							table: "market_data.cex_trades",
							row: { source },
						},
					],
				}),
			).toBe("invalid_strategy_mix");
		}
	});
});
