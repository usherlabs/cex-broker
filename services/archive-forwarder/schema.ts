import type { ClickHouseClient } from "@clickhouse/client";
import path from "path";

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

export async function ensureMarketDataSchema(
	client: ClickHouseClient,
): Promise<void> {
	const schemaPath = path.resolve(
		import.meta.dir,
		"../../schema/clickhouse/market_data.sql",
	);
	const sql = await Bun.file(schemaPath).text();
	for (const statement of splitSqlStatements(sql)) {
		try {
			await client.command({ query: statement });
		} catch (error) {
			console.warn("Schema statement skipped:", error);
		}
	}
}
