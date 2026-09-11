import { createClient, type ClickHouseClient } from "@clickhouse/client";
import {
	archiveSchemaFilePath,
	formatted,
	splitSqlStatements,
} from "../schema";
import { clickHouseRequestDeadline } from "../clickhouse-deadline";

// Owner-approved explicit migration for the two settlement-capital tables.
//
// The deployed source created these tables before queue_class / reason_code /
// conflict_detail / open_state_version reached their canonical positions, so
// the startup applier (services/archive-forwarder/schema.ts) refuses them as
// incompatible. The difference is column ORDER only: same names, same
// types/defaults/codecs, same constraints, same engine/partition/sort key.
// This module moves those columns with single-statement metadata-only ALTERs
// (MODIFY COLUMN with unchanged type and FIRST/AFTER positioning rewrites no
// data) and leaves every other object — including startup strictness — alone.
//
// Never executed by startup. Operator-run only, after reviewing inventory.

export const CAPITAL_DATABASE = "fiet_telemetry";
const JOURNAL_TABLE = "obligation_journal";
const POSTINGS_TABLE = "custody_ledger_postings";

// Live column orders observed on the deployed source (read-only capture,
// 2026-09-11). Acceptance allowlist only: a table in any other order is
// unknown drift and refuses without changes.
const JOURNAL_OLD_ORDER = [
	"record_id", "payload_hash", "schema_revision", "obligation_id", "intent_id",
	"lifecycle_state", "state_version", "idempotency_key", "chain_id", "wallet_address",
	"canonical_token_address", "token_decimals", "custody_authority", "market_id", "pool_id",
	"commitment_id", "settlement_id", "direction", "gross_amount", "fulfilled_amount",
	"reserved_amount", "remaining_amount", "lease_id", "lease_holder", "lease_expires_at",
	"fencing_token", "rfs_open_since", "rfs_deadline_at", "rfs_phase", "rfs_blind_reason",
	"source_chain_id", "source_block_number", "source_block_timestamp", "source_tx_hash",
	"source_log_index", "producer_id", "producer_epoch", "sequence", "recorded_at",
	"reason_code", "queue_class", "conflict_detail", "open_state_version",
] as const;

const POSTINGS_OLD_ORDER = [
	"posting_id", "payload_hash", "schema_revision", "movement_id", "obligation_id",
	"intent_id", "idempotency_key", "posting_kind", "account_id", "account_kind",
	"chain_id", "wallet_address", "custody_authority", "asset_address", "asset_decimals",
	"delta_amount", "tx_hash", "log_index", "block_number", "block_timestamp",
	"producer_id", "producer_epoch", "sequence", "recorded_at", "open_state_version",
] as const;

export const CAPITAL_TABLES = [
	{ table: JOURNAL_TABLE, oldOrder: [...JOURNAL_OLD_ORDER] },
	{ table: POSTINGS_TABLE, oldOrder: [...POSTINGS_OLD_ORDER] },
] as const;

export type CapitalColumn = { name: string; definition: string };
export type ParsedCreateTable = {
	columns: CapitalColumn[];
	constraints: string[];
	tail: string;
};

export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

