import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const BASELINE_COMMIT =
	"64fdf0607a234be05bac98f3edd3125e2c05d083" as const;
export const BASELINE_RUNTIME_PARENT =
	"d20daf895616cdce1cff65a8191c0bb937583c6a" as const;

export const BASELINE_TABLES = [
	"market_data.candles",
	"market_data.orderbook_snapshots",
	"market_data.cex_stream_events",
	"market_data.cex_ticker_events",
	"market_data.cex_trades",
	"broker_execution.order_events",
	"broker_execution.market_metadata_snapshots",
	"broker_execution.transfer_events",
	"broker_execution.fill_events",
	"broker_account.balance_snapshots",
	"strategy_data.policy_evaluation_events",
	"strategy_data.strategy_policy_snapshots",
	"strategy_data.market_identity",
	"strategy_data.symbol_mapping",
	"strategy_data.inventory_settlement_events",
] as const;

export const CANONICAL_BASE_TABLES = [
	"market_data.cex_ohlcv",
	"market_data.cex_order_book_levels",
	"market_data.cex_order_book_depth_summary",
] as const;

export const CANONICAL_VIEWS = [
	"market_data.cex_ohlcv_closed",
	"market_data.cex_order_book_levels_canonical",
	"market_data.cex_order_book_levels_conflicts",
	"market_data.cex_order_book_depth_summary_canonical",
	"market_data.cex_order_book_depth_summary_conflicts",
] as const;

export type BaselineFieldType =
	| "string"
	| "integer"
	| "number"
	| "float32"
	| "decimal8"
	| "datetime"
	| "nullable-string"
	| "nullable-integer"
	| "nullable-number"
	| "nullable-decimal8"
	| "nullable-datetime"
	| "string-array"
	| "number-array"
	| "decimal8-array"
	| "string-map";

export type ArchiveBaselineTable = {
	table: (typeof BASELINE_TABLES)[number];
	projection: string[];
	fieldTypes: Record<string, BaselineFieldType>;
	comparisonKey: string[];
	sortOrder: string[];
	expectedRows: Array<Record<string, unknown>>;
};

export type ArchiveBaselineFixture = {
	fixtureSchemaVersion: "archive-e2e-baseline/v1";
	baselineCommit: typeof BASELINE_COMMIT;
	runtimeEquivalentParent: typeof BASELINE_RUNTIME_PARENT;
	canonicalRuntimeCommit: string;
	generationCommand: string;
	generatorEnvironment: {
		platform: string;
		bunVersion: string;
		lockfileHash: string;
	};
	sourceHashes: Record<string, string>;
	inputHash: string;
	tables: ArchiveBaselineTable[];
};

export function normalizeBaselineFixtureValue(
	value: unknown,
	type: BaselineFieldType,
): unknown {
	if (value === null && type.startsWith("nullable-")) return null;
	switch (type) {
		case "string":
		case "nullable-string":
			return String(value);
		case "integer":
		case "nullable-integer":
		case "number":
		case "nullable-number":
			return Number(value);
		case "float32":
			return Math.fround(Number(value));
		case "decimal8":
		case "nullable-decimal8":
			return Number(Number(value).toFixed(8));
		case "datetime":
		case "nullable-datetime":
			return normalizeClickHouseDateTime(value);
		case "string-array":
			return (value as unknown[]).map(String);
		case "number-array":
			return (value as unknown[]).map(Number);
		case "decimal8-array":
			return (value as unknown[]).map((entry) =>
				Number(Number(entry).toFixed(8)),
			);
		case "string-map":
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
					key,
					String(entry),
				]),
			);
	}
}

export function normalizeBaselineFixtureRow(
	row: Record<string, unknown>,
	fieldTypes: Record<string, BaselineFieldType>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(fieldTypes).map(([field, type]) => [
			field,
			normalizeBaselineFixtureValue(row[field], type),
		]),
	);
}

function normalizeClickHouseDateTime(value: unknown): string {
	const rendered = String(value);
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(rendered)) {
		return new Date(`${rendered.replace(" ", "T")}Z`).toISOString();
	}
	return new Date(rendered).toISOString();
}

const REPOSITORY_ROOT = join(import.meta.dir, "../../../..");
const FIXTURE_PATH = join(
	import.meta.dir,
	"../fixtures/archive-baseline-v1.json",
);

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
}

function assertStringArray(
	value: unknown,
	label: string,
): asserts value is string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((entry) => typeof entry !== "string" || entry.length === 0)
	) {
		throw new Error(`${label} must be a non-empty string array`);
	}
}

