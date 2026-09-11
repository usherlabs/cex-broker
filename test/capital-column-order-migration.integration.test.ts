import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { ensureArchiveSchema } from "../services/archive-forwarder/schema";
import {
	CAPITAL_TABLES,
	applyCapitalColumnOrderMigration,
	buildReorderAlter,
	loadCapitalCanonical,
	planColumnMoves,
	type CapitalCanonicalSet,
} from "../services/archive-forwarder/scripts/capital-column-order-migration";

const url = process.env.SOURCE_SCHEMA_TEST_URL;
const databases = [
	"market_data",
	"broker_execution",
	"broker_account",
	"broker_stream_health",
	"strategy_data",
	"fiet_metrics",
	"fiet_telemetry",
];
let client: ClickHouseClient;
let ownsFixture = false;

function literal(value: string | number | null): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// Every CHECK constraint on both tables is satisfied by construction:
// 64-hex identities, known lifecycle/queue/reason values, bounded U256
// amount strings, a complete lease-free OPEN row and a CLOSED deadline row.
const JOURNAL_ROW: Record<string, string | number | null> = {
	record_id: "aa".repeat(32),
	payload_hash: "bb".repeat(32),
	schema_revision: 3,
	obligation_id: "ob-migration-1",
	intent_id: "in-migration-1",
	lifecycle_state: "OPEN",
	queue_class: "Rfs",
	reason_code: "",
	conflict_detail: null,
	state_version: 7,
	open_state_version: 2,
	idempotency_key: "idem-migration-1",
	chain_id: 1,
	wallet_address: `0x${"11".repeat(20)}`,
	canonical_token_address: `0x${"22".repeat(20)}`,
	token_decimals: 6,
	custody_authority: "SELF",
	market_id: null,
	pool_id: null,
	commitment_id: null,
	settlement_id: null,
	direction: "DEPOSIT",
	gross_amount: "100",
	fulfilled_amount: "0",
	reserved_amount: "100",
	remaining_amount: "0",
	lease_id: null,
	lease_holder: null,
	lease_expires_at: null,
	fencing_token: 9,
	rfs_open_since: null,
	rfs_deadline_at: null,
	rfs_phase: "CLOSED",
	rfs_blind_reason: null,
	source_chain_id: null,
	source_block_number: null,
	source_block_timestamp: null,
	source_tx_hash: null,
	source_log_index: null,
	producer_id: "migration-test",
	producer_epoch: "epoch-test-1",
	sequence: 1,
	recorded_at: "2026-01-02 03:04:05.123456",
};

const POSTINGS_ROW: Record<string, string | number | null> = {
	posting_id: "cc".repeat(32),
	payload_hash: "dd".repeat(32),
	schema_revision: 1,
	movement_id: "mv-migration-1",
	obligation_id: "ob-migration-1",
	open_state_version: 4,
	intent_id: "in-migration-1",
	idempotency_key: "idem-posting-1",
	posting_kind: "TRANSFER",
	account_id: "acct-migration-1",
	account_kind: "WALLET",
	chain_id: 1,
	wallet_address: `0x${"11".repeat(20)}`,
	custody_authority: "SELF",
	asset_address: `0x${"22".repeat(20)}`,
	asset_decimals: 6,
	delta_amount: 100,
	tx_hash: `0x${"ee".repeat(32)}`,
	log_index: 3,
	block_number: 12345,
	block_timestamp: "2026-01-02 03:04:05.123456",
	producer_id: "migration-test",
	producer_epoch: "epoch-test-1",
	sequence: 1,
	recorded_at: "2026-01-02 03:04:05.123456",
};

async function liveColumnOrder(table: string): Promise<string[]> {
	const result = await client.query({
		query: `SELECT name FROM system.columns WHERE database = 'fiet_telemetry' AND table = '${table}' ORDER BY position`,
		format: "JSONEachRow",
	});
	return ((await result.json()) as Array<{ name: string }>).map((row) => row.name);
}

