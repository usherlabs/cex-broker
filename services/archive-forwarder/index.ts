import { createClient } from "@clickhouse/client";
import { isArchiveRequestAuthorized } from "./auth";
import { loadForwarderConfig } from "./config";
import { createClickHouseInserter } from "./insert";
import { pingClickHouse } from "./health";
import {
	MAX_ARCHIVE_ROWS,
	isArchiveBodyTooLarge,
	readBoundedArchiveBody,
} from "./limits";
import { handleArchiveBatch, parseArchiveBatchRequest } from "./router";
import { ensureArchiveSchema } from "./schema";

const config = loadForwarderConfig();
const clickhouse = createClient({
	url: `http://${config.clickhouse.host}:${config.clickhouse.port}`,
	username: config.clickhouse.username,
	password: config.clickhouse.password,
	database: config.clickhouse.database,
	// broker_execution.transfer_events/fill_events use DateTime64 columns; producers
	// emit broker_observed_timestamp/exchange_timestamp as ISO-8601 UTC strings, so
	// the inserter must best-effort-parse them (basic mode rejects the 'T'/'Z' form).
	// Strictly more lenient than basic, so it never breaks the existing String/Int64
	// timestamp columns on the other archive tables.
	clickhouse_settings: { date_time_input_format: "best_effort" },
});
const inserter = createClickHouseInserter(clickhouse);

try {
	await ensureArchiveSchema(clickhouse);
	console.log(
		"ClickHouse archive schema ensured (market_data, broker_execution, strategy_data)",
	);
} catch (error) {
	console.error("Failed to ensure ClickHouse schema:", error);
	process.exit(1);
}

const server = Bun.serve({
	port: config.port,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			const clickhouseOk = await pingClickHouse(clickhouse);
			return Response.json(
				{ status: clickhouseOk ? "ok" : "degraded", clickhouse: clickhouseOk },
				{ status: clickhouseOk ? 200 : 503 },
			);
		}

		if (request.method === "POST" && url.pathname === "/archive") {
			if (!isArchiveRequestAuthorized(request, config.authToken)) {
				return Response.json({ error: "Unauthorized" }, { status: 401 });
			}

			if (isArchiveBodyTooLarge(request.headers.get("content-length"))) {
				return Response.json({ error: "Request body too large" }, { status: 413 });
			}

			let bodyText: string;
			const bodyRead = await readBoundedArchiveBody(request);
			if (!bodyRead.ok) {
				return Response.json(
					{
						error:
							bodyRead.status === 413
								? "Request body too large"
								: "Failed to read request body",
					},
					{ status: bodyRead.status },
				);
			}
			bodyText = bodyRead.text;

			let body: unknown;
			try {
				body = JSON.parse(bodyText);
			} catch {
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}

			const parsed = parseArchiveBatchRequest(body);
			if (!parsed.ok) {
				return Response.json(
					{ error: "Invalid archive batch payload" },
					{ status: 400 },
				);
			}

			if (parsed.rejectedRowCount > 0) {
				// Name the offending tables: an unknown table (e.g. a forgotten
				// SUPPORTED_TABLES entry for a new archive table) would otherwise reject
				// the whole batch with only a count, hiding which table is at fault.
				console.warn(
					`Rejected ${parsed.rejectedRowCount}/${parsed.inputRowCount} archive row(s) from ${parsed.batch.source}; tables: ${parsed.rejectedTables.join(", ")}`,
				);
				return Response.json(
					{
						error: "Malformed archive rows in batch",
						rejected: parsed.rejectedRowCount,
						inputRows: parsed.inputRowCount,
						rejectedTables: parsed.rejectedTables,
					},
					{ status: 400 },
				);
			}

			if (parsed.batch.rows.length > MAX_ARCHIVE_ROWS) {
				return Response.json(
					{
						error: "Too many archive rows in batch",
						maxRows: MAX_ARCHIVE_ROWS,
						received: parsed.batch.rows.length,
					},
					{ status: 413 },
				);
			}

			try {
				const result = await handleArchiveBatch(inserter, parsed.batch);
				if (result.skipped > 0) {
					console.warn(
						`Skipped ${result.skipped} unsupported archive row(s) from ${parsed.batch.source}`,
					);
				}
				if (result.failed > 0) {
					console.warn(
						`Failed ${result.failed} archive row(s) from ${parsed.batch.source}: ${result.failedTables.join(", ")}`,
					);
					return Response.json(
						{ error: "Archive insert failed", ...result },
						{ status: 500 },
					);
				}
				return Response.json({ ok: true, ...result });
			} catch (error) {
				console.error("Archive insert failed:", error);
				return Response.json(
					{ error: "Archive insert failed" },
					{ status: 500 },
				);
			}
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
});

console.log(
	`Archive forwarder listening on http://0.0.0.0:${server.port}/archive`,
);
console.log(
	`ClickHouse target: ${config.clickhouse.host}:${config.clickhouse.port}/${config.clickhouse.database}`,
);
