import type { ClickHouseClient } from "@clickhouse/client";
import path from "path";
import { clickHouseRequestDeadline } from "./clickhouse-deadline";

// SQL is packaged with this service. This scanner preserves quoted literals and
// identifiers: semicolons, parentheses and comment markers inside them are data.
export function splitSqlStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = "";
	let quote = "";
	let depth = 0;
	for (let i = 0; i < sql.length; i += 1) {
		const char = sql[i]!;
		if (quote) {
			current += char;
			if (char === "\\" && i + 1 < sql.length) current += sql[++i];
			else if (char === quote) {
				if (sql[i + 1] === quote) current += sql[++i];
				else quote = "";
			}
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
		else if (char === "-" && sql[i + 1] === "-") {
			while (i < sql.length && sql[i] !== "\n") i += 1;
			current += "\n";
			continue;
		} else if (char === "/" && sql[i + 1] === "*") {
			const end = sql.indexOf("*/", i + 2);
			if (end < 0) throw new Error("Unterminated schema comment");
			i = end + 1;
			current += " ";
			continue;
		} else if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth < 0) throw new Error("Unbalanced schema parentheses");
		} else if (char === ";" && depth === 0) {
			if (current.trim()) statements.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (quote || depth !== 0) throw new Error("Unterminated schema expression");
	if (current.trim()) statements.push(current.trim());
	return statements;
}

// These seven families deliberately share the broker's existing applier.
// Federation and derived observability retain their Maker-owned appliers.
export const ARCHIVE_SCHEMA_FILES = [
	"market_data.sql",
	"broker_execution.sql",
	"broker_account.sql",
	"broker_stream_health.sql",
	"strategy_data.sql",
	"fiet.sql",
] as const;

const OWNED_DATABASES = [
	"market_data", "broker_execution", "broker_account", "broker_stream_health",
	"strategy_data", "fiet_metrics", "fiet_telemetry",
] as const;

export function archiveSchemaFilePath(fileName: string): string {
	return path.resolve(import.meta.dir, "../../schema/clickhouse", fileName);
}

type Definition = { database: string; name: string; kind: string; query: string };
type InventoryRow = { database: string; name: string; uuid: string; create_table_query: string };

