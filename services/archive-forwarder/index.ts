import { createClient } from "@clickhouse/client";
import { isArchiveRequestAuthorized } from "./auth";
import { loadForwarderConfig } from "./config";
import { createClickHouseInserter } from "./insert";
import { pingClickHouse } from "./health";
import {
	MAX_ARCHIVE_BODY_BYTES,
	MAX_ARCHIVE_ROWS,
	isArchiveBodyTooLarge,
} from "./limits";
import { handleArchiveBatch, parseArchiveBatchRequest } from "./router";
import { ensureMarketDataSchema } from "./schema";

const config = loadForwarderConfig();
const clickhouse = createClient({
	url: `http://${config.clickhouse.host}:${config.clickhouse.port}`,
	username: config.clickhouse.username,
	password: config.clickhouse.password,
	database: config.clickhouse.database,
});
const inserter = createClickHouseInserter(clickhouse);

try {
	await ensureMarketDataSchema(clickhouse);
	console.log("ClickHouse market_data schema ensured");
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
			try {
				bodyText = await request.text();
			} catch {
				return Response.json({ error: "Failed to read request body" }, { status: 400 });
			}

			if (bodyText.length > MAX_ARCHIVE_BODY_BYTES) {
				return Response.json({ error: "Request body too large" }, { status: 413 });
			}

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
				return Response.json(
					{
						error: "Malformed archive rows in batch",
						rejected: parsed.rejectedRowCount,
						inputRows: parsed.inputRowCount,
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
