import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type ArchiveBaselineFixture,
	type ArchiveBaselineTable,
	BASELINE_COMMIT,
	BASELINE_RUNTIME_PARENT,
	BASELINE_TABLES,
	type BaselineFieldType,
	validateArchiveBaselineFixture,
} from "../test/e2e/archive/support/archive-baseline";

const REPOSITORY_ROOT = join(import.meta.dir, "..");
const INPUT_PATH = join(
	REPOSITORY_ROOT,
	"test/e2e/archive/fixtures/archive-baseline-input-v1.json",
);
const FIXTURE_PATH = join(
	REPOSITORY_ROOT,
	"test/e2e/archive/fixtures/archive-baseline-v1.json",
);
const DRIVER_PATH = join(import.meta.dir, "archive-e2e-baseline-driver.ts");
const CANONICAL_RUNTIME_COMMIT = "d018a386b55058bccb71b0feb4ea21358b8bd8d9";
const BASELINE_BUN_VERSION = "1.3.12";
const BASELINE_PLATFORM = "linux-x64";

const BASELINE_SOURCE_PATHS = [
	"services/archive-forwarder/types.ts",
	"services/archive-forwarder/schema.ts",
	"schema/clickhouse/market_data.sql",
	"schema/clickhouse/broker_execution.sql",
	"schema/clickhouse/broker_account.sql",
	"schema/clickhouse/strategy_data.sql",
	"src/helpers/market-data-archive/rows.ts",
	"src/helpers/market-data-archive/orderbook-depth.ts",
	"src/helpers/broker-execution-archive/rows.ts",
	"src/helpers/broker-execution-archive/redact.ts",
	"src/helpers/broker-execution-archive/types.ts",
	"src/helpers/shared/guards.ts",
	"src/helpers/order-book.ts",
	"test/fixtures/archive_forwarder_envelope.json",
] as const;

const COMPARISON_KEYS: Record<(typeof BASELINE_TABLES)[number], string[]> = {
	"market_data.candles": [
		"deployment_id",
		"exchange",
		"symbol",
		"timeframe",
		"open_time_ms",
	],
	"market_data.orderbook_snapshots": [
		"deployment_id",
		"exchange",
		"symbol",
		"event_time_ms",
	],
	"market_data.cex_stream_events": [
		"deployment_id",
		"exchange",
		"symbol",
		"stream_type",
		"event_time_ms",
	],
	"market_data.cex_ticker_events": [
		"deployment_id",
		"exchange",
		"symbol",
		"event_time_ms",
	],
	"market_data.cex_trades": ["deployment_id", "exchange", "symbol", "trade_id"],
	"broker_execution.order_events": [
		"deployment_id",
		"exchange",
		"symbol",
		"broker_observed_timestamp",
		"event_kind",
	],
	"broker_execution.market_metadata_snapshots": [
		"deployment_id",
		"exchange",
		"symbol",
		"market_metadata_hash",
	],
	"broker_execution.transfer_events": [
		"deployment_id",
		"external_id",
		"lifecycle_action",
	],
	"broker_execution.fill_events": [
		"deployment_id",
		"exchange",
		"symbol",
		"order_id",
		"fill_id",
	],
	"broker_account.balance_snapshots": [
		"deployment_id",
		"exchange",
		"account_selector",
		"observation_id",
	],
	"strategy_data.policy_evaluation_events": ["deployment_id", "run_id", "seq"],
	"strategy_data.strategy_policy_snapshots": ["deployment_id", "run_id", "seq"],
	"strategy_data.market_identity": ["deployment_id", "run_id", "seq"],
	"strategy_data.symbol_mapping": ["deployment_id", "run_id", "seq"],
	"strategy_data.inventory_settlement_events": [
		"deployment_id",
		"run_id",
		"seq",
	],
};

const STORAGE_FIELD_TYPES: Partial<
	Record<(typeof BASELINE_TABLES)[number], Record<string, BaselineFieldType>>
> = {
	"market_data.candles": {
		open: "decimal8",
		high: "decimal8",
		low: "decimal8",
		close: "decimal8",
		volume: "decimal8",
		quote_volume: "nullable-decimal8",
	},
	"market_data.orderbook_snapshots": {
		best_bid: "decimal8",
		best_ask: "decimal8",
		bid_size: "decimal8",
		ask_size: "decimal8",
		mid: "decimal8",
		spread_bps: "float32",
		bids_price: "decimal8-array",
		bids_size: "decimal8-array",
		asks_price: "decimal8-array",
		asks_size: "decimal8-array",
	},
	"market_data.cex_ticker_events": {
		last: "nullable-decimal8",
		bid: "nullable-decimal8",
		ask: "nullable-decimal8",
		high: "nullable-decimal8",
		low: "nullable-decimal8",
		open: "nullable-decimal8",
		close: "nullable-decimal8",
		base_volume: "nullable-decimal8",
		quote_volume: "nullable-decimal8",
		change: "nullable-decimal8",
		percentage: "nullable-decimal8",
	},
	"market_data.cex_trades": {
		price: "decimal8",
		amount: "decimal8",
		cost: "nullable-decimal8",
	},
	"broker_execution.transfer_events": {
		broker_observed_timestamp: "datetime",
		exchange_timestamp: "nullable-datetime",
	},
	"broker_execution.fill_events": {
		broker_observed_timestamp: "datetime",
		exchange_timestamp: "nullable-datetime",
	},
	"broker_account.balance_snapshots": {
		broker_observed_timestamp: "datetime",
		exchange_timestamp: "nullable-datetime",
	},
};

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

