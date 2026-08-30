import { createClient, type ClickHouseClient } from "@clickhouse/client";

const HOT_TABLES = [
	"cex_order_book_levels",
	"cex_order_book_depth_summary",
] as const;
const OBSOLETE_OBJECTS = [
	"cex_order_book_capture_promotions",
	"cex_order_book_capture_qualifications",
	"cex_order_book_archive_selections",
	"cex_archive_cluster_identity",
	"cex_order_book_levels_replay_qualified",
	"cex_order_book_depth_summary_replay_qualified",
] as const;
const UNCONDITIONAL_TTL =
	"toDateTime(fromUnixTimestamp64Milli(source_time_ms)) + INTERVAL 90 DAY";

export type HistoricalOrderBookInventory = {
	externalRows: Record<(typeof HOT_TABLES)[number], number>;
	tables: Array<{ name: string; engine: string; engine_full: string }>;
	vendorColumns: Array<{ table: string; name: string; type: string }>;
	mutations: Array<{
		table: string;
		mutation_id: string;
		command: string;
		is_done: number;
		latest_fail_reason: string;
	}>;
};

export type RetirementApproval = {
	confirmDestructive: boolean;
	writersStopped: boolean;
	sourceRejectionDeployed: boolean;
	backupLocation: string;
	maintenanceApproval: string;
};

export type RetirementOptions = {
	mutationPollIntervalMs?: number;
	mutationTimeoutMs?: number;
};

async function jsonRows<T>(
	client: ClickHouseClient,
	query: string,
): Promise<T[]> {
	const result = await client.query({ query, format: "JSONEachRow" });
	return (await result.json()) as T[];
}

export async function inventoryHistoricalOrderBookSchema(
	client: ClickHouseClient,
): Promise<HistoricalOrderBookInventory> {
	const externalCounts = await Promise.all(
		HOT_TABLES.map(async (table) => {
			const rows = await jsonRows<{ external_rows: string | number }>(
				client,
				`SELECT count() AS external_rows FROM market_data.${table} WHERE source = 'external_backfill'`,
			);
			return [table, Number(rows[0]?.external_rows ?? 0)] as const;
		}),
	);
	const objectList = [...HOT_TABLES, ...OBSOLETE_OBJECTS]
		.map((name) => `'${name}'`)
		.join(", ");
	const tables = await jsonRows<{
		name: string;
		engine: string;
		engine_full: string;
	}>(
		client,
		`SELECT name, engine, engine_full FROM system.tables WHERE database = 'market_data' AND name IN (${objectList}) ORDER BY name`,
	);
	const vendorColumns = await jsonRows<{
		table: string;
		name: string;
		type: string;
	}>(
		client,
		"SELECT table, name, type FROM system.columns WHERE database = 'market_data' AND table IN ('cex_order_book_levels', 'cex_order_book_depth_summary') AND name = 'capture_origin' ORDER BY table",
	);
	const mutations = await jsonRows<{
		table: string;
		mutation_id: string;
		command: string;
		is_done: number;
		latest_fail_reason: string;
	}>(
		client,
		"SELECT table, mutation_id, command, is_done, latest_fail_reason FROM system.mutations WHERE database = 'market_data' AND table IN ('cex_order_book_levels', 'cex_order_book_depth_summary') ORDER BY table, create_time, mutation_id",
	);
	return {
		externalRows: Object.fromEntries(externalCounts) as HistoricalOrderBookInventory["externalRows"],
		tables,
		vendorColumns,
		mutations,
	};
}

function assertApproval(approval: RetirementApproval): void {
	if (!approval.confirmDestructive) {
		throw new Error("destructive retirement requires explicit confirmation");
	}
	if (!approval.writersStopped) {
		throw new Error("historical writers must be stopped before retirement");
	}
	if (!approval.sourceRejectionDeployed) {
		throw new Error("broker-only source rejection must be deployed before retirement");
	}
	if (!approval.backupLocation.trim()) {
		throw new Error("a reviewed backup/export location is required");
	}
	if (!approval.maintenanceApproval.trim()) {
		throw new Error("maintenance approval identity is required");
	}
}

async function waitForOrderBookMutations(
	client: ClickHouseClient,
	options: RetirementOptions,
): Promise<void> {
	const pollIntervalMs = options.mutationPollIntervalMs ?? 1_000;
	const timeoutMs = options.mutationTimeoutMs ?? 15 * 60_000;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const mutations = await jsonRows<{
			table: string;
			mutation_id: string;
			is_done: number;
			latest_fail_reason: string;
		}>(
			client,
			"SELECT table, mutation_id, is_done, latest_fail_reason FROM system.mutations WHERE database = 'market_data' AND table IN ('cex_order_book_levels', 'cex_order_book_depth_summary') AND command LIKE 'DELETE WHERE source = %external_backfill%' ORDER BY table, create_time, mutation_id",
		);
		const failed = mutations.find(
			(mutation) => mutation.latest_fail_reason.trim().length > 0,
		);
		if (failed) {
			throw new Error(
				`ClickHouse mutation ${failed.table}/${failed.mutation_id} failed: ${failed.latest_fail_reason}`,
			);
		}
		if (mutations.every((mutation) => Number(mutation.is_done) === 1)) return;
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for external_backfill deletion mutations");
		}
		await Bun.sleep(pollIntervalMs);
	}
}

