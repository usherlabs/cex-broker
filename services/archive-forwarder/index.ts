import { createClient } from "@clickhouse/client";
import { loadForwarderConfig } from "./config";
import { createClickHouseInserter } from "./insert";
import { evaluateForwarderHealth, pingClickHouse } from "./health";
import { handleArchiveRequest } from "./request";
import { ensureArchiveSchema } from "./schema";
import { createClickHouseStreamHealthReplayStore } from "./stream-health-contract";
import { createArchiveForwarderTelemetry } from "./telemetry";
import {
	StrategyArchiveSpool,
	StrategySpoolUnavailableError,
} from "./strategy-spool";
import { StrategySpoolWorker } from "./strategy-worker";

const config = loadForwarderConfig();
const clickhouse = createClient({
	url: `http://${config.clickhouse.host}:${config.clickhouse.port}`,
	username: config.clickhouse.username,
	password: config.clickhouse.password,
	database: config.clickhouse.database,
	// Broker execution and account snapshot tables use DateTime64 columns; producers
	// emit broker_observed_timestamp/exchange_timestamp as ISO-8601 UTC strings, so
	// the inserter must best-effort-parse them (basic mode rejects the 'T'/'Z' form).
	// Strictly more lenient than basic, so it never breaks the existing String/Int64
	// timestamp columns on the other archive tables.
	clickhouse_settings: { date_time_input_format: "best_effort" },
});
const inserter = createClickHouseInserter(clickhouse);
const streamHealthStore = createClickHouseStreamHealthReplayStore(clickhouse);
const telemetry = createArchiveForwarderTelemetry();
let spool: StrategyArchiveSpool | undefined;
let worker: StrategySpoolWorker | undefined;

try {
	spool = new StrategyArchiveSpool({ path: config.spoolPath });
	worker = new StrategySpoolWorker({ spool, inserter, telemetry });
} catch (error) {
	console.error("Failed to initialize durable strategy archive spool:", error);
	telemetry.recordStrategyAdmissionRejected("spool_unavailable");
}

let schemaReady = false;
let schemaRetryTimer: ReturnType<typeof setTimeout> | undefined;

async function ensureSchemaAndStartDrainage(): Promise<void> {
	try {
		await ensureArchiveSchema(clickhouse);
		schemaReady = true;
		worker?.start();
		console.log(
			"ClickHouse archive schema ensured (market_data, broker_execution, broker_account, broker_stream_health, strategy_data)",
		);
	} catch (error) {
		schemaReady = false;
		console.error("Failed to ensure ClickHouse schema; durable admission remains available:", error);
		schemaRetryTimer = setTimeout(() => {
			void ensureSchemaAndStartDrainage();
		}, 5_000);
		schemaRetryTimer.unref?.();
	}
}

void ensureSchemaAndStartDrainage();

const server = Bun.serve({
	port: config.port,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			const clickhouseOk = schemaReady && (await pingClickHouse(clickhouse));
			if (!spool) {
				const health = evaluateForwarderHealth({
					clickhouseOk,
					spoolOk: false,
					spool: null,
				});
				return Response.json(health.body, { status: health.statusCode });
			}
			try {
				const spoolStats = spool.assertWritable();
				telemetry.recordStrategySpoolStats(spoolStats);
				const health = evaluateForwarderHealth({
					clickhouseOk,
					spoolOk: true,
					spool: spoolStats,
				});
				return Response.json(health.body, { status: health.statusCode });
			} catch (error) {
				telemetry.recordStrategyAdmissionRejected("spool_unavailable");
				const health = evaluateForwarderHealth({
					clickhouseOk,
					spoolOk: false,
					spool: null,
				});
				if (!(error instanceof StrategySpoolUnavailableError)) {
					console.error("Strategy spool health check failed:", error);
				}
				return Response.json(health.body, { status: health.statusCode });
			}
		}

		if (request.method === "POST" && url.pathname === "/archive") {
			return handleArchiveRequest(request, {
				authToken: config.authToken,
				inserter,
				spool,
				streamHealthStore,
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
console.log(`Strategy archive spool: ${config.spoolPath}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	if (schemaRetryTimer) clearTimeout(schemaRetryTimer);
	worker?.stop();
	server.stop(true);
	await clickhouse.close();
	spool?.close();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