async function run(
	command: string[],
	options: { cwd?: string } = {},
): Promise<string> {
	const process = Bun.spawn(command, {
		cwd: options.cwd ?? REPOSITORY_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
	}
	return stdout;
}

function fieldType(value: unknown): BaselineFieldType {
	if (value === null) return "nullable-string";
	if (typeof value === "string") return "string";
	if (typeof value === "number") {
		return Number.isInteger(value) ? "integer" : "number";
	}
	if (Array.isArray(value)) {
		return value.every((entry) => typeof entry === "string")
			? "string-array"
			: "number-array";
	}
	if (typeof value === "object") return "string-map";
	throw new Error(`unsupported baseline fixture value: ${String(value)}`);
}

function tableFixture(input: {
	table: string;
	row: Record<string, unknown>;
}): ArchiveBaselineTable {
	if (!(BASELINE_TABLES as readonly string[]).includes(input.table)) {
		throw new Error(`historical driver emitted unknown table ${input.table}`);
	}
	const table = input.table as (typeof BASELINE_TABLES)[number];
	const projection = Object.keys(input.row);
	const fieldTypes = Object.fromEntries(
		projection.map((field) => [
			field,
			STORAGE_FIELD_TYPES[table]?.[field] ?? fieldType(input.row[field]),
		]),
	) as Record<string, BaselineFieldType>;
	return {
		table,
		projection,
		fieldTypes,
		comparisonKey: COMPARISON_KEYS[table],
		sortOrder: COMPARISON_KEYS[table],
		expectedRows: [input.row],
	};
}

async function exportHistoricalRuntime(exportRoot: string): Promise<void> {
	const archivePath = join(exportRoot, "baseline.tar");
	const sourceRoot = join(exportRoot, "source");
	await mkdir(sourceRoot, { recursive: true });
	await run([
		"git",
		"archive",
		"--format=tar",
		`--output=${archivePath}`,
		BASELINE_COMMIT,
	]);
	await run(["tar", "-xf", archivePath, "-C", sourceRoot]);
	const exportedDriver = join(
		sourceRoot,
		"scripts/archive-e2e-baseline-driver.ts",
	);
	const exportedInput = join(
		sourceRoot,
		"test/e2e/archive/fixtures/archive-baseline-input-v1.json",
	);
	await mkdir(dirname(exportedInput), { recursive: true });
	await copyFile(DRIVER_PATH, exportedDriver);
	await copyFile(INPUT_PATH, exportedInput);
	const output = await run(
		["bun", "run", "scripts/archive-e2e-baseline-driver.ts", exportedInput],
		{ cwd: sourceRoot },
	);
	await Bun.write(join(exportRoot, "rows.json"), output);
}

async function baselineSourceHashes(): Promise<Record<string, string>> {
	const entries = await Promise.all(
		BASELINE_SOURCE_PATHS.map(async (path) => {
			const contents = await run(["git", "show", `${BASELINE_COMMIT}:${path}`]);
			return [path, sha256(contents)] as const;
		}),
	);
	entries.push([
		"tooling:scripts/archive-e2e-baseline-driver.ts",
		sha256(await readFile(DRIVER_PATH)),
	]);
	return Object.fromEntries(entries);
}

function verifyGeneratorEnvironment(): void {
	const platform = `${process.platform}-${process.arch}`;
	if (platform !== BASELINE_PLATFORM) {
		throw new Error(
			`baseline regeneration requires ${BASELINE_PLATFORM}, received ${platform}`,
		);
	}
	if (Bun.version !== BASELINE_BUN_VERSION) {
		throw new Error(
			`baseline regeneration requires Bun ${BASELINE_BUN_VERSION}, received ${Bun.version}`,
		);
	}
}

async function generateFixture(): Promise<ArchiveBaselineFixture> {
	verifyGeneratorEnvironment();
	const temporaryRoot = await mkdtemp(
		join(tmpdir(), "cex-broker-archive-baseline-"),
	);
	try {
		await exportHistoricalRuntime(temporaryRoot);
		const rows = JSON.parse(
			await readFile(join(temporaryRoot, "rows.json"), "utf8"),
		) as Array<{ table: string; row: Record<string, unknown> }>;
		if (
			rows.map(({ table }) => table).join("\n") !== BASELINE_TABLES.join("\n")
		) {
			throw new Error(
				"historical driver did not emit the exact baseline table inventory",
			);
		}
		const fixture: ArchiveBaselineFixture = {
			fixtureSchemaVersion: "archive-e2e-baseline/v1",
			baselineCommit: BASELINE_COMMIT,
			runtimeEquivalentParent: BASELINE_RUNTIME_PARENT,
			canonicalRuntimeCommit: CANONICAL_RUNTIME_COMMIT,
			generationCommand: "bun run scripts/generate-archive-e2e-baseline.ts",
			generatorEnvironment: {
				platform: BASELINE_PLATFORM,
				bunVersion: BASELINE_BUN_VERSION,
				lockfileHash: sha256(await readFile(join(REPOSITORY_ROOT, "bun.lock"))),
			},
			sourceHashes: await baselineSourceHashes(),
			inputHash: sha256(await readFile(INPUT_PATH)),
			tables: rows.map(tableFixture),
		};
		validateArchiveBaselineFixture(fixture);
		return fixture;
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

const fixture = await generateFixture();
const serialized = `${JSON.stringify(fixture, null, "\t")}\n`;
if (process.argv.includes("--check")) {
	const committed = await readFile(FIXTURE_PATH, "utf8");
	if (committed !== serialized) {
		throw new Error(
			"archive baseline fixture differs from deterministic regeneration",
		);
	}
} else {
	await Bun.write(FIXTURE_PATH, serialized);
}
