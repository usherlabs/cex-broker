#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startProductionBrokerCollectorTopology } from "../test/e2e/archive/support/archive-lifecycle";
import {
	type SidecarManifest,
	validateSidecarManifest,
} from "./archive-sidecar";
import {
	exportCanonicalOrderBookParquet,
	validateCanonicalMarketReplayWindow,
} from "./export-canonical-orderbook-parquet";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");

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
	forwarderHealth?: Record<string, unknown>;
	brokerObservations?: Record<string, unknown>;
	referenceExport?: Record<string, unknown>;
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

async function sha256File(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function prepareReferenceExport(
	manifest: SidecarManifest,
	secret: string,
	marketCapture: NonNullable<SidecarState["marketCapture"]>,
): Promise<Record<string, unknown>> {
	const replayWindow = {
		clickhouseUrl: manifest.clickhouseUrl,
		username: "default",
		password: secret,
		captureBundleIds: [manifest.captureBundleId],
		exchange: "binance",
		tradingPair: "BTC-USDT",
		...marketCapture.sourceWindow,
	};
	const coverage = await validateCanonicalMarketReplayWindow(replayWindow);
	const exported = await exportCanonicalOrderBookParquet({
		...replayWindow,
		outputDirectory: join(manifest.artifactsDir, "fiet-907-reference-export"),
	});
	const result = {
		schemaVersion: "cex-canonical-orderbook-export/v1",
		runId: manifest.runId,
		captureBundleId: manifest.captureBundleId,
		exchange: "binance",
		tradingPair: "BTC-USDT",
		sourceWindow: marketCapture.sourceWindow,
		levels: {
			path: exported.levelsPath,
			rows: exported.levelRows,
			sha256: await sha256File(exported.levelsPath),
		},
		summary: {
			path: exported.summaryPath,
			rows: exported.summaryRows,
			sha256: await sha256File(exported.summaryPath),
		},
		coverage,
	};
	await writeFile(
		manifest.referenceExportPath,
		`${JSON.stringify(result, null, 2)}\n`,
		{
			mode: 0o600,
		},
	);
	return result;
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
				CLICKHOUSE_URL: manifest.clickhouseUrl,
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
	let observationTimer: ReturnType<typeof setInterval> | undefined;
	let observationWrite: Promise<void> | undefined;
	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		if (observationTimer) clearInterval(observationTimer);
		await observationWrite?.catch(() => {});
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
			brokerPort: Number(manifest.brokerUrl.split(":")[1]),
		});
		const marketCapture = await topology.capture();
		const referenceExport =
			manifest.profile === "native_replay"
				? await prepareReferenceExport(manifest, secret, marketCapture)
				: undefined;
		const forwarderHealth = await waitForDrain(manifest);
		const readyState: SidecarState = {
			ready: true,
			brokerPort: topology.brokerPort,
			feedsReady: topology.feedsReady,
			marketCapture,
			forwarderHealth,
			brokerObservations: topology.brokerObservations(),
			...(referenceExport ? { referenceExport } : {}),
		};
		await writeState(manifest, readyState);
		observationTimer = setInterval(() => {
			if (observationWrite || shuttingDown || !topology) return;
			const write = writeState(manifest, {
				...readyState,
				brokerObservations: topology.brokerObservations(),
			});
			observationWrite = write;
			void write.finally(() => {
				if (observationWrite === write) observationWrite = undefined;
			});
		}, 250);
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
