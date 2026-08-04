#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	STRATEGY_ARCHIVE_TABLES,
	type StrategyArchiveTable,
} from "../services/archive-forwarder/strategy-contract";
import { startProductionBrokerCollectorTopology } from "../test/e2e/archive/support/archive-lifecycle";
import {
	type SidecarManifest,
	validateSidecarManifest,
} from "./archive-sidecar";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const HISTORICAL_FIXTURE = new URL(
	"../test/e2e/archive/fixtures/archive-baseline-v1.json",
	import.meta.url,
);

type SidecarState = {
	ready: boolean;
	stopped?: boolean;
	brokerPort?: number;
	feedsReady?: string[];
	marketCapture?: {
		emittedRows: number;
		feedsObserved: string[];
		sourceWindow: { startTimeMs: number; endTimeMs: number };
	};
	strategy?: {
		source: "maker_replay" | "hb_runtime";
		httpStatus: number;
		spoolDrained: boolean;
	};
	forwarderHealth?: Record<string, unknown>;
	error?: string;
};

function manifestArgument(args: string[]): string {
	if (args.length !== 2 || args[0] !== "--manifest" || !args[1]) {
		throw new Error("Supervisor requires --manifest <path>");
	}
	return resolve(args[1]);
}

async function loadManifest(path: string): Promise<SidecarManifest> {
	const deadline = Date.now() + 10_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return validateSidecarManifest(JSON.parse(await readFile(path, "utf8")));
		} catch (error) {
			lastError = error;
			await Bun.sleep(25);
		}
	}
	throw new Error(`Supervisor could not read manifest: ${String(lastError)}`);
}

async function writeState(
	manifest: SidecarManifest,
	state: SidecarState,
): Promise<void> {
	await writeFile(manifest.statePath, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
}

async function waitForForwarder(
	manifest: SidecarManifest,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 60_000;
	let diagnostic = "forwarder has not responded";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(manifest.forwarderHealthUrl);
			const health = (await response.json()) as Record<string, unknown>;
			if (
				response.ok &&
				health.clickhouse === true &&
				health.durableAdmission === true
			)
				return health;
			diagnostic = JSON.stringify(health);
		} catch (error) {
			diagnostic = error instanceof Error ? error.message : String(error);
		}
		await Bun.sleep(250);
	}
	throw new Error(
		`Production archive-forwarder did not become healthy: ${diagnostic}`,
	);
}

async function waitForDrain(
	manifest: SidecarManifest,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 60_000;
	let latest: Record<string, unknown> = {};
	while (Date.now() < deadline) {
		const response = await fetch(manifest.forwarderHealthUrl);
		latest = (await response.json()) as Record<string, unknown>;
		const spool = latest.spool as Record<string, unknown> | undefined;
		if (
			response.ok &&
			Number(spool?.queuedBatches ?? -1) === 0 &&
			Number(spool?.queuedWork ?? -1) === 0 &&
			Number(spool?.terminalWork ?? -1) === 0
		)
			return latest;
		await Bun.sleep(100);
	}
	throw new Error(`Strategy spool did not drain: ${JSON.stringify(latest)}`);
}

async function strategyRows(
	manifest: SidecarManifest,
	source: "maker_replay" | "hb_runtime",
): Promise<
	Array<{ table: StrategyArchiveTable; row: Record<string, unknown> }>
> {
	const fixture = JSON.parse(await readFile(HISTORICAL_FIXTURE, "utf8")) as {
		tables: Array<{
			table: string;
			expectedRows: Array<Record<string, unknown>>;
		}>;
	};
	const now = Date.now();
	return STRATEGY_ARCHIVE_TABLES.map((table, index) => {
		const original = fixture.tables.find((entry) => entry.table === table)
			?.expectedRows[0];
		if (!original)
			throw new Error(`Historical strategy fixture is missing ${table}`);
		const sequence = index + 1;
		return {
			table,
			row: {
				...original,
				event_time_ms: now + sequence,
				emitted_at_ms: now + sequence + 1,
				source,
				deployment_id: manifest.deploymentId,
				schema_version: "2",
				run_id: manifest.runId,
				producer_id: "fiet-maker-sidecar",
				producer_run_id: manifest.runId,
				stream_name: `${manifest.profile}:${table}`,
				stream_seq: sequence,
				seq: sequence,
				archive_event_id: `${manifest.runId}:${table}:${sequence}`,
			},
		};
	});
}

