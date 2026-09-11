import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import {
	ensureArchiveSchema,
	splitSqlStatements,
} from "../services/archive-forwarder/schema";

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

// This suite owns entire source databases. The integrator must give it a fresh,
// exclusive ClickHouse instance, not the shared archive integration endpoint.
describe.skipIf(!url)(
	"source applier on an isolated ClickHouse instance",
	() => {
		beforeAll(async () => {
			if (!url)
				throw new Error("An exclusive source-schema fixture URL is required");
			client = createClient({
				url,
				username: process.env.CLICKHOUSE_USER ?? "default",
				password: process.env.CLICKHOUSE_PASSWORD ?? "",
			});
			const existing = await client.query({
				query:
					"SELECT name FROM system.databases WHERE name IN {names:Array(String)}",
				query_params: { names: databases },
				format: "JSONEachRow",
			});
			if ((await existing.json()).length !== 0)
				throw new Error(
					"Source-schema proof requires empty owned namespaces on an exclusive fixture",
				);
			ownsFixture = true;
		});

		afterAll(async () => {
			try {
				if (ownsFixture) {
					for (const database of databases)
						await client.command({
							query: `DROP DATABASE IF EXISTS ${database} SYNC`,
						});
				}
			} finally {
				await client?.close();
			}
		});

		test("fresh apply, retained-row reapply and refusal before any missing-object creation", async () => {
			await ensureArchiveSchema(client);
			await client.command({
				query:
					"INSERT INTO fiet_metrics.fiet_metrics VALUES (now64(9), 'owner_probe', 'gauge', 17.25, '[]', 'source-schema-proof')",
			});
			await ensureArchiveSchema(client);
			let rows = await client.query({
				query:
					"SELECT value FROM fiet_metrics.fiet_metrics WHERE metric_name = 'owner_probe'",
				format: "JSONEachRow",
			});
			expect(await rows.json()).toEqual([{ value: 17.25 }]);

			// A late family mismatch must refuse BEFORE an earlier missing object is
			// created. The applier must not alter the mismatched table or its row.
			await client.command({
				query: "DROP TABLE broker_stream_health.replay_conflicts SYNC",
			});
			await client.command({
				query:
					"ALTER TABLE fiet_metrics.fiet_metrics MODIFY COLUMN value Float32 CODEC(ZSTD(1))",
			});
			await expect(ensureArchiveSchema(client)).rejects.toThrow(
				"Incompatible existing source definition",
			);
			const missing = await client.query({
				query:
					"SELECT toUInt32(count()) AS n FROM system.tables WHERE database = 'broker_stream_health' AND name = 'replay_conflicts'",
				format: "JSONEachRow",
			});
			expect(await missing.json()).toEqual([{ n: 0 }]);
			const type = await client.query({
				query:
					"SELECT type FROM system.columns WHERE database = 'fiet_metrics' AND table = 'fiet_metrics' AND name = 'value'",
				format: "JSONEachRow",
			});
			expect(await type.json()).toEqual([{ type: "Float32" }]);
			rows = await client.query({
				query:
					"SELECT value FROM fiet_metrics.fiet_metrics WHERE metric_name = 'owner_probe'",
				format: "JSONEachRow",
			});
			expect(await rows.json()).toEqual([{ value: 17.25 }]);

			await client.command({
				query:
					"ALTER TABLE fiet_metrics.fiet_metrics MODIFY COLUMN value Float64 CODEC(ZSTD(1))",
			});
			await client.command({
				query:
					"CREATE TABLE fiet_telemetry.unknown_source (value UInt8) ENGINE = MergeTree ORDER BY value",
			});
			await client.command({
				query: "INSERT INTO fiet_telemetry.unknown_source VALUES (9)",
			});
			await expect(ensureArchiveSchema(client)).rejects.toThrow(
				"Unknown source objects",
			);
			const retained = await client.query({
				query: "SELECT value FROM fiet_telemetry.unknown_source",
				format: "JSONEachRow",
			});
			expect(await retained.json()).toEqual([{ value: 9 }]);
			const stillMissing = await client.query({
				query:
					"SELECT toUInt32(count()) AS n FROM system.tables WHERE database = 'broker_stream_health' AND name = 'replay_conflicts'",
				format: "JSONEachRow",
			});
			expect(await stillMissing.json()).toEqual([{ n: 0 }]);
		}, 180_000);
	},
);

test("schema scanner preserves quoted delimiters and rejects incomplete input", () => {
	expect(
		splitSqlStatements("-- comment\nSELECT 'a;--b', '(x)'; SELECT 'it\\'s';"),
	).toEqual(["SELECT 'a;--b', '(x)'", "SELECT 'it\\'s'"]);
	expect(() => splitSqlStatements("SELECT 'unfinished")).toThrow(
		"Unterminated",
	);
});
