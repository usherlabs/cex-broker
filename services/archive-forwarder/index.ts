import { createClient } from "@clickhouse/client";
import { loadForwarderConfig } from "./config";
import { createClickHouseInserter } from "./insert";
import { pingClickHouse } from "./health";
import { handleArchiveBatch, parseArchiveBatchRequest } from "./router";
import { ensureMarketDataSchema } from "./schema";

const config = loadForwarderConfig();
const clickhouse = createClient({
	host: `http://${config.clickhouse.host}:${config.clickhouse.port}`,
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
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}

			const batch = parseArchiveBatchRequest(body);
			if (!batch) {
				return Response.json(
					{ error: "Invalid archive batch payload" },
					{ status: 400 },
				);
			}

			try {
				const result = await handleArchiveBatch(inserter, batch);
				if (result.skipped > 0) {
					console.warn(
						`Skipped ${result.skipped} unsupported archive row(s) from ${batch.source}`,
					);
				}
				if (result.failed > 0) {
					console.warn(
						`Failed ${result.failed} archive row(s) from ${batch.source}: ${result.failedTables.join(", ")}`,
					);
				}
				if (result.inserted === 0 && result.failed > 0) {
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