async function command(client: ClickHouseClient, query: string): Promise<void> {
	await client.command({ query });
}

export async function applyHistoricalOrderBookRetirement(
	client: ClickHouseClient,
	approval: RetirementApproval,
	options: RetirementOptions = {},
): Promise<void> {
	assertApproval(approval);
	for (const table of HOT_TABLES) {
		await command(
			client,
			`ALTER TABLE market_data.${table} DELETE WHERE source = 'external_backfill'`,
		);
	}
	await waitForOrderBookMutations(client, options);
	for (const table of HOT_TABLES) {
		await command(
			client,
			`ALTER TABLE market_data.${table} MODIFY TTL ${UNCONDITIONAL_TTL}`,
		);
	}
	for (const view of OBSOLETE_OBJECTS.filter((name) =>
		name.endsWith("_replay_qualified"),
	)) {
		await command(client, `DROP VIEW IF EXISTS market_data.${view}`);
	}
	for (const table of OBSOLETE_OBJECTS.filter(
		(name) => !name.endsWith("_replay_qualified"),
	)) {
		await command(client, `DROP TABLE IF EXISTS market_data.${table}`);
	}
	for (const table of HOT_TABLES) {
		await command(
			client,
			`ALTER TABLE market_data.${table} DROP COLUMN IF EXISTS capture_origin`,
		);
	}
}

export async function verifyHistoricalOrderBookRetirement(
	client: ClickHouseClient,
): Promise<void> {
	const inventory = await inventoryHistoricalOrderBookSchema(client);
	for (const [table, count] of Object.entries(inventory.externalRows)) {
		if (count !== 0) throw new Error(`${table} still contains external_backfill rows`);
	}
	const obsolete = inventory.tables.filter(({ name }) =>
		(OBSOLETE_OBJECTS as readonly string[]).includes(name),
	);
	if (obsolete.length > 0) {
		throw new Error(`obsolete ClickHouse objects remain: ${obsolete.map(({ name }) => name).join(", ")}`);
	}
	if (inventory.vendorColumns.length > 0) {
		throw new Error("capture_origin remains on a hot order-book table");
	}
	const pending = inventory.mutations.filter(
		(mutation) =>
			Number(mutation.is_done) !== 1 || mutation.latest_fail_reason.trim().length > 0,
	);
	if (pending.length > 0) throw new Error("order-book mutations are incomplete or failed");
	for (const table of HOT_TABLES) {
		const metadata = inventory.tables.find(({ name }) => name === table);
		if (!metadata) throw new Error(`required hot table is missing: ${table}`);
		const ttl = metadata.engine_full.toUpperCase();
		if (!ttl.includes("INTERVAL 90 DAY") || ttl.includes("DELETE WHERE")) {
			throw new Error(`${table} does not have the unconditional 90-day TTL`);
		}
	}
}

function argument(name: string): string {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? (Bun.argv[index + 1] ?? "") : "";
}

if (import.meta.main) {
	const action = Bun.argv[2];
	if (!(["inventory", "apply", "verify"] as const).includes(action as never)) {
		throw new Error("usage: order-book-schema-retirement.ts inventory|apply|verify");
	}
	const client = createClient({
		url:
			process.env.CLICKHOUSE_URL?.trim() ||
			`http://${process.env.CLICKHOUSE_HOST?.trim() || "localhost"}:${process.env.CLICKHOUSE_PORT?.trim() || "8123"}`,
		username: process.env.CLICKHOUSE_USER?.trim() || "default",
		password: process.env.CLICKHOUSE_PASSWORD ?? "",
	});
	try {
		if (action === "inventory") {
			console.info(JSON.stringify(await inventoryHistoricalOrderBookSchema(client)));
		} else if (action === "apply") {
			await applyHistoricalOrderBookRetirement(client, {
				confirmDestructive: Bun.argv.includes("--confirm-destructive"),
				writersStopped: Bun.argv.includes("--writers-stopped"),
				sourceRejectionDeployed: Bun.argv.includes("--source-rejection-deployed"),
				backupLocation: argument("--backup-location"),
				maintenanceApproval: argument("--maintenance-approval"),
			});
			await verifyHistoricalOrderBookRetirement(client);
			console.info(JSON.stringify({ ok: true, action: "apply-and-verify" }));
		} else {
			await verifyHistoricalOrderBookRetirement(client);
			console.info(JSON.stringify({ ok: true, action: "verify" }));
		}
	} finally {
		await client.close();
	}
}
