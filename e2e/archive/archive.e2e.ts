import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPPORTED_TABLES } from "../../services/archive-forwarder/types";
import { BrokerExecutionArchiver } from "../../src/helpers/broker-execution-archive";
import { startForwarderServer } from "../../test/archive-forwarder-server";
import {
	BASELINE_TABLES,
	assertBaselineTableRows,
	loadArchiveBaselineFixture,
} from "../../test/e2e/archive/support/archive-baseline";
import { auditArchiveConfigurationSurface } from "../../test/e2e/archive/support/archive-configuration-surface";
import { startArchiveForwarderEndpoint } from "../../test/e2e/archive/support/archive-forwarder-endpoint";
import {
	PUBLIC_FEEDS,
	type ArchiveForwarderEndpoint,
} from "../../test/e2e/archive/support/archive-e2e-contracts";
import {
	runArchiveLifecycle,
	runBlockedSinkLifecycle,
	runOrderBookConflictRegression,
	runRecoverableFailureLifecycle,
	runTerminalFailureLifecycle,
} from "../../test/e2e/archive/support/archive-lifecycle";
import { ClickHouseLocalHarness } from "../../test/e2e/archive/support/clickhouse-local-harness";

const harnesses: ClickHouseLocalHarness[] = [];
const endpoints: ArchiveForwarderEndpoint[] = [];