export function validateArchiveBaselineFixture(
	value: unknown,
): asserts value is ArchiveBaselineFixture {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("archive baseline fixture must be an object");
	}
	const fixture = value as Partial<ArchiveBaselineFixture>;
	if (fixture.fixtureSchemaVersion !== "archive-e2e-baseline/v1") {
		throw new Error("archive baseline fixture schema version is invalid");
	}
	if (
		fixture.baselineCommit !== BASELINE_COMMIT ||
		fixture.runtimeEquivalentParent !== BASELINE_RUNTIME_PARENT
	) {
		throw new Error("archive baseline commit provenance is invalid");
	}
	assertString(fixture.canonicalRuntimeCommit, "canonical runtime commit");
	assertString(fixture.generationCommand, "generation command");
	if (!fixture.generatorEnvironment) {
		throw new Error("generator environment is missing");
	}
	assertString(fixture.generatorEnvironment.platform, "generator platform");
	assertString(
		fixture.generatorEnvironment.bunVersion,
		"generator Bun version",
	);
	if (!/^[a-f0-9]{64}$/.test(fixture.generatorEnvironment.lockfileHash)) {
		throw new Error("generator lockfile hash must be SHA-256");
	}
	if (!fixture.sourceHashes || Object.keys(fixture.sourceHashes).length === 0) {
		throw new Error("baseline source hashes are missing");
	}
	for (const [path, hash] of Object.entries(fixture.sourceHashes)) {
		if (!path || !/^[a-f0-9]{64}$/.test(hash)) {
			throw new Error(
				"baseline source hashes must be path-keyed SHA-256 values",
			);
		}
	}
	if (!fixture.inputHash || !/^[a-f0-9]{64}$/.test(fixture.inputHash)) {
		throw new Error("baseline input hash must be SHA-256");
	}
	if (!Array.isArray(fixture.tables)) {
		throw new Error("baseline table inventory is missing");
	}
	const tables = fixture.tables.map(({ table }) => table);
	if (JSON.stringify(tables) !== JSON.stringify(BASELINE_TABLES)) {
		throw new Error(
			"baseline table inventory does not match the immutable set",
		);
	}
	for (const table of fixture.tables) {
		assertStringArray(table.projection, `${table.table} projection`);
		if (
			!table.fieldTypes ||
			JSON.stringify(Object.keys(table.fieldTypes)) !==
				JSON.stringify(table.projection)
		) {
			throw new Error(`${table.table} projection and field types must match`);
		}
		assertStringArray(table.comparisonKey, `${table.table} comparison key`);
		assertStringArray(table.sortOrder, `${table.table} sort order`);
		for (const field of [...table.comparisonKey, ...table.sortOrder]) {
			if (!table.projection.includes(field)) {
				throw new Error(
					`${table.table} ordering field ${field} is not projected`,
				);
			}
		}
		if (!Array.isArray(table.expectedRows) || table.expectedRows.length === 0) {
			throw new Error(`${table.table} expected rows are missing`);
		}
		for (const row of table.expectedRows) {
			if (
				!row ||
				typeof row !== "object" ||
				table.projection.some((field) => !(field in row))
			) {
				throw new Error(
					`${table.table} expected row does not match projection`,
				);
			}
		}
	}
}

export async function loadArchiveBaselineFixture(): Promise<ArchiveBaselineFixture> {
	const value = await Bun.file(FIXTURE_PATH).json();
	validateArchiveBaselineFixture(value);
	return value;
}

export function assertBaselineTableRows(
	table: ArchiveBaselineTable,
	actualRows: Array<Record<string, unknown>>,
): void {
	const projected = actualRows.map((row) =>
		normalizeBaselineFixtureRow(
			Object.fromEntries(table.projection.map((field) => [field, row[field]])),
			table.fieldTypes,
		),
	);
	const expected = table.expectedRows.map((row) =>
		normalizeBaselineFixtureRow(row, table.fieldTypes),
	);
	if (!isDeepStrictEqual(projected, expected)) {
		throw new Error(
			`${table.table} has a missing, changed, or duplicated legacy row`,
		);
	}
}

async function gitLines(args: string[]): Promise<string[]> {
	const process = Bun.spawn(["git", ...args], {
		cwd: REPOSITORY_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
	}
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export async function auditBaselineHistory(): Promise<{
	baselineCommit: typeof BASELINE_COMMIT;
	runtimeParent: typeof BASELINE_RUNTIME_PARENT;
	changedPaths: string[];
}> {
	const [actualParent] = await gitLines(["rev-parse", `${BASELINE_COMMIT}^`]);
	if (actualParent !== BASELINE_RUNTIME_PARENT) {
		throw new Error(
			`baseline parent ${actualParent ?? "(missing)"} does not match ${BASELINE_RUNTIME_PARENT}`,
		);
	}
	const changedPaths = await gitLines([
		"diff",
		"--name-only",
		BASELINE_RUNTIME_PARENT,
		BASELINE_COMMIT,
	]);
	return {
		baselineCommit: BASELINE_COMMIT,
		runtimeParent: BASELINE_RUNTIME_PARENT,
		changedPaths,
	};
}
