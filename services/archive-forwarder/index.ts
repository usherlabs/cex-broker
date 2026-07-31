import { createClient } from "@clickhouse/client";
import { loadForwarderConfig } from "./config";
import { createClickHouseInserter } from "./insert";
import { pingClickHouse } from "./health";
import { handleArchiveRequest } from "./request";
import { ensureArchiveSchema } from "./schema";
import { createArchiveForwarderTelemetry } from "./telemetry";

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
const telemetry = createArchiveForwarderTelemetry();

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
			return handleArchiveRequest(request, {
				authToken: config.authToken,
				inserter,
				telemetry,
			});
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