afterEach(async () => {
	await Promise.all(endpoints.splice(0).map(({ close }) => close()));
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

async function initializedHarness(): Promise<ClickHouseLocalHarness> {
	const harness = await ClickHouseLocalHarness.create();
	harnesses.push(harness);
	await harness.initialize();
	return harness;
}

function selectFixtureRows(table: {
	table: string;
	projection: string[];
	sortOrder: string[];
}): string {
	const projection = table.projection.map((column) => `\`${column}\``).join(", ");
	const order = table.sortOrder.map((column) => `\`${column}\``).join(", ");
	return `SELECT ${projection} FROM ${table.table} ORDER BY ${order}`;
}

describe("ClickHouse Local archive E2E runtime", () => {
	test("removed archive and credential configuration remains absent", async () => {
		expect(await auditArchiveConfigurationSurface()).toEqual([]);
	});

	test("executes production schema in unique persistent serialized paths and cleans up", async () => {
		const first = await initializedHarness();
		const second = await initializedHarness();
		expect(first.databasePath).not.toBe(second.databasePath);

		await Promise.all([
			first.execute("CREATE TABLE e2e_serial_a (value UInt8) ENGINE = MergeTree ORDER BY tuple()"),
			first.execute("CREATE TABLE e2e_serial_b (value UInt8) ENGINE = MergeTree ORDER BY tuple()"),
		]);
		expect(first.maxObservedConcurrentCommands).toBe(1);
		await first.execute("INSERT INTO e2e_serial_a VALUES (7)");
		expect(await first.query("SELECT value FROM e2e_serial_a")).toEqual([
			{ value: 7 },
		]);

		const root = second.rootDirectory;
		await second.cleanup();
		await second.cleanup();
		await expect(access(root)).rejects.toThrow();
	});

	test("archives and queries exact baseline projections for every pre-canonical table", async () => {
		const fixture = await loadArchiveBaselineFixture();
		const harness = await initializedHarness();
		const endpoint = await startArchiveForwarderEndpoint({
			inserter: harness.inserter,
		});
		endpoints.push(endpoint);

		for (const table of fixture.tables) {
			const rowsByEnvelope = Map.groupBy(table.expectedRows, (row) =>
				JSON.stringify([row.source, row.deployment_id]),
			);
			for (const rows of rowsByEnvelope.values()) {
				const response = await fetch(endpoint.url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						source: rows[0]?.source,
						deployment_id: rows[0]?.deployment_id,
						rows: rows.map((row) => ({ table: table.table, row })),
					}),
				});
				const isRuntimeStrategy = rows[0]?.source === "hb_runtime";
				expect(response.status, `${table.table} HTTP status`).toBe(
					isRuntimeStrategy ? 202 : 200,
				);
				if (isRuntimeStrategy) {
					await endpoint.waitForStrategyDrain();
					expect(endpoint.strategySpoolStats()).toMatchObject({
						queuedBatches: 0,
						queuedWork: 0,
					});
				}
			}

			const actual = await harness.query(
				selectFixtureRows(table),
				table.fieldTypes,
			);
			assertBaselineTableRows(table, actual);
		}
	});

	test("rejects source disagreement and unsupported baseline inventory before insertion", async () => {
		expect(BASELINE_TABLES.every((table) => SUPPORTED_TABLES.includes(table))).toBe(
			true,
		);
		const harness = await initializedHarness();
		const endpoint = await startArchiveForwarderEndpoint({
			inserter: harness.inserter,
		});
		endpoints.push(endpoint);
		const response = await fetch(endpoint.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source: "broker_read",
				deployment_id: "archive-e2e-rejected",
				rows: [
					{
						table: "market_data.candles",
						row: {
							source: "broker_write",
							deployment_id: "archive-e2e-rejected",
						},
					},
				],
			}),
		});
		expect(response.status).toBe(400);
		expect(
			await harness.query(
				"SELECT count() AS count FROM market_data.candles WHERE deployment_id = 'archive-e2e-rejected'",
			),
		).toEqual([{ count: 0 }]);
	});

	test("maker_replay inserts synchronously and leaves the runtime spool unchanged", async () => {
		const fixture = await loadArchiveBaselineFixture();
		const table = fixture.tables.find(
			(entry) => entry.table === "strategy_data.policy_evaluation_events",
		);
		if (!table) throw new Error("strategy replay fixture table is missing");
		const replayRow = {
			...table.expectedRows[0],
			source: "maker_replay",
			deployment_id: "archive-e2e-replay",
		};
		const harness = await initializedHarness();
		const endpoint = await startArchiveForwarderEndpoint({
			inserter: harness.inserter,
		});
		endpoints.push(endpoint);
		const before = endpoint.strategySpoolStats();
		const response = await fetch(endpoint.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source: "maker_replay",
				deployment_id: "archive-e2e-replay",
				rows: [{ table: table.table, row: replayRow }],
			}),
		});
		expect(response.status).toBe(200);
		expect(endpoint.strategySpoolStats()).toEqual(before);
		expect(
			await harness.query(
				"SELECT count() AS count FROM strategy_data.policy_evaluation_events WHERE source = 'maker_replay' AND deployment_id = 'archive-e2e-replay'",
			),
		).toEqual([{ count: 1 }]);

		const failing = await startArchiveForwarderEndpoint({
			inserter: async () => {
				throw new Error("scripted replay insertion failure");
			},
		});
		endpoints.push(failing);
		const failed = await fetch(failing.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source: "maker_replay",
				deployment_id: "archive-e2e-replay-failed",
				rows: [
					{
						table: table.table,
						row: {
							...replayRow,
							deployment_id: "archive-e2e-replay-failed",
						},
					},
				],
			}),
		});
		expect(failed.status).toBe(500);
		expect(failing.strategySpoolStats()).toMatchObject({
			queuedBatches: 0,
			queuedWork: 0,
			accountedBytes: 0,
		});
	});

	test("runtime spool survives restart and retries only the failed table", async () => {
		const fixture = await loadArchiveBaselineFixture();
		const strategyTables = fixture.tables.filter(({ table }) =>
			table.startsWith("strategy_data."),
		);
		const harness = await initializedHarness();
		const spoolPath = join(harness.rootDirectory, "strategy-restart.sqlite");
		const first = await startArchiveForwarderEndpoint({
			inserter: harness.inserter,
			spoolPath,
		});
		const firstTable = strategyTables[0];
		if (!firstTable) throw new Error("strategy restart fixture is missing");
		const admitted = await fetch(first.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source: "hb_runtime",
				deployment_id: firstTable.expectedRows[0]?.deployment_id,
				rows: firstTable.expectedRows.map((row) => ({
					table: firstTable.table,
					row,
				})),
			}),
		});
		expect(admitted.status).toBe(202);
		expect(first.strategySpoolStats().queuedWork).toBe(1);
		await first.close();

		const restarted = await startArchiveForwarderEndpoint({
			inserter: harness.inserter,
			spoolPath,
		});
		endpoints.push(restarted);
		expect(restarted.strategySpoolStats().queuedWork).toBe(1);
		await restarted.waitForStrategyDrain();
		expect(restarted.strategySpoolStats().queuedWork).toBe(0);

		const attempts = new Map<string, number>();
		const retryEndpoint = await startArchiveForwarderEndpoint({
			inserter: async (table, rows, options) => {
				const count = (attempts.get(table) ?? 0) + 1;
				attempts.set(table, count);
				if (table === strategyTables[1]?.table && count === 1) {
					throw new Error("connection reset by peer");
				}
				await harness.inserter(table, rows, options);
			},
		});
		endpoints.push(retryEndpoint);
		const retryTables = strategyTables.slice(1, 3);
		const retryRows = retryTables.flatMap((table) =>
			table.expectedRows.map((row) => ({ table: table.table, row })),
		);
		const retryResponse = await fetch(retryEndpoint.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source: "hb_runtime",
				deployment_id: retryRows[0]?.row.deployment_id,
				rows: retryRows,
			}),
		});
		expect(retryResponse.status).toBe(202);
		await retryEndpoint.waitForStrategyDrain();
		expect(attempts.get(retryTables[0]?.table ?? "")).toBe(2);
		expect(attempts.get(retryTables[1]?.table ?? "")).toBe(1);
	});
});

