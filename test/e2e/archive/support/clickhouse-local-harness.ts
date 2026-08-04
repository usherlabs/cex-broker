import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RowInserter } from "../../../../services/archive-forwarder/insert";
import {
	ARCHIVE_SCHEMA_FILES,
	archiveSchemaFilePath,
	splitSqlStatements,
} from "../../../../services/archive-forwarder/schema";
import type { SupportedTable } from "../../../../services/archive-forwarder/types";
import {
	type BaselineFieldType,
	normalizeBaselineFixtureRow,
} from "./archive-baseline";
import {
	resolveClickHouseLocalBinary,
	verifyClickHouseLocalBinary,
} from "./clickhouse-local-binary";

export type ClickHouseLocalHarnessOptions = {
	binaryPath?: string;
};

const FIXTURE_TTL_TABLES = [
	"market_data.orderbook_snapshots",
	"market_data.cex_stream_events",
	"market_data.cex_ticker_events",
	"market_data.cex_trades",
	"market_data.cex_order_book_levels",
	"market_data.cex_order_book_depth_summary",
] as const;

export class ClickHouseLocalHarness {
	public readonly inserter: RowInserter;
	public readonly rootDirectory: string;
	public readonly databasePath: string;
	public readonly binaryPath: string;
	public maxObservedConcurrentCommands = 0;
	private activeCommands = 0;
	private cleaned = false;
	private closing = false;
	private commandTail: Promise<void> = Promise.resolve();
	private readonly ownedProcesses = new Set<ReturnType<typeof Bun.spawn>>();

	private constructor(rootDirectory: string, binaryPath: string) {
		this.rootDirectory = rootDirectory;
		this.databasePath = join(rootDirectory, "database");
		this.binaryPath = binaryPath;
		this.inserter = (table, rows) => this.insert(table, rows);
	}

	public static async create(
		options: ClickHouseLocalHarnessOptions = {},
	): Promise<ClickHouseLocalHarness> {
		const binaryPath = options.binaryPath
			? await verifyClickHouseLocalBinary(options.binaryPath)
			: await resolveClickHouseLocalBinary();
		const rootDirectory = await mkdtemp(
			join(tmpdir(), "cex-broker-clickhouse-local-e2e-"),
		);
		return new ClickHouseLocalHarness(rootDirectory, binaryPath);
	}

	public async initialize(): Promise<void> {
		await mkdir(this.databasePath, { recursive: true });
		for (const fileName of ARCHIVE_SCHEMA_FILES) {
			const path = archiveSchemaFilePath(fileName);
			const sql = await Bun.file(path).text();
			const statements = splitSqlStatements(sql);
			try {
				await this.execute(sql);
			} catch (fileError) {
				for (const [index, statement] of statements.entries()) {
					try {
						await this.execute(statement);
					} catch (statementError) {
						throw new Error(
							`ClickHouse Local schema initialization failed in ${fileName} statement ${index + 1}/${statements.length}`,
							{ cause: statementError },
						);
					}
				}
				throw new Error(
					`ClickHouse Local schema initialization failed in ${fileName}; diagnostic replay was idempotent`,
					{ cause: fileError },
				);
			}
		}
		// The golden inputs intentionally pin historical timestamps. Execute the
		// production TTL declarations above, then remove only retention inside this
		// disposable database so the fixture cannot expire as wall-clock time moves.
		for (const table of FIXTURE_TTL_TABLES) {
			await this.execute(`ALTER TABLE ${table} REMOVE TTL`);
		}
	}

	public async execute(sql: string): Promise<void> {
		await this.runSerialized(sql);
	}

	public async query(
		sql: string,
		fieldTypes?: Record<string, BaselineFieldType>,
	): Promise<Array<Record<string, unknown>>> {
		const query = /\bFORMAT\s+/i.test(sql)
			? sql
			: `${sql.replace(/;\s*$/, "")} FORMAT JSONEachRow`;
		const { stdout } = await this.runSerialized(query);
		const rows = stdout
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		return fieldTypes
			? rows.map((row) => normalizeBaselineFixtureRow(row, fieldTypes))
			: rows;
	}

	public async cleanup(): Promise<void> {
		if (this.cleaned) return;
		this.closing = true;
		await this.commandTail;
		for (const process of this.ownedProcesses) {
			process.kill("SIGKILL");
		}
		this.cleaned = true;
		await rm(this.rootDirectory, { recursive: true, force: true });
	}

	private async insert(
		table: SupportedTable,
		rows: Record<string, unknown>[],
	): Promise<void> {
		if (rows.length === 0) return;
		const input = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
		await this.runSerialized(`INSERT INTO ${table} FORMAT JSONEachRow`, input);
	}

	private runSerialized(
		query: string,
		stdin?: string,
	): Promise<{ stdout: string; stderr: string }> {
		if (this.closing || this.cleaned) {
			return Promise.reject(new Error("ClickHouseLocalHarness is closed"));
		}
		const operation = this.commandTail.then(() =>
			this.runCommand(query, stdin),
		);
		this.commandTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async runCommand(
		query: string,
		stdin?: string,
	): Promise<{ stdout: string; stderr: string }> {
		this.activeCommands += 1;
		this.maxObservedConcurrentCommands = Math.max(
			this.maxObservedConcurrentCommands,
			this.activeCommands,
		);
		const process = Bun.spawn(
			[
				this.binaryPath,
				"local",
				"--path",
				this.databasePath,
				"--multiquery",
				"--date_time_input_format=best_effort",
				"--output_format_json_quote_64bit_integers=0",
				"--query",
				query,
			],
			{
				stdin: stdin === undefined ? "ignore" : "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		this.ownedProcesses.add(process);
		if (stdin !== undefined) {
			process.stdin.write(stdin);
			process.stdin.end();
		}
		const timeout = setTimeout(() => process.kill("SIGKILL"), 60_000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				process.exited,
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
			]);
			if (stdout.length > 16 * 1024 * 1024 || stderr.length > 1024 * 1024) {
				throw new Error("ClickHouse Local command output exceeded its bound");
			}
			if (exitCode !== 0) {
				throw new Error(
					`ClickHouse Local exited ${exitCode}: ${stderr.trim() || stdout.trim()}\nQuery: ${query}`,
				);
			}
			return { stdout, stderr };
		} finally {
			clearTimeout(timeout);
			this.ownedProcesses.delete(process);
			this.activeCommands -= 1;
		}
	}
}