async function snapshotRows(
	table: string,
	order: readonly string[],
	keyColumn: string,
	keyValue: string,
): Promise<{ rows: unknown[]; hash: number; count: number }> {
	const selected = await client.query({
		query: `SELECT ${order.join(", ")} FROM fiet_telemetry.${table} WHERE ${keyColumn} = '${keyValue}'`,
		format: "JSONEachRow",
	});
	const rows = (await selected.json()) as unknown[];
	const counted = await client.query({
		query: `SELECT toUInt32(count()) AS n FROM fiet_telemetry.${table} WHERE ${keyColumn} = '${keyValue}'`,
		format: "JSONEachRow",
	});
	const count = ((await counted.json()) as Array<{ n: number }>)[0]!.n;
	return { rows, hash: Bun.hash(JSON.stringify(rows)), count };
}

async function reshapeTableToOld(
	table: string,
	oldOrder: readonly string[],
	canonical: CapitalCanonicalSet,
): Promise<void> {
	const parsed = canonical.get(table)!;
	const liveOrder = parsed.parsed.columns.map((c) => c.name);
	const definitions = new Map(parsed.parsed.columns.map((c) => [c.name, c.definition]));
	const reverse = buildReorderAlter(table, planColumnMoves(liveOrder, oldOrder, definitions));
	expect(reverse).not.toBeNull();
	await client.command({ query: reverse! });
	expect(await liveColumnOrder(table)).toEqual(oldOrder);
}