describe("real four-feed archive lifecycle", () => {
	test("broker_read canonical-only writer verifies provenance, checksums, and views", async () => {
		const result = await runArchiveLifecycle();
		expect(result.collectorModule).toBe("services/ohlcv-collector/collector.ts");
		expect(result.feedsObserved).toEqual(PUBLIC_FEEDS);
		expect(result.feedLinks.map(({ feed }) => feed)).toEqual(PUBLIC_FEEDS);
		expect(result.unexpectedDestinations).toEqual([]);
		expect(result.checksumsVerified).toBe(true);
		expect(result.conflictViewsEmpty).toBe(true);
		expect(result.legacyOrderBookRows).toBe(0);
		expect(result.legacyCandleRows).toBe(0);
	});

	test("order-book duplicate and conflict behavior remains physically auditable", async () => {
		const result = await runOrderBookConflictRegression();
		expect(result.identicalPhysicalRows).toBe(2);
		expect(result.identicalCanonicalRows).toBe(1);
		expect(result.sameRequestStatus).toBe(400);
		expect(result.sameRequestStoredRows).toBe(0);
		expect(result.crossBatchPhysicalRows).toBe(2);
		expect(result.crossBatchConflictRows).toBe(1);
		expect(result.crossBatchCanonicalRows).toBe(0);
	});
});

describe("archive failure isolation and accounting", () => {
	test("a blocked sink does not block later collector frames or close streams", async () => {
		const result = await runBlockedSinkLifecycle();
		expect(result.laterFramesObservedBeforeRelease).toEqual(PUBLIC_FEEDS);
		expect(result.streamsActiveBeforeAbort).toEqual(PUBLIC_FEEDS);
	});

	test("a recoverable forwarder failure retries and stores every emitted row", async () => {
		const result = await runRecoverableFailureLifecycle();
		expect(result.retryAttempts).toBeGreaterThanOrEqual(2);
		expect(result.storedRows).toBe(result.emittedRows);
		expect(result.journalRows).toBe(0);
		expect(result.unaccountedRows).toBe(0);
	});

	test("persistent failure journals each undelivered row exactly once", async () => {
		const result = await runTerminalFailureLifecycle();
		expect(result.storedRows).toBe(0);
		expect(result.journalRows).toBe(result.emittedRows);
		expect(new Set(result.journalReasons)).toEqual(
			new Set(["shutdown_forwarder_failure"]),
		);
		expect(result.unaccountedRows).toBe(0);
	});

	test("queue shedding records the exact oldest payload with the closed loss shape", async () => {
		const directory = await mkdtemp(join(tmpdir(), "archive-e2e-shed-"));
		const journalPath = join(directory, "loss.jsonl");
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			source: "broker_read",
			deploymentId: "archive-e2e-shed",
			// Queue-shed durability is synchronous. Use a known-live local sink so
			// cleanup verifies the retained row without depending on how CI handles
			// connections to an otherwise unused loopback port.
			forwarderUrl: forwarder.url,
			deadLetterPath: journalPath,
			maxQueueSize: 1,
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		try {
			const oldest = {
				table: "market_data.cex_trades",
				row: { source: "broker_write", deployment_id: "archive-e2e-shed", trade_id: "oldest" },
			};
			archiver.enqueue(oldest);
			archiver.enqueue({
				table: "market_data.cex_trades",
				row: { deployment_id: "archive-e2e-shed", trade_id: "newest" },
			});
			const records = (await readFile(journalPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(records).toHaveLength(1);
			expect(Object.keys(records[0] ?? {}).sort()).toEqual([
				"deployment_id",
				"payload",
				"reason",
				"source",
				"timestamp",
			]);
			expect(records[0]).toMatchObject({
				source: "broker_read",
				deployment_id: "archive-e2e-shed",
				reason: "queue_shed",
				payload: {
					table: oldest.table,
					row: { ...oldest.row, source: "broker_read" },
				},
			});
		} finally {
			await archiver.close().catch(() => {});
			await forwarder.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
