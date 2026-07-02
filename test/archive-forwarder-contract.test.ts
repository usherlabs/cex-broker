import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArchiveBatchRequest } from "../services/archive-forwarder/router";
import { isSupportedTable } from "../services/archive-forwarder/types";

// Golden envelope authored by the HB-runtime ArchiveEmitter (fiet-maker:
// packages/hb-maker-shared/tests/fixtures/archive_forwarder_envelope.json) and
// copied here byte-for-byte. It pins the cross-repo wire contract: the emitter
// produces this shape and this forwarder must accept it. The contract was
// broken once (emitter sent flat rows -> every strategy_data batch 400'd), so a
// drift on either side must break a test in both repos.
const fixture = JSON.parse(
	readFileSync(
		path.join(import.meta.dir, "fixtures", "archive_forwarder_envelope.json"),
		"utf-8",
	),
) as unknown;

describe("archive forwarder wire contract (shared golden fixture)", () => {
	test("parseArchiveBatchRequest accepts the emitter envelope with no rejected rows", () => {
		const parsed = parseArchiveBatchRequest(fixture);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		expect(parsed.rejectedRowCount).toBe(0);
		expect(parsed.inputRowCount).toBe(parsed.batch.rows.length);
		expect(parsed.batch.source).toBe("hb_runtime");
	});

	test("every fixture row targets a supported table, covering all strategy_data tables", () => {
		const parsed = parseArchiveBatchRequest(fixture);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}

		for (const row of parsed.batch.rows) {
			expect(isSupportedTable(row.table)).toBe(true);
		}
		const tables = new Set(parsed.batch.rows.map((row) => row.table));
		expect(tables).toEqual(
			new Set([
				"strategy_data.policy_evaluation_events",
				"strategy_data.strategy_policy_snapshots",
				"strategy_data.inventory_settlement_events",
			]),
		);
	});
});