// This suite owns entire source databases. The integrator must give it a fresh,
// exclusive ClickHouse instance, not the shared archive integration endpoint.
describe.skipIf(!url)("capital column-order migration on an isolated instance", () => {
	beforeAll(async () => {
		if (!url) throw new Error("An exclusive source-schema fixture URL is required");
		client = createClient({
			url,
			username: process.env.CLICKHOUSE_USER ?? "default",
			password: process.env.CLICKHOUSE_PASSWORD ?? "",
		});
		const existing = await client.query({
			query: "SELECT name FROM system.databases WHERE name IN {names:Array(String)}",
			query_params: { names: databases },
			format: "JSONEachRow",
		});
		if ((await existing.json()).length !== 0) {
			throw new Error("Capital migration proof requires empty owned namespaces on an exclusive fixture");
		}
		ownsFixture = true;
	});

	afterAll(async () => {
		try {
			if (ownsFixture) {
				for (const database of databases) {
					await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
				}
			}
		} finally {
			await client?.close();
		}
	});

	test("fresh no-op, captured-shape migration with parity, reapply, mixed resume and refusal", async () => {
		await ensureArchiveSchema(client);
		const canonical = await loadCapitalCanonical();
		const journalOrder = canonical.get("obligation_journal")!.parsed.columns.map((c) => c.name);
		const postingsOrder = canonical.get("custody_ledger_postings")!.parsed.columns.map((c) => c.name);

		// Already canonical: nothing to do, and the call must succeed.
		await expect(applyCapitalColumnOrderMigration(client)).resolves.toEqual({
			applied: [],
			skipped: ["obligation_journal", "custody_ledger_postings"],
		});

		await client.command({
			query: `INSERT INTO fiet_telemetry.obligation_journal (${journalOrder.join(", ")}) VALUES (${journalOrder.map((c) => literal(JOURNAL_ROW[c]!)).join(", ")})`,
		});
		await client.command({
			query: `INSERT INTO fiet_telemetry.custody_ledger_postings (${postingsOrder.join(", ")}) VALUES (${postingsOrder.map((c) => literal(POSTINGS_ROW[c]!)).join(", ")})`,
		});
		const journalBefore = await snapshotRows("obligation_journal", journalOrder, "record_id", JOURNAL_ROW.record_id as string);
		const postingsBefore = await snapshotRows("custody_ledger_postings", postingsOrder, "posting_id", POSTINGS_ROW.posting_id as string);
		expect(journalBefore.count).toBe(1);
		expect(postingsBefore.count).toBe(1);

		// Reshape to the captured old orders using only canonical definitions.
		for (const { table, oldOrder } of CAPITAL_TABLES) {
			await reshapeTableToOld(table, oldOrder, canonical);
		}
		// Reordering alone preserves rows.
		expect((await snapshotRows("obligation_journal", journalOrder, "record_id", JOURNAL_ROW.record_id as string)).hash).toBe(journalBefore.hash);
		expect((await snapshotRows("custody_ledger_postings", postingsOrder, "posting_id", POSTINGS_ROW.posting_id as string)).hash).toBe(postingsBefore.hash);

		// The migration restores canonical order with identical rows and hashes.
		await expect(applyCapitalColumnOrderMigration(client)).resolves.toEqual({
			applied: ["obligation_journal", "custody_ledger_postings"],
			skipped: [],
		});
		expect(await liveColumnOrder("obligation_journal")).toEqual(journalOrder);
		expect(await liveColumnOrder("custody_ledger_postings")).toEqual(postingsOrder);
		const journalAfter = await snapshotRows("obligation_journal", journalOrder, "record_id", JOURNAL_ROW.record_id as string);
		const postingsAfter = await snapshotRows("custody_ledger_postings", postingsOrder, "posting_id", POSTINGS_ROW.posting_id as string);
		expect(journalAfter.rows).toEqual(journalBefore.rows);
		expect(journalAfter.hash).toBe(journalBefore.hash);
		expect(postingsAfter.rows).toEqual(postingsBefore.rows);
		expect(postingsAfter.hash).toBe(postingsBefore.hash);

		// Reapply converges without touching anything.
		await expect(applyCapitalColumnOrderMigration(client)).resolves.toEqual({
			applied: [],
			skipped: ["obligation_journal", "custody_ledger_postings"],
		});

		// Mixed current/old resumes per table: only the stale journal migrates
		// while the current postings table is left alone.
		await reshapeTableToOld("obligation_journal", CAPITAL_TABLES[0]!.oldOrder, canonical);
		await expect(applyCapitalColumnOrderMigration(client)).resolves.toEqual({
			applied: ["obligation_journal"],
			skipped: ["custody_ledger_postings"],
		});
		expect(await liveColumnOrder("obligation_journal")).toEqual(journalOrder);
		expect(await liveColumnOrder("custody_ledger_postings")).toEqual(postingsOrder);
		const journalResumed = await snapshotRows("obligation_journal", journalOrder, "record_id", JOURNAL_ROW.record_id as string);
		expect(journalResumed.rows).toEqual(journalBefore.rows);
		expect(journalResumed.hash).toBe(journalBefore.hash);

		// Refusal oracle with teeth: the FIRST table is pending-old (an unsafe
		// sequential applier would migrate it) while the SECOND carries genuine
		// property drift. The full preflight must refuse both, leaving the
		// pending journal still old and every row unchanged.
		await reshapeTableToOld("obligation_journal", CAPITAL_TABLES[0]!.oldOrder, canonical);
		await client.command({
			query: "ALTER TABLE fiet_telemetry.custody_ledger_postings MODIFY COLUMN delta_amount Int64 CODEC(ZSTD(1))",
		});
		await expect(applyCapitalColumnOrderMigration(client)).rejects.toThrow(/no DDL applied/);
		expect(await liveColumnOrder("obligation_journal")).toEqual(CAPITAL_TABLES[0]!.oldOrder);
		expect(await liveColumnOrder("custody_ledger_postings")).toEqual(postingsOrder);
		const journalKept = await snapshotRows("obligation_journal", journalOrder, "record_id", JOURNAL_ROW.record_id as string);
		expect(journalKept.rows).toEqual(journalBefore.rows);
		expect(journalKept.hash).toBe(journalBefore.hash);
		const postingsKept = await snapshotRows("custody_ledger_postings", postingsOrder, "posting_id", POSTINGS_ROW.posting_id as string);
		expect(postingsKept.rows).toEqual(postingsBefore.rows);
		expect(postingsKept.hash).toBe(postingsBefore.hash);
	}, 240_000);
});
