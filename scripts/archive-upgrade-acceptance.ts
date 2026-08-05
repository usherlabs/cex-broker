#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { createClickHouseInserter } from "../services/archive-forwarder/insert";
import {
	ensureArchiveSchema,
	splitSqlStatements,
} from "../services/archive-forwarder/schema";
import {
	type ArchiveBaselineTable,
	assertBaselineTableRows,
} from "../test/e2e/archive/support/archive-baseline";
import { runProductionServerArchiveCapture } from "../test/e2e/archive/support/archive-lifecycle";
import {
	loadUpgradeBaseline,
	UPGRADE_BASELINE_ROOT,
	type UpgradeBaselineFixture,
	validateUpgradeBaseline,
} from "./archive-upgrade-baseline";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:24.8";
const CLICKHOUSE_USER = "default";
const CLICKHOUSE_PASSWORD = "archive-upgrade-local-only";
const DEFAULT_EVIDENCE_PATH = join(
	REPOSITORY_ROOT,
	"openspec/changes/archive-upgrade-ab-maker-sidecar-e2e/evidence/archive-upgrade-ab-acceptance.json",
);

export type MigrationSummary = {
	window: { start_time_ms: number; end_time_ms: number };
	legacy_order_books: number;
	legacy_candles: number;
	canonical_rows: number;
	mode: string;
};

type MigrationExpectations = {
	window: { startTimeMs: number; endTimeMs: number };
	legacyOrderBooks: number;
	legacyCandles: number;
	canonicalRows: number;
};

type ServerInstance = {
	name: string;
	containerId: string;
	url: string;
	client: ClickHouseClient;
	version: string;
};

function stable(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
		.join(",")}}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function command(
	program: string,
	args: string[],
	options: {
		env?: Record<string, string | undefined>;
		allowFailure?: boolean;
	} = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = Bun.spawn([program, ...args], {
		cwd: REPOSITORY_ROOT,
		env: options.env ?? process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0 && !options.allowFailure) {
		throw new Error(
			`${program} ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`,
		);
	}
	return { stdout, stderr, exitCode };
}

export function parseMigrationSummary(output: string): MigrationSummary {
	for (const line of output.trim().split("\n").reverse()) {
		try {
			const parsed = JSON.parse(line) as Partial<MigrationSummary>;
			if (parsed.window && typeof parsed.mode === "string") {
				return parsed as MigrationSummary;
			}
		} catch {
			// Diagnostic output may precede the one machine-readable summary.
		}
	}
	throw new Error("migration command did not emit a JSON summary");
}

export function validateMigrationSummary(
	summary: MigrationSummary,
	expected: MigrationExpectations,
): void {
	if (
		summary.mode !== "write" ||
		summary.window?.start_time_ms !== expected.window.startTimeMs ||
		summary.window?.end_time_ms !== expected.window.endTimeMs ||
		summary.legacy_order_books !== expected.legacyOrderBooks ||
		summary.legacy_candles !== expected.legacyCandles ||
		summary.canonical_rows !== expected.canonicalRows ||
		summary.legacy_order_books <= 0 ||
		summary.legacy_candles <= 0 ||
		summary.canonical_rows <= 0
	) {
		throw new Error(
			`migration summary does not match confirmed fixture expectations: ${JSON.stringify(summary)}`,
		);
	}
}

async function docker(args: string[], allowFailure = false) {
	return command("docker", args, { allowFailure });
}

async function startServer(name: string): Promise<ServerInstance> {
	const started = await docker([
		"run",
		"-d",
		"--name",
		name,
		"-e",
		`CLICKHOUSE_USER=${CLICKHOUSE_USER}`,
		"-e",
		`CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}`,
		"-p",
		"127.0.0.1::8123",
		CLICKHOUSE_IMAGE,
	]);
	const containerId = started.stdout.trim();
	const portOutput = await docker(["port", name, "8123/tcp"]);
	const match = portOutput.stdout.match(/:(\d+)\s*$/m);
	if (!match) throw new Error(`unable to resolve ClickHouse port for ${name}`);
	const url = `http://127.0.0.1:${match[1]}`;
	const client = createClient({
		url,
		username: CLICKHOUSE_USER,
		password: CLICKHOUSE_PASSWORD,
	});
	const deadline = Date.now() + 60_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const result = await client.query({
				query: "SELECT version() AS version",
				format: "JSONEachRow",
			});
			const rows = (await result.json()) as Array<{ version: string }>;
			const version = rows[0]?.version;
			if (version) return { name, containerId, url, client, version };
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(250);
	}
	await client.close();
	throw new Error(
		`ClickHouse ${name} did not become ready: ${String(lastError)}`,
	);
}

