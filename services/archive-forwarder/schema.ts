import type { ClickHouseClient } from "@clickhouse/client";
import path from "path";
import { clickHouseRequestDeadline } from "./clickhouse-deadline";

function stripSqlComments(sql: string): string {
	return sql.replace(/--[^\n]*/g, "");
}

function splitSqlStatements(sql: string): string[] {
	const cleaned = stripSqlComments(sql);
	const statements: string[] = [];
	let depth = 0;
	let current = "";

	for (const char of cleaned) {
		current += char;
		if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth = Math.max(0, depth - 1);
		} else if (char === ";" && depth === 0) {
			const statement = current.trim();
			if (statement.length > 1) {
				statements.push(statement);
			}
			current = "";
		}
	}

	const trailing = current.trim();
	if (trailing.length > 0) {
		statements.push(trailing);
	}

	return statements;
}

function isIdempotentSchemaError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: String(error);
	const normalized = message.toLowerCase();
	return (
		normalized.includes("already exists") ||
		normalized.includes("table already exists") ||
		normalized.includes("table_exists") ||
		normalized.includes("database already exists")
	);
}

// Every archive database owned by the forwarder. Each file self-creates its
// database and tables idempotently; the forwarder fail-closes if any cannot be
// applied (see index.ts).
const ARCHIVE_SCHEMA_FILES = [
	"market_data.sql",
	"broker_execution.sql",
	"broker_account.sql",
	"broker_stream_health.sql",
	"strategy_data.sql",
] as const;

async function applySchemaFile(
	client: ClickHouseClient,
	fileName: string,
): Promise<void> {
	const schemaPath = path.resolve(
		import.meta.dir,
		"../../schema/clickhouse",
		fileName,
	);
	const sql = await Bun.file(schemaPath).text();
	for (const statement of splitSqlStatements(sql)) {
		try {
			await client.command({
				query: statement,
				abort_signal: clickHouseRequestDeadline(),
			});
		} catch (error) {
			if (isIdempotentSchemaError(error)) {
				continue;
			}
			throw error;
		}
	}
}

export async function ensureArchiveSchema(
	client: ClickHouseClient,
): Promise<void> {
	for (const fileName of ARCHIVE_SCHEMA_FILES) {
		await applySchemaFile(client, fileName);
	}
}