async function postStrategy(
	manifest: SidecarManifest,
	secret: string,
): Promise<{
	source: "maker_replay" | "hb_runtime";
	httpStatus: number;
	spoolDrained: boolean;
	health: Record<string, unknown>;
}> {
	const source =
		manifest.profile === "native_replay" ? "maker_replay" : "hb_runtime";
	const response = await fetch(manifest.forwarderUrl, {
		method: "POST",
		headers: {
			authorization: `Bearer ${secret}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			source,
			deployment_id: manifest.deploymentId,
			rows: await strategyRows(manifest, source),
		}),
	});
	const expected = source === "maker_replay" ? 200 : 202;
	if (response.status !== expected) {
		throw new Error(
			`Strategy ${source} returned ${response.status}, expected ${expected}: ${await response.text()}`,
		);
	}
	const health = await waitForDrain(manifest);
	return { source, httpStatus: response.status, spoolDrained: true, health };
}

async function main(): Promise<void> {
	const manifest = await loadManifest(manifestArgument(process.argv.slice(2)));
	const secret = process.env.ARCHIVE_SIDECAR_INTERNAL_SECRET;
	if (!secret) throw new Error("Supervisor internal test secret is absent");
	const url = new URL(manifest.forwarderUrl);
	const forwarderLogFd = openSync(manifest.logPath, "a", 0o600);
	const forwarder = spawn(
		process.execPath,
		["run", "services/archive-forwarder/index.ts"],
		{
			cwd: REPOSITORY_ROOT,
			stdio: ["ignore", forwarderLogFd, forwarderLogFd],
			env: {
				...process.env,
				ARCHIVE_FORWARDER_PORT: url.port,
				ARCHIVE_FORWARDER_TOKEN: secret,
				ARCHIVE_FORWARDER_SPOOL_PATH: manifest.spoolPath,
				CLICKHOUSE_HOST: new URL(manifest.clickhouseUrl).hostname,
				CLICKHOUSE_PORT: new URL(manifest.clickhouseUrl).port,
				CLICKHOUSE_USER: "default",
				CLICKHOUSE_PASSWORD: secret,
				// Schema statements create and address fully qualified databases. Connecting
				// through default avoids requiring market_data to exist before initialization.
				CLICKHOUSE_DATABASE: "default",
			},
		},
	);
	closeSync(forwarderLogFd);
	let topology:
		| Awaited<ReturnType<typeof startProductionBrokerCollectorTopology>>
		| undefined;
	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		await topology?.close().catch(() => {});
		if (forwarder.exitCode === null) forwarder.kill("SIGTERM");
		await new Promise<void>((resolveExit) => {
			const timer = setTimeout(() => {
				if (forwarder.exitCode === null) forwarder.kill("SIGKILL");
				resolveExit();
			}, 5_000);
			forwarder.once("exit", () => {
				clearTimeout(timer);
				resolveExit();
			});
		});
		const previous = await readFile(manifest.statePath, "utf8")
			.then((value) => JSON.parse(value) as SidecarState)
			.catch(() => ({ ready: false }));
		await writeState(manifest, { ...previous, ready: false, stopped: true });
	};
	process.once("SIGTERM", () => void shutdown());
	process.once("SIGINT", () => void shutdown());
	try {
		await waitForForwarder(manifest);
		const offset = Date.now() - 1_700_000_000_000 - 60_000;
		topology = await startProductionBrokerCollectorTopology({
			forwarderUrl: manifest.forwarderUrl,
			forwarderToken: secret,
			deploymentId: manifest.deploymentId,
			captureBundleId: manifest.captureBundleId,
			lossJournalPath: `${manifest.artifactsDir}/archive-loss.jsonl`,
			timeOffsetMs: offset,
		});
		const marketCapture = await topology.capture();
		const strategy = await postStrategy(manifest, secret);
		await writeState(manifest, {
			ready: true,
			brokerPort: topology.brokerPort,
			feedsReady: topology.feedsReady,
			marketCapture,
			strategy: {
				source: strategy.source,
				httpStatus: strategy.httpStatus,
				spoolDrained: strategy.spoolDrained,
			},
			forwarderHealth: strategy.health,
		});
		await new Promise<void>((resolveStop) => {
			const finish = () => resolveStop();
			process.once("SIGTERM", finish);
			process.once("SIGINT", finish);
		});
		await shutdown();
	} catch (error) {
		await writeState(manifest, {
			ready: false,
			error: error instanceof Error ? error.message : String(error),
		}).catch(() => {});
		await shutdown();
		throw error;
	}
}

if (import.meta.main) {
	await main();
}