async function stopServer(
	instance: ServerInstance,
	remove: boolean,
): Promise<void> {
	await instance.client.close().catch(() => {});
	if (remove) await docker(["rm", "-f", instance.name], true);
	else await docker(["stop", "--time", "10", instance.name], true);
}

async function applySqlFile(
	client: ClickHouseClient,
	path: string,
): Promise<void> {
	const sql = await Bun.file(path).text();
	for (const statement of splitSqlStatements(sql)) {
		await client.command({ query: statement });
	}
}

async function initializeBaseline(
	instance: ServerInstance,
	fixture: UpgradeBaselineFixture,
): Promise<void> {
	for (const schema of fixture.schemaFiles) {
		await applySqlFile(
			instance.client,
			join(UPGRADE_BASELINE_ROOT, schema.path),
		);
	}
	const inserter = createClickHouseInserter(instance.client);
	for (const table of fixture.tables) {
		const rows = table.expectedRows.map((row) =>
			Object.fromEntries(
				Object.entries(row).map(([field, value]) => {
					const type = table.fieldTypes[field];
					if (
						value !== null &&
						(type === "datetime" || type === "nullable-datetime")
					) {
						return [
							field,
							new Date(String(value))
								.toISOString()
								.replace("T", " ")
								.replace("Z", ""),
						];
					}
					return [field, value];
				}),
			),
		);
		await inserter(table.table as Parameters<typeof inserter>[0], rows);
	}
}

function selectProjection(
	table: UpgradeBaselineFixture["tables"][number],
): string {
	const projection = table.projection.map((field) => `\`${field}\``).join(", ");
	const order = table.sortOrder.map((field) => `\`${field}\``).join(", ");
	return `SELECT ${projection} FROM ${table.table} WHERE deployment_id = {deployment_id:String} ORDER BY ${order}`;
}

async function queryRows(
	client: ClickHouseClient,
	query: string,
	queryParams?: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
	const result = await client.query({
		query,
		query_params: queryParams,
		format: "JSONEachRow",
	});
	return (await result.json()) as Array<Record<string, unknown>>;
}

async function snapshotLegacy(
	instance: ServerInstance,
	fixture: UpgradeBaselineFixture,
): Promise<{ tableHashes: Record<string, string>; combinedHash: string }> {
	const tableHashes: Record<string, string> = {};
	for (const table of fixture.tables) {
		const deploymentId = String(table.expectedRows[0]?.deployment_id ?? "");
		if (!deploymentId) {
			throw new Error(`${table.table} fixture deployment identity is missing`);
		}
		const rows = await queryRows(instance.client, selectProjection(table), {
			deployment_id: deploymentId,
		});
		assertBaselineTableRows(table as ArchiveBaselineTable, rows);
		tableHashes[table.table] = sha256(stable(rows));
	}
	return {
		tableHashes,
		combinedHash: sha256(stable(tableHashes)),
	};
}

async function schemaDigest(
	instance: ServerInstance,
	fixture: UpgradeBaselineFixture,
): Promise<string> {
	const definitions: Record<string, string> = {};
	for (const table of fixture.tables) {
		const rows = await queryRows(
			instance.client,
			`SHOW CREATE TABLE ${table.table}`,
		);
		definitions[table.table] = stable(rows);
	}
	return sha256(stable(definitions));
}

