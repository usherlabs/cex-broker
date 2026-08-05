#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const DEVELOP_BASELINE_COMMIT =
	"7a83de5f29a08f42d81f64a75a83bc9318dce94a" as const;
export const DEVELOP_BASELINE_VERSION = "0.2.38" as const;
export const UPGRADE_BASELINE_SCHEMA_VERSION =
	"archive-upgrade-develop/v1" as const;

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
export const UPGRADE_BASELINE_ROOT = join(
	REPOSITORY_ROOT,
	"test/e2e/archive/fixtures/archive-upgrade-develop-v1",
);
const HISTORICAL_FIXTURE_PATH = join(
	REPOSITORY_ROOT,
	"test/e2e/archive/fixtures/archive-baseline-v1.json",
);
const MANIFEST_PATH = join(UPGRADE_BASELINE_ROOT, "manifest.json");
const SOURCE_SCHEMA_FILES = [
	"schema/clickhouse/market_data.sql",
	"schema/clickhouse/broker_execution.sql",
	"schema/clickhouse/broker_account.sql",
	"schema/clickhouse/strategy_data.sql",
] as const;

type BaselineTable = {
	table: string;
	projection: string[];
	fieldTypes: Record<string, string>;
	comparisonKey: string[];
	sortOrder: string[];
	expectedRows: Array<Record<string, unknown>>;
};

export type UpgradeBaselineFixture = {
	fixtureSchemaVersion: typeof UPGRADE_BASELINE_SCHEMA_VERSION;
	baseline: {
		branch: "develop";
		commit: typeof DEVELOP_BASELINE_COMMIT;
		packageVersion: typeof DEVELOP_BASELINE_VERSION;
		commitTimestamp: string;
	};
	generationCommand: string;
	tools: { bun: string; node: string };
	sourceHashes: Record<string, string>;
	schemaFiles: Array<{ path: string; sha256: string }>;
	tables: BaselineTable[];
	migrationWindow: { startTimeMs: number; endTimeMs: number };
	expected: {
		legacyOrderBooks: number;
		legacyCandles: number;
		canonicalRows: number;
	};
	contentHash: string;
};