// Top-level comma split honoring parentheses and quoted literals, so commas
// inside IN-lists, function arguments, defaults and codecs never split.
export function splitTopLevelCommas(body: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	let quote = "";
	for (let i = 0; i < body.length; i += 1) {
		const char = body[i]!;
		if (quote) {
			current += char;
			if (char === "\\" && i + 1 < body.length) current += body[++i];
			else if (char === quote) quote = "";
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
		else if (char === "(") depth += 1;
		else if (char === ")") depth -= 1;
		if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts;
}

function columnName(entry: string): string {
	const match = /^`([^`]+)`|^([A-Za-z_][A-Za-z_0-9]*)/.exec(entry.trim());
	if (!match) throw new Error(`Unrecognized table entry ${entry.slice(0, 80)}`);
	return match[1] ?? match[2]!;
}

// Parses a CREATE TABLE statement (raw canonical text or server-normalized
// single-line text) into ordered columns, normalized constraints, and the
// engine/partition/sort tail after the column list.
export function parseCreateTable(statement: string): ParsedCreateTable {
	const normalized = collapseWhitespace(statement);
	const open = normalized.indexOf("(");
	if (open < 0) throw new Error("CREATE TABLE without column list");
	let depth = 0;
	let quote = "";
	let close = -1;
	for (let i = open; i < normalized.length; i += 1) {
		const char = normalized[i]!;
		if (quote) {
			if (char === "\\") i += 1;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
		else if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				close = i;
				break;
			}
		}
	}
	if (close < 0) throw new Error("Unterminated CREATE TABLE column list");
	const columns: CapitalColumn[] = [];
	const constraints: string[] = [];
	for (const part of splitTopLevelCommas(normalized.slice(open + 1, close))) {
		const entry = collapseWhitespace(part);
		if (!entry) continue;
		if (/^CONSTRAINT\s/i.test(entry)) constraints.push(entry);
		else columns.push({ name: columnName(entry), definition: entry });
	}
	return { columns, constraints: constraints.sort(), tail: collapseWhitespace(normalized.slice(close + 1)) };
}

export type CapitalCanonical = { statement: string; parsed: ParsedCreateTable };

// Loads the two canonical CREATE TABLE statements from the owning fiet.sql.
// Column definitions always come from this file; never from a second copy.
export async function loadCapitalCanonical(): Promise<Map<string, CapitalCanonical>> {
	const text = await Bun.file(archiveSchemaFilePath("fiet.sql")).text();
	const canonical = new Map<string, CapitalCanonical>();
	for (const statement of splitSqlStatements(text)) {
		const match = /^CREATE TABLE IF NOT EXISTS fiet_telemetry\.(obligation_journal|custody_ledger_postings)\b/i.exec(statement);
		if (match) canonical.set(match[1]!, { statement, parsed: parseCreateTable(statement) });
	}
	if (canonical.size !== CAPITAL_TABLES.length) {
		throw new Error("Canonical capital tables not found in fiet.sql; no DDL applied");
	}
	return canonical;
}

export type ReorderAction = {
	column: string;
	definition: string;
	after: string | null;
};

// Minimal FIRST/AFTER move plan from one column order to another, simulating
// each move so later anchors see earlier moves within the same ALTER.
export function planColumnMoves(
	fromOrder: readonly string[],
	toOrder: readonly string[],
	definitions: ReadonlyMap<string, string>,
): ReorderAction[] {
	const working = [...fromOrder];
	const actions: ReorderAction[] = [];
	toOrder.forEach((column, index) => {
		if (working[index] === column) return;
		const definition = definitions.get(column);
		if (definition === undefined) throw new Error(`No canonical definition for ${column}`);
		actions.push({ column, definition, after: index === 0 ? null : toOrder[index - 1]! });
		working.splice(working.indexOf(column), 1);
		working.splice(index, 0, column);
	});
	return actions;
}

// One atomic ALTER per table: ClickHouse applies a single ALTER query
// atomically, so a table never rests half-reordered.
export function buildReorderAlter(table: string, actions: readonly ReorderAction[]): string | null {
	if (actions.length === 0) return null;
	const clauses = actions.map((action) =>
		`MODIFY COLUMN ${action.definition} ${action.after === null ? "FIRST" : `AFTER \`${action.after}\``}`,
	);
	return `ALTER TABLE ${CAPITAL_DATABASE}.${table} ${clauses.join(", ")}`;
}

export type CapitalTableStatus = "current" | "migrate" | "refuse";

export function classifyCapitalOrder(
	liveOrder: readonly string[],
	canonicalOrder: readonly string[],
	oldOrder: readonly string[],
): CapitalTableStatus {
	const same = (a: readonly string[], b: readonly string[]) =>
		a.length === b.length && a.every((name, index) => name === b[index]);
	if (same(liveOrder, canonicalOrder)) return "current";
	if (same(liveOrder, oldOrder)) return "migrate";
	return "refuse";
}

export type CapitalTablePlan = {
	table: string;
	status: CapitalTableStatus;
	liveOrder: string[];
	alter: string | null;
	reason: string | null;
};

async function showCreateTable(client: ClickHouseClient, table: string): Promise<string> {
	const result = await client.query({
		query: `SHOW CREATE TABLE ${CAPITAL_DATABASE}.${table}`,
		format: "JSONEachRow",
		abort_signal: clickHouseRequestDeadline(),
	});
	const rows = await result.json<{ statement: string }>();
	if (rows.length !== 1 || typeof rows[0]?.statement !== "string") {
		throw new Error(`Missing SHOW CREATE for ${CAPITAL_DATABASE}.${table}`);
	}
	return rows[0].statement;
}

async function inspectCapitalTable(
	client: ClickHouseClient,
	table: string,
	oldOrder: readonly string[],
	canonical: CapitalCanonical,
): Promise<CapitalTablePlan> {
	const fail = (reason: string): CapitalTablePlan =>
		({ table, status: "refuse", liveOrder: [], alter: null, reason: `${reason}; no DDL applied` });
	try {
		const liveStatement = await showCreateTable(client, table);
		// Fast path with exactly the applier's equivalence semantics.
		const liveFormatted = await formatted(client, liveStatement);
		const canonicalFormatted = await formatted(client, canonical.statement);
		const live = parseCreateTable(liveFormatted);
		const want = parseCreateTable(canonicalFormatted);
		const liveOrder = live.columns.map((column) => column.name);
		if (liveFormatted === canonicalFormatted) {
			return { table, status: "current", liveOrder, alter: null, reason: null };
		}
		// Decomposed order-only proof on server-normalized text: same columns
		// with identical definitions, same constraints, same tail.
		const liveDefinitions = new Map(live.columns.map((column) => [column.name, column.definition]));
		const problems: string[] = [];
		if (live.columns.length !== want.columns.length) {
			problems.push(`column count ${live.columns.length} vs canonical ${want.columns.length}`);
		}
		for (const column of want.columns) {
			const liveDefinition = liveDefinitions.get(column.name);
			if (liveDefinition === undefined) problems.push(`missing column ${column.name}`);
			else if (liveDefinition !== column.definition) problems.push(`changed definition for ${column.name}`);
		}
		for (const column of live.columns) {
			if (!want.columns.some((wanted) => wanted.name === column.name)) {
				problems.push(`unknown column ${column.name}`);
			}
		}
		if (JSON.stringify(live.constraints) !== JSON.stringify(want.constraints)) {
			problems.push("constraint set differs from canonical");
		}
		if (live.tail !== want.tail) problems.push(`table tail differs: ${live.tail}`);
		if (problems.length > 0) return fail(`Incompatible existing definition ${table}: ${problems.join("; ")}`);
		const status = classifyCapitalOrder(liveOrder, want.columns.map((column) => column.name), oldOrder);
		if (status === "refuse") return fail(`Unknown column order for ${table}: ${liveOrder.join(", ")}`);
		if (status === "current") return { table, status, liveOrder, alter: null, reason: null };
		// Order-only difference in the known old shape. Build the ALTER from
		// authored canonical definitions, so fiet.sql stays the single source.
		const rawDefinitions = new Map(canonical.parsed.columns.map((column) => [column.name, column.definition]));
		const alter = buildReorderAlter(
			table,
			planColumnMoves(liveOrder, want.columns.map((column) => column.name), rawDefinitions),
		);
		if (!alter) return fail(`Old order already matches canonical order for ${table}`);
		return { table, status, liveOrder, alter, reason: null };
	} catch (error) {
		return fail(`Cannot prove order-only difference for ${table}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// Validates BOTH tables before any mutation is even planned for execution:
// a refusal anywhere means no ALTER runs anywhere.
export async function planCapitalColumnOrderMigration(
	client: ClickHouseClient,
): Promise<{ tables: CapitalTablePlan[] }> {
	const canonical = await loadCapitalCanonical();
	const tables: CapitalTablePlan[] = [];
	for (const { table, oldOrder } of CAPITAL_TABLES) {
		tables.push(await inspectCapitalTable(client, table, oldOrder, canonical.get(table)!));
	}
	return { tables };
}

export async function applyCapitalColumnOrderMigration(
	client: ClickHouseClient,
): Promise<{ applied: string[]; skipped: string[] }> {
	const { tables } = await planCapitalColumnOrderMigration(client);
	const refusals = tables.filter((plan) => plan.status === "refuse");
	if (refusals.length > 0) {
		throw new Error(
			`Refusing capital column-order migration; no DDL applied: ${refusals.map((plan) => `${plan.table}: ${plan.reason}`).join(" | ")}`,
		);
	}
	const applied: string[] = [];
	const skipped: string[] = [];
	for (const plan of tables) {
		if (plan.status === "current" || !plan.alter) {
			skipped.push(plan.table);
			continue;
		}
		await client.command({ query: plan.alter, abort_signal: clickHouseRequestDeadline() });
		applied.push(plan.table);
	}
	const recheck = await planCapitalColumnOrderMigration(client);
	const remaining = recheck.tables.filter((plan) => plan.status !== "current");
	if (remaining.length > 0) {
		throw new Error(
			`Capital column-order migration did not converge; no further DDL applied: ${remaining.map((plan) => plan.table).join(", ")}`,
		);
	}
	return { applied, skipped };
}

export async function verifyCapitalColumnOrder(
	client: ClickHouseClient,
): Promise<{ tables: Array<{ table: string; columns: number }> }> {
	const { tables } = await planCapitalColumnOrderMigration(client);
	const bad = tables.filter((plan) => plan.status !== "current");
	if (bad.length > 0) {
		throw new Error(
			`Capital column order not canonical: ${bad.map((plan) => `${plan.table} (${plan.status}: ${plan.reason ?? "unknown"})`).join(" | ")}`,
		);
	}
	return { tables: tables.map((plan) => ({ table: plan.table, columns: plan.liveOrder.length })) };
}

export async function inventoryCapitalColumnOrder(
	client: ClickHouseClient,
): Promise<{ tables: CapitalTablePlan[] }> {
	return planCapitalColumnOrderMigration(client);
}

if (import.meta.main) {
	const action = Bun.argv[2];
	if (!["inventory", "apply", "verify"].includes(action ?? "")) {
		throw new Error("usage: capital-column-order-migration.ts inventory|apply|verify");
	}
	const client = createClient({
		url:
			process.env.CLICKHOUSE_URL?.trim() ||
			`http://${process.env.CLICKHOUSE_HOST?.trim() || "localhost"}:${process.env.CLICKHOUSE_PORT?.trim() || "8123"}`,
		username: process.env.CLICKHOUSE_USER?.trim() || "default",
		password: process.env.CLICKHOUSE_PASSWORD ?? "",
	});
	try {
		if (action === "inventory") {
			const { tables } = await inventoryCapitalColumnOrder(client);
			console.info(JSON.stringify(tables, null, 2));
		} else if (action === "apply") {
			const report = await applyCapitalColumnOrderMigration(client);
			console.info(JSON.stringify({ ok: true, action: "apply-and-verify", ...report }));
		} else {
			const report = await verifyCapitalColumnOrder(client);
			console.info(JSON.stringify({ ok: true, action: "verify", ...report }));
		}
	} finally {
		await client.close();
	}
}