async function runMigration(
	instance: ServerInstance,
	fixture: UpgradeBaselineFixture,
): Promise<MigrationSummary> {
	const embeddedUrl = instance.url.replace(
		"http://",
		`http://${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}@`,
	);
	const result = await command(
		"bun",
		["scripts/migrate-legacy-market-data-to-canonical.ts"],
		{
			env: {
				...process.env,
				CLICKHOUSE_URL: embeddedUrl,
				CEX_BROKER_CANONICAL_MIGRATION_CONFIRM: "true",
				CEX_BROKER_MIGRATION_START_TIME_MS: String(
					fixture.migrationWindow.startTimeMs,
				),
				CEX_BROKER_MIGRATION_END_TIME_MS: String(
					fixture.migrationWindow.endTimeMs,
				),
			},
		},
	);
	const summary = parseMigrationSummary(result.stdout);
	validateMigrationSummary(summary, {
		window: fixture.migrationWindow,
		...fixture.expected,
	});
	return summary;
}

async function runCutoverParity(
	client: ClickHouseClient,
	fixture: UpgradeBaselineFixture,
): Promise<{ queryHashes: string[]; resultHashes: string[] }> {
	const path = join(
		REPOSITORY_ROOT,
		"schema/clickhouse/migrations/canonical_market_data_replay_cutover.sql",
	);
	const statements = splitSqlStatements(await Bun.file(path).text()).filter(
		(statement) => /^SELECT\b/i.test(statement.trim()),
	);
	if (statements.length !== 2) {
		throw new Error(
			`expected two executable cutover parity queries, got ${statements.length}`,
		);
	}
	const queryParams = {
		start_time_ms: fixture.migrationWindow.startTimeMs,
		end_time_ms: fixture.migrationWindow.endTimeMs,
	};
	const resultHashes: string[] = [];
	for (const statement of statements) {
		const rows = await queryRows(client, statement, queryParams);
		if (rows.length !== 0) {
			throw new Error(`cutover parity mismatch: ${JSON.stringify(rows[0])}`);
		}
		resultHashes.push(sha256(stable(rows)));
	}
	return {
		queryHashes: statements.map(sha256),
		resultHashes,
	};
}

async function canonicalSnapshot(client: ClickHouseClient): Promise<{
	counts: Record<string, number>;
	hash: string;
	conflicts: number;
	provenanceRows: number;
}> {
	const queries: Record<string, string> = {
		levels:
			"SELECT * FROM market_data.cex_order_book_levels_canonical WHERE source_mode = 'legacy_migration_v1' ORDER BY snapshot_id, side, level_index",
		summaries:
			"SELECT * FROM market_data.cex_order_book_depth_summary_canonical WHERE source_mode = 'legacy_migration_v1' ORDER BY snapshot_id",
		ohlcv:
			"SELECT * FROM market_data.cex_ohlcv FINAL WHERE source_mode = 'legacy_migration_v1' ORDER BY exchange, trading_pair, timeframe, open_time_ms",
	};
	const rowsByKind: Record<string, Array<Record<string, unknown>>> = {};
	const counts: Record<string, number> = {};
	for (const [kind, query] of Object.entries(queries)) {
		const rows = await queryRows(client, query);
		rowsByKind[kind] = rows;
		counts[kind] = rows.length;
		for (const row of rows) {
			if (
				row.source_mode !== "legacy_migration_v1" ||
				Number(row.provenance_complete) !== 0 ||
				row.capture_bundle_id !== null ||
				row.raw_capture_id !== null ||
				row.raw_checksum !== null
			) {
				throw new Error(
					"migrated canonical row invents complete capture provenance",
				);
			}
		}
	}
	const conflictRows = await queryRows(
		client,
		`SELECT
			(SELECT count() FROM market_data.cex_order_book_levels_conflicts) +
			(SELECT count() FROM market_data.cex_order_book_depth_summary_conflicts) AS count`,
	);
	const conflicts = Number(conflictRows[0]?.count ?? -1);
	if (conflicts !== 0)
		throw new Error("deterministic migration produced conflicts");
	return {
		counts,
		hash: sha256(stable(rowsByKind)),
		conflicts,
		provenanceRows: Object.values(rowsByKind).reduce(
			(total, rows) => total + rows.length,
			0,
		),
	};
}