function stable(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
		.join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function fixtureContentHash(
	fixture: Omit<UpgradeBaselineFixture, "contentHash">,
): string {
	return sha256(stable(fixture));
}

async function git(source: string, args: string[]): Promise<string> {
	const process = Bun.spawn(["git", "-C", source, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
	}
	return stdout.trim();
}

async function assertDevelopSource(source: string): Promise<void> {
	const [head, branch, dirty, originDevelopLine, githubDevelopLine] =
		await Promise.all([
			git(source, ["rev-parse", "HEAD"]),
			git(source, ["branch", "--show-current"]),
			git(source, ["status", "--porcelain"]),
			git(source, ["ls-remote", "origin", "refs/heads/develop"]),
			git(source, ["ls-remote", "github", "refs/heads/develop"]),
		]);
	const originDevelop = originDevelopLine.split(/\s+/)[0];
	const githubDevelop = githubDevelopLine.split(/\s+/)[0];
	if (dirty) throw new Error("develop baseline source checkout must be clean");
	if (branch !== "" && branch !== "develop") {
		throw new Error(
			"develop baseline source checkout must use develop or a detached develop export",
		);
	}
	if (
		head !== DEVELOP_BASELINE_COMMIT ||
		originDevelop !== DEVELOP_BASELINE_COMMIT ||
		githubDevelop !== DEVELOP_BASELINE_COMMIT
	) {
		throw new Error(
			"develop baseline source and authoritative remotes must resolve to the pinned commit",
		);
	}
	const packageJson = (await Bun.file(join(source, "package.json")).json()) as {
		version?: unknown;
	};
	if (packageJson.version !== DEVELOP_BASELINE_VERSION) {
		throw new Error("develop baseline package version does not match the pin");
	}
}

function developProjection(table: BaselineTable): BaselineTable {
	const projection = table.table.startsWith("market_data.")
		? table.projection.filter((field) => field !== "broker_observed_timestamp")
		: [...table.projection];
	const futureOffsetMs = 300_000_000_000;
	return {
		...structuredClone(table),
		projection,
		fieldTypes: Object.fromEntries(
			projection.map((field) => [field, table.fieldTypes[field] as string]),
		),
		expectedRows: table.expectedRows.map((row) =>
			Object.fromEntries(
				projection.map((field) => {
					const value = row[field];
					const isTime =
						field.endsWith("_time_ms") ||
						field.endsWith("_at_ms") ||
						field === "broker_version";
					return [
						field,
						isTime && typeof value === "number"
							? value + futureOffsetMs
							: value,
					];
				}),
			),
		),
	};
}

function migrationWindow(tables: BaselineTable[]): {
	startTimeMs: number;
	endTimeMs: number;
} {
	const books = tables.find(
		({ table }) => table === "market_data.orderbook_snapshots",
	)?.expectedRows;
	const candles = tables.find(
		({ table }) => table === "market_data.candles",
	)?.expectedRows;
	const values = [
		...(books ?? []).map((row) => Number(row.event_time_ms)),
		...(candles ?? []).map((row) => Number(row.open_time_ms)),
	];
	if (
		values.length < 2 ||
		values.some((value) => !Number.isSafeInteger(value) || value < 0)
	) {
		throw new Error("develop baseline requires safe legacy migration times");
	}
	return {
		startTimeMs: Math.min(...values),
		endTimeMs: Math.max(...values) + 1,
	};
}

export async function generateUpgradeBaseline(
	sourceInput: string,
	outputRoot = UPGRADE_BASELINE_ROOT,
): Promise<UpgradeBaselineFixture> {
	const source = resolve(sourceInput);
	await assertDevelopSource(source);
	await mkdir(join(outputRoot, "schema"), { recursive: true });

	const historical = (await Bun.file(HISTORICAL_FIXTURE_PATH).json()) as {
		tables: BaselineTable[];
	};
	const tables = historical.tables.map(developProjection);
	const sourceHashes: Record<string, string> = {
		"package.json": sha256(await Bun.file(join(source, "package.json")).text()),
		"test/e2e/archive/fixtures/archive-baseline-v1.json": sha256(
			await Bun.file(HISTORICAL_FIXTURE_PATH).text(),
		),
	};
	const schemaFiles: UpgradeBaselineFixture["schemaFiles"] = [];
	for (const sourcePath of SOURCE_SCHEMA_FILES) {
		const contents = await Bun.file(join(source, sourcePath)).text();
		const hash = sha256(contents);
		sourceHashes[sourcePath] = hash;
		const artifactPath = `schema/${basename(sourcePath)}`;
		await Bun.write(join(outputRoot, artifactPath), contents);
		schemaFiles.push({ path: artifactPath, sha256: hash });
	}
	const commitTimestamp = await git(source, [
		"show",
		"-s",
		"--format=%cI",
		DEVELOP_BASELINE_COMMIT,
	]);
	const window = migrationWindow(tables);
	const legacyOrderBooks =
		tables.find(({ table }) => table === "market_data.orderbook_snapshots")
			?.expectedRows.length ?? 0;
	const legacyCandles =
		tables.find(({ table }) => table === "market_data.candles")?.expectedRows
			.length ?? 0;
	const canonicalRows =
		legacyCandles +
		(tables
			.find(({ table }) => table === "market_data.orderbook_snapshots")
			?.expectedRows.reduce(
				(total, row) =>
					total + Number(row.bid_levels) + Number(row.ask_levels) + 1,
				0,
			) ?? 0);
	const withoutHash: Omit<UpgradeBaselineFixture, "contentHash"> = {
		fixtureSchemaVersion: UPGRADE_BASELINE_SCHEMA_VERSION,
		baseline: {
			branch: "develop",
			commit: DEVELOP_BASELINE_COMMIT,
			packageVersion: DEVELOP_BASELINE_VERSION,
			commitTimestamp,
		},
		generationCommand:
			"bun run archive:baseline:generate --source <clean-develop-worktree>",
		tools: { bun: Bun.version, node: process.versions.node },
		sourceHashes,
		schemaFiles,
		tables,
		migrationWindow: window,
		expected: { legacyOrderBooks, legacyCandles, canonicalRows },
	};
	const fixture: UpgradeBaselineFixture = {
		...withoutHash,
		contentHash: fixtureContentHash(withoutHash),
	};
	await Bun.write(
		join(outputRoot, "manifest.json"),
		`${JSON.stringify(fixture, null, 2)}\n`,
	);
	return fixture;
}

export async function loadUpgradeBaseline(
	path = MANIFEST_PATH,
): Promise<UpgradeBaselineFixture> {
	return (await Bun.file(path).json()) as UpgradeBaselineFixture;
}

export async function validateUpgradeBaseline(
	fixture: UpgradeBaselineFixture,
	root = UPGRADE_BASELINE_ROOT,
): Promise<void> {
	const { contentHash, ...withoutHash } = fixture;
	if (contentHash !== fixtureContentHash(withoutHash)) {
		throw new Error("develop baseline fixture content hash mismatch");
	}
	if (
		fixture.fixtureSchemaVersion !== UPGRADE_BASELINE_SCHEMA_VERSION ||
		fixture.baseline.branch !== "develop" ||
		fixture.baseline.commit !== DEVELOP_BASELINE_COMMIT ||
		fixture.baseline.packageVersion !== DEVELOP_BASELINE_VERSION
	) {
		throw new Error("develop baseline identity is incomplete or invalid");
	}
	if (fixture.tables.length !== 15 || fixture.schemaFiles.length !== 4) {
		throw new Error("develop baseline table or schema inventory is incomplete");
	}
	for (const schema of fixture.schemaFiles) {
		const contents = await Bun.file(join(root, schema.path)).text();
		if (sha256(contents) !== schema.sha256) {
			throw new Error(`develop baseline schema hash mismatch: ${schema.path}`);
		}
	}
	if (
		fixture.expected.legacyOrderBooks <= 0 ||
		fixture.expected.legacyCandles <= 0 ||
		fixture.expected.canonicalRows <= 0 ||
		fixture.migrationWindow.endTimeMs <= fixture.migrationWindow.startTimeMs
	) {
		throw new Error("develop baseline migration expectations are invalid");
	}
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
	const [operation = "verify", ...args] = Bun.argv.slice(2);
	if (operation === "generate") {
		const source = option(args, "--source");
		if (!source)
			throw new Error("generate requires --source <clean develop checkout>");
		const fixture = await generateUpgradeBaseline(source);
		console.info(
			JSON.stringify({ ok: true, contentHash: fixture.contentHash }),
		);
		return;
	}
	if (operation === "verify") {
		const fixture = await loadUpgradeBaseline();
		await validateUpgradeBaseline(fixture);
		const source = option(args, "--source");
		if (source) {
			await assertDevelopSource(resolve(source));
		}
		console.info(
			JSON.stringify({ ok: true, contentHash: fixture.contentHash }),
		);
		return;
	}
	throw new Error(`Unknown archive baseline operation: ${operation}`);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