async function definitions(): Promise<Definition[]> {
	const result: Definition[] = [];
	const names = new Set<string>();
	for (const file of ARCHIVE_SCHEMA_FILES) {
		let database = "default";
		for (const statement of splitSqlStatements(await Bun.file(archiveSchemaFilePath(file)).text())) {
			const use = /^USE ([a-z_]+)$/i.exec(statement);
			if (use) { database = use[1]!; continue; }
			const create = /^CREATE (?:OR REPLACE )?(DATABASE|MATERIALIZED VIEW|TABLE|VIEW) (?:IF NOT EXISTS )?([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)([\s\S]*)$/i.exec(statement);
			if (!create) throw new Error(`Non-declarative statement in ${file}; source migration is not startup application`);
			const kind = create[1]!.toUpperCase();
			const parts = create[2]!.split(".");
			const db = kind === "DATABASE" ? parts[0]! : parts.length === 2 ? parts[0]! : database;
			const name = kind === "DATABASE" ? "" : parts.at(-1)!;
			if (!(OWNED_DATABASES as readonly string[]).includes(db)) throw new Error(`Unowned schema database ${db}`);
			const key = `${db}.${name}`;
			if (names.has(key)) throw new Error(`Duplicate schema definition ${key}`);
			names.add(key);
			result.push({ database: db, name, kind, query: `CREATE ${kind} ${kind === "DATABASE" ? db : `${db}.${name}`}${create[3]}` });
		}
	}
	return result;
}

// Compare server-formatted definitions, excluding generated object identities
// and the explicit spelling of MergeTree's 8192 default index granularity.
// Unknown server rewrites are refused; adoption must never guess equivalence.
function comparableDefinition(query: string): string {
	let text = query.replace(/^CREATE OR REPLACE /, "CREATE ").replace(/^(CREATE (?:MATERIALIZED VIEW|TABLE|VIEW)) IF NOT EXISTS /, "$1 ");
	text = text.replace(/^(CREATE (?:MATERIALIZED VIEW|TABLE|VIEW) \S+) UUID '[0-9a-f-]+'/, "$1");
	text = text.replace(/^(CREATE MATERIALIZED VIEW \S+) TO INNER UUID '[0-9a-f-]+'/, "$1");
	// ClickHouse Cloud documents this exact automatic MergeTree rewrite:
	// https://clickhouse.com/docs/cloud/reference/shared-merge-tree
	// Preserve engine-specific arguments and reject any unknown topology spelling.
	text = text.replace(/\bENGINE = Shared((?:Replacing|Summing|Aggregating)?MergeTree)\('\/clickhouse\/tables\/\{uuid\}\/\{shard\}', '\{replica\}'(?:, )?/, "ENGINE = $1(");
	text = text.replace(/\bENGINE = ((?:Replacing|Summing|Aggregating)?MergeTree)\(\)/, "ENGINE = $1");
	text = text.replace(/, index_granularity = 8192(?=,| AS |$)/, "");
	text = text.replace(/ SETTINGS index_granularity = 8192, /, " SETTINGS ");
	text = text.replace(/ SETTINGS index_granularity = 8192(?= AS |$)/, "");
	// Plain views acquire inferred result columns in SHOW CREATE. Their SELECT
	// defines those columns; upstream table definitions are checked separately.
	if (text.startsWith("CREATE VIEW ")) {
		const prefix = /^(CREATE VIEW \S+)\s+/.exec(text);
		if (prefix && text.slice(prefix[0].length).startsWith("(")) {
			let depth = 0;
			let quote = "";
			for (let i = prefix[0].length; i < text.length; i += 1) {
				const char = text[i]!;
				if (quote) {
					if (char === "\\") i += 1;
					else if (char === quote) quote = "";
				} else if (char === "'" || char === "`") quote = char;
				else if (char === "(") depth += 1;
				else if (char === ")" && --depth === 0) {
					text = `${prefix[1]}${text.slice(i + 1)}`;
					break;
				}
			}
		}
	}
	return text;
}

// Exported for the owner-approved column-order migration preflight, which must
// compare live definitions with exactly the applier's equivalence semantics.
// Startup stays strict: ensureArchiveSchema itself is untouched.
export async function formatted(client: ClickHouseClient, query: string): Promise<string> {
	const result = await client.query({
		query: "SELECT formatQuerySingleLine({definition:String}) AS definition",
		query_params: { definition: query }, format: "JSONEachRow",
		abort_signal: clickHouseRequestDeadline(),
	});
	const rows = await result.json<{ definition: string }>();
	if (rows.length !== 1 || typeof rows[0]?.definition !== "string") throw new Error("Missing formatted schema definition");
	return comparableDefinition(rows[0].definition);
}

async function describedColumns(client: ClickHouseClient, expression: string): Promise<string> {
	const result = await client.query({
		query: `DESCRIBE TABLE ${expression}`, format: "JSONEachRow",
		abort_signal: clickHouseRequestDeadline(),
	});
	const rows = await result.json<{ name: string; type: string; default_type: string; default_expression: string }>();
	if (!rows.length || rows.some((row) =>
		typeof row.name !== "string" || typeof row.type !== "string" ||
		typeof row.default_type !== "string" || typeof row.default_expression !== "string"
	)) {
		throw new Error("Missing source view column description");
	}
	return JSON.stringify(rows.map(({ name, type, default_type, default_expression }) => [name, type, default_type, default_expression]));
}

export async function ensureArchiveSchema(client: ClickHouseClient): Promise<void> {
	const desired = await definitions();
	const securityPolicy = await client.query({
		query: "SELECT value FROM system.server_settings WHERE name = 'ignore_empty_sql_security_in_create_view_query'",
		format: "JSONEachRow", abort_signal: clickHouseRequestDeadline(),
	});
	const securityRows = await securityPolicy.json<{ value: string }>();
	if (securityRows.length !== 1 || !["1", "true"].includes(securityRows[0]!.value)) {
		throw new Error("Source schema requires CREATE VIEW security to be stored as written; no DDL applied");
	}
	const inventory = await client.query({
		query: "SELECT database, name, uuid, create_table_query FROM system.tables WHERE database IN {databases:Array(String)}",
		query_params: { databases: OWNED_DATABASES }, format: "JSONEachRow",
		abort_signal: clickHouseRequestDeadline(),
	});
	const existing = new Map<string, InventoryRow>();
	for (const row of await inventory.json<InventoryRow>()) {
		const key = `${row.database}.${row.name}`;
		if (existing.has(key)) throw new Error(`Ambiguous schema object ${key}`);
		existing.set(key, row);
	}
	const dbResult = await client.query({
		query: "SELECT name, engine FROM system.databases WHERE name IN {databases:Array(String)}",
		query_params: { databases: OWNED_DATABASES }, format: "JSONEachRow",
		abort_signal: clickHouseRequestDeadline(),
	});
	const databases = new Set<string>();
	for (const row of await dbResult.json<{ name: string; engine: string }>()) {
		if (!["Atomic", "Shared"].includes(row.engine)) throw new Error(`Unsupported source database engine for ${row.name}`);
		databases.add(row.name);
	}
	const pending: Definition[] = [];
	// Complete the whole owner's preflight BEFORE creating even a database.
	for (const definition of desired) {
		if (definition.kind === "DATABASE") {
			if (!databases.has(definition.database)) pending.push(definition);
			continue;
		}
		const key = `${definition.database}.${definition.name}`;
		const row = existing.get(key);
		const expected = await formatted(client, definition.query);
		if (!row) { pending.push(definition); continue; }
		if (!row.create_table_query || await formatted(client, row.create_table_query) !== expected) {
			throw new Error(`Incompatible existing source definition ${key}; no DDL applied. Obtain owner-reviewed migration evidence before adoption`);
		}
		if (definition.kind === "MATERIALIZED VIEW") {
			// Atomic/Shared catalogs name the physical target from the VIEW UUID,
			// not the target UUID. Check it rather than ignoring every hidden table.
			// ClickHouse 25.12 StorageMaterializedView::generateInnerTableName.
			if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.uuid) || row.uuid === "00000000-0000-0000-0000-000000000000") {
				throw new Error(`Unknown materialized-view identity ${key}; no DDL applied`);
			}
			const innerName = `.inner_id.${row.uuid}`;
			const innerKey = `${definition.database}.${innerName}`;
			const inner = existing.get(innerKey);
			const selectOffset = definition.query.search(/\sAS\s+SELECT\s/i);
			if (!inner || selectOffset < 0) throw new Error(`Missing materialized-view storage for ${key}; no DDL applied`);
			const innerQuery = definition.query.slice(0, selectOffset).replace(/^CREATE MATERIALIZED VIEW \S+/, `CREATE TABLE ${definition.database}.\`${innerName}\``);
			if (await formatted(client, inner.create_table_query) !== await formatted(client, innerQuery)) {
				throw new Error(`Incompatible materialized-view storage for ${key}; no DDL applied`);
			}
			existing.delete(innerKey);
		}
		if (definition.kind === "VIEW") {
			const select = /^CREATE VIEW \S+ AS ([\s\S]+)$/.exec(expected);
			if (!select || await describedColumns(client, `(${select[1]})`) !== await describedColumns(client, key)) {
				throw new Error(`Incompatible existing source view columns ${key}; no DDL applied`);
			}
		}
		existing.delete(key);
	}
	if (existing.size) throw new Error(`Unknown source objects; no DDL applied: ${[...existing.keys()].join(", ")}`);
	// No IF NOT EXISTS or already-exists swallowing: a concurrent applier is an
	// error, not permission to adopt an object that escaped the preflight.
	for (const definition of pending) {
		await client.command({ query: definition.query, abort_signal: clickHouseRequestDeadline() });
	}
}