async function gitState(): Promise<{
	commit: string;
	dirty: boolean;
	diffHash: string;
}> {
	const [commit, status, diff] = await Promise.all([
		command("git", ["rev-parse", "HEAD"]),
		command("git", ["status", "--porcelain"]),
		command("git", ["diff", "--binary", "HEAD"]),
	]);
	return {
		commit: commit.stdout.trim(),
		dirty: status.stdout.trim().length > 0,
		diffHash: sha256(diff.stdout),
	};
}

async function collectDiagnostics(instances: ServerInstance[]) {
	const diagnostics: Record<string, string> = {};
	for (const instance of instances) {
		const logs = await docker(["logs", "--tail", "200", instance.name], true);
		diagnostics[instance.name] =
			logs.stdout.slice(-20_000) + logs.stderr.slice(-20_000);
	}
	return diagnostics;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}

export async function runArchiveUpgradeAcceptance(
	options: { evidencePath?: string; allowDirty?: boolean } = {},
): Promise<Record<string, unknown>> {
	const startedAt = new Date().toISOString();
	const fixture = await loadUpgradeBaseline();
	await validateUpgradeBaseline(fixture);
	const candidate = await gitState();
	if (candidate.dirty && !options.allowDirty) {
		throw new Error(
			"archive upgrade acceptance requires a clean final candidate; use --allow-dirty only for diagnostic runs",
		);
	}
	const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
	const instances: ServerInstance[] = [];
	let accepted = false;
	let evidence: Record<string, unknown> = {};
	try {
		const [a, b] = await Promise.all([
			startServer(`cex-archive-ab-a-${suffix}`),
			startServer(`cex-archive-ab-b-${suffix}`),
		]);
		instances.push(a, b);
		await Promise.all([
			initializeBaseline(a, fixture),
			initializeBaseline(b, fixture),
		]);
		const [aBefore, bBefore, aSchema, bSchema] = await Promise.all([
			snapshotLegacy(a, fixture),
			snapshotLegacy(b, fixture),
			schemaDigest(a, fixture),
			schemaDigest(b, fixture),
		]);
		if (aBefore.combinedHash !== bBefore.combinedHash || aSchema !== bSchema) {
			throw new Error("A and B pre-upgrade snapshots are not identical");
		}

		await ensureArchiveSchema(b.client);
		const firstMigration = await runMigration(b, fixture);
		const firstParity = await runCutoverParity(b.client, fixture);
		const firstCanonical = await canonicalSnapshot(b.client);
		await ensureArchiveSchema(b.client);
		const secondMigration = await runMigration(b, fixture);
		const secondParity = await runCutoverParity(b.client, fixture);
		const secondCanonical = await canonicalSnapshot(b.client);
		if (
			firstCanonical.hash !== secondCanonical.hash ||
			stable(firstCanonical.counts) !== stable(secondCanonical.counts) ||
			firstCanonical.provenanceRows !== fixture.expected.canonicalRows
		) {
			throw new Error("confirmed migration is not logically idempotent");
		}

		const bAfterMigration = await snapshotLegacy(b, fixture);
		if (bAfterMigration.combinedHash !== aBefore.combinedHash) {
			throw new Error("B legacy projection changed during migration");
		}
		const productionDeployment = `archive-ab-upgraded-${suffix}`;
		const productionBundle = `archive-ab-bundle-${suffix}`;
		const capture = await runProductionServerArchiveCapture({
			inserter: createClickHouseInserter(b.client),
			deploymentId: productionDeployment,
			captureBundleId: productionBundle,
			timeOffsetMs: 400_000_000_000,
		});
		const newCounts = await queryRows(
			b.client,
			`SELECT
				(SELECT count() FROM market_data.cex_stream_events WHERE deployment_id = {deployment:String}) AS raw,
				(SELECT count() FROM market_data.cex_order_book_levels WHERE deployment_id = {deployment:String}) AS levels,
				(SELECT count() FROM market_data.cex_order_book_depth_summary WHERE deployment_id = {deployment:String}) AS summaries,
				(SELECT count() FROM market_data.cex_ticker_events WHERE deployment_id = {deployment:String}) AS tickers,
				(SELECT count() FROM market_data.cex_trades WHERE deployment_id = {deployment:String}) AS trades,
				(SELECT count() FROM market_data.cex_ohlcv FINAL WHERE deployment_id = {deployment:String}) AS ohlcv,
				(SELECT count() FROM market_data.orderbook_snapshots WHERE deployment_id = {deployment:String}) AS legacy_books,
				(SELECT count() FROM market_data.candles FINAL WHERE deployment_id = {deployment:String}) AS legacy_candles`,
			{ deployment: productionDeployment },
		);
		const newRowCounts = newCounts[0] ?? {};
		for (const field of [
			"raw",
			"levels",
			"summaries",
			"tickers",
			"trades",
			"ohlcv",
		]) {
			if (Number(newRowCounts[field]) <= 0) {
				throw new Error(`upgraded production capture is missing ${field}`);
			}
		}
		if (
			Number(newRowCounts.legacy_books) !== 0 ||
			Number(newRowCounts.legacy_candles) !== 0
		) {
			throw new Error("upgraded producer wrote a legacy market-data table");
		}
		const [aAfter, bAfterProduction] = await Promise.all([
			snapshotLegacy(a, fixture),
			snapshotLegacy(b, fixture),
		]);
		if (
			aAfter.combinedHash !== aBefore.combinedHash ||
			bAfterProduction.combinedHash !== aBefore.combinedHash
		) {
			throw new Error(
				"A immutability or B historical compatibility failed after production capture",
			);
		}
		evidence = {
			status: "accepted",
			startedAt,
			completedAt: new Date().toISOString(),
			invocation: "bun run test:acceptance:archive-upgrade",
			baseline: {
				...fixture.baseline,
				fixtureContentHash: fixture.contentHash,
			},
			candidate,
			clickhouse: {
				image: CLICKHOUSE_IMAGE,
				version: a.version,
				endpoints: { a: a.url, b: b.url },
			},
			initial: {
				legacyHash: aBefore.combinedHash,
				schemaHash: aSchema,
				tableHashes: aBefore.tableHashes,
			},
			migration: {
				window: fixture.migrationWindow,
				first: firstMigration,
				second: secondMigration,
				firstCanonical,
				secondCanonical,
			},
			parity: { first: firstParity, second: secondParity },
			productionCapture: {
				deploymentId: productionDeployment,
				captureBundleId: productionBundle,
				feedsObserved: capture.feedsObserved,
				emittedRows: capture.emittedRows.length,
				requestCount: capture.requestCount,
				storedCounts: newRowCounts,
			},
			assertions: {
				initiallyIdentical: true,
				migrationConfirmedTwice: true,
				migrationLogicallyIdempotent: true,
				parameterBoundParityClean: true,
				conflictsEmpty: true,
				incompleteProvenanceHonest: true,
				legacyParityPreserved: true,
				controlImmutable: true,
				upgradedProducerCanonicalOnly: true,
			},
		};
		const evidencePath = options.evidencePath ?? DEFAULT_EVIDENCE_PATH;
		await mkdir(dirname(evidencePath), { recursive: true });
		await Bun.write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
		accepted = true;
		return evidence;
	} catch (error) {
		const failurePath = (options.evidencePath ?? DEFAULT_EVIDENCE_PATH).replace(
			/\.json$/,
			".failure.json",
		);
		await mkdir(dirname(failurePath), { recursive: true });
		await Bun.write(
			failurePath,
			`${JSON.stringify(
				{
					status: "failed",
					startedAt,
					failedAt: new Date().toISOString(),
					baseline: fixture.baseline,
					candidate,
					error: error instanceof Error ? error.message : String(error),
					preservedContainers: instances.map(({ name }) => name),
					diagnostics: await collectDiagnostics(instances),
				},
				null,
				2,
			)}\n`,
		);
		throw error;
	} finally {
		await Promise.all(
			instances.map((instance) => stopServer(instance, accepted)),
		);
	}
}

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	const evidencePath = option(args, "--evidence");
	const result = await runArchiveUpgradeAcceptance({
		evidencePath: evidencePath ? resolve(evidencePath) : undefined,
		allowDirty: args.includes("--allow-dirty"),
	});
	console.info(
		JSON.stringify({
			status: result.status,
			evidencePath: evidencePath ?? DEFAULT_EVIDENCE_PATH,
		}),
	);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
