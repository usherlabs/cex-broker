#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { resolve } from "node:path";
import { startProductionBrokerCollectorTopology } from "../test/e2e/archive/support/archive-lifecycle";
import {
	type SidecarManifest,
	validateSidecarManifest,
} from "./archive-sidecar";

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

async function readLoopbackHealth(
	manifest: SidecarManifest,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
	let url: URL;
	try {
		url = new URL(manifest.forwarderHealthUrl);
	} catch {
		throw new Error("Forwarder health URL is invalid");
	}
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/health" ||
		!url.port
	) {
		throw new Error("Forwarder health URL is outside loopback");
	}
	return new Promise((resolveHealth, reject) => {
		const healthRequest = request(
			{
				host: "127.0.0.1",
				port: Number(url.port),
				path: "/health",
				method: "GET",
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.once("error", reject);
				response.once("end", () => {
					try {
						resolveHealth({
							statusCode: response.statusCode ?? 0,
							body: JSON.parse(
								Buffer.concat(chunks).toString("utf8"),
							) as Record<string, unknown>,
						});
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		healthRequest.once("error", reject);
		healthRequest.end();
	});
}

async function waitForForwarder(
	manifest: SidecarManifest,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 60_000;
	let diagnostic = "forwarder has not responded";
	while (Date.now() < deadline) {
		try {
			const response = await readLoopbackHealth(manifest);
			const health = response.body;
			if (
				response.statusCode >= 200 &&
				response.statusCode < 300 &&
				health.clickhouse === true &&
				health.durableAdmission === true
			) {
				return health;
			}
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

function spoolIsDrained(health: Record<string, unknown>): boolean {
	const spool = health.spool as Record<string, unknown> | undefined;
	return (
		Number(spool?.queuedBatches ?? -1) === 0 &&
		Number(spool?.queuedWork ?? -1) === 0 &&
		Number(spool?.terminalWork ?? -1) === 0
	);
}

async function waitForDrain(
	manifest: SidecarManifest,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 60_000;
	let latest: Record<string, unknown> = {};
	while (Date.now() < deadline) {
		const response = await readLoopbackHealth(manifest);
		latest = response.body;
		if (
			response.statusCode >= 200 &&
			response.statusCode < 300 &&
			spoolIsDrained(latest)
		) {
			return latest;
		}
		await Bun.sleep(100);
	}
	throw new Error(`Strategy spool did not drain: ${JSON.stringify(latest)}`);
}

async function main(): Promise<void> {
	const manifest = await loadManifest(manifestArgument(process.argv.slice(2)));
	const secret = process.env.ARCHIVE_SIDECAR_INTERNAL_SECRET;
	if (!secret) throw new Error("Supervisor internal test secret is absent");
	let url: URL;
	try {
		url = new URL(manifest.forwarderUrl);
	} catch {
		throw new Error("Forwarder URL is invalid");
	}
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
				ARCHIVE_FORWARDER_MARKET_SOURCE: "broker_read",
				ARCHIVE_FORWARDER_MARKET_DEPLOYMENT_ID: manifest.deploymentId,
				ARCHIVE_FORWARDER_SPOOL_PATH: manifest.spoolPath,
				CLICKHOUSE_URL: manifest.clickhouseUrl,
				CLICKHOUSE_USER: "default",
				CLICKHOUSE_PASSWORD: secret,
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
		let previous: SidecarState = { ready: false };
		try {
			previous = JSON.parse(
				await readFile(manifest.statePath, "utf8"),
			) as SidecarState;
		} catch {
			// A missing or malformed state file cannot prevent bounded cleanup.
		}
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
		const forwarderHealth = await waitForDrain(manifest);
		let latestForwarderHealth = forwarderHealth;
		const readyState: SidecarState = {
			ready: true,
			brokerPort: topology.brokerPort,
			feedsReady: topology.feedsReady,
			marketCapture,
			forwarderHealth,
			brokerObservations: topology.brokerObservations(),
		};
		await writeState(manifest, readyState);
		const activeTopology = topology;
		observationTimer = setInterval(() => {
			if (observationWrite || shuttingDown) return;
			const write = (async () => {
				const healthResponse = await readLoopbackHealth(manifest);
				if (
					healthResponse.statusCode >= 200 &&
					healthResponse.statusCode < 300
				) {
					latestForwarderHealth = healthResponse.body;
				}
				await writeState(manifest, {
					...readyState,
					forwarderHealth: latestForwarderHealth,
					brokerObservations: activeTopology.brokerObservations(),
				});
			})();
			observationWrite = write;
			void write
				.catch(() => {})
				.finally(() => {
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
