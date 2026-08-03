import { afterEach, describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { SUPPORTED_TABLES } from "../../services/archive-forwarder/types";
import {
	BASELINE_TABLES,
	assertBaselineTableRows,
	loadArchiveBaselineFixture,
} from "../../test/e2e/archive/support/archive-baseline";
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
				expect(response.status, `${table.table} HTTP status`).toBe(200);
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
});

describe("real four-feed archive lifecycle", () => {
	test("broker_write dual mode retains exact legacy rows and linked closed canonical output", async () => {
		const result = await runArchiveLifecycle({
			source: "broker_write",
			writeMode: "dual",
		});
		expect(result.collectorModule).toBe("services/ohlcv-collector/collector.ts");
		expect(result.feedsObserved).toEqual(PUBLIC_FEEDS);
		expect(result.legacyRowsMatchBaseline).toBe(true);
		expect(result.feedLinks.map(({ feed }) => feed)).toEqual(PUBLIC_FEEDS);
		expect(result.unexpectedDestinations).toEqual([]);
	});

	test("broker_read canonical mode verifies stored provenance, checksums, and views", async () => {
		const result = await runArchiveLifecycle({
			source: "broker_read",
			writeMode: "canonical",
		});
		expect(result.feedsObserved).toEqual(PUBLIC_FEEDS);
		expect(result.feedLinks.map(({ feed }) => feed)).toEqual(PUBLIC_FEEDS);
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
});
