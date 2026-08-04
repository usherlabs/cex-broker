import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RowInserter } from "../../../../services/archive-forwarder/insert";
import { handleArchiveRequest } from "../../../../services/archive-forwarder/request";
import { StrategyArchiveSpool } from "../../../../services/archive-forwarder/strategy-spool";
import { StrategySpoolWorker } from "../../../../services/archive-forwarder/strategy-worker";
import { ArchiveForwarderTelemetry } from "../../../../services/archive-forwarder/telemetry";
import type { ArchiveBatchRequest } from "../../../../services/archive-forwarder/types";
import type { ArchiveForwarderEndpoint } from "./archive-e2e-contracts";

export async function startArchiveForwarderEndpoint(options: {
	inserter: RowInserter;
	authToken?: string;
	spoolPath?: string;
}): Promise<ArchiveForwarderEndpoint> {
	const ownsSpoolDirectory = !options.spoolPath;
	const spoolDirectory = ownsSpoolDirectory
		? await mkdtemp(join(tmpdir(), "cex-broker-archive-e2e-spool-"))
		: undefined;
	const spool = new StrategyArchiveSpool({
		path:
			options.spoolPath ??
			join(spoolDirectory as string, "strategy-spool.sqlite"),
	});
	let requestCount = 0;
	const batches: ArchiveBatchRequest[] = [];
	const telemetry = new ArchiveForwarderTelemetry({
		recordCounter: () => {},
		setObservableGauge: () => {},
	});
	const worker = new StrategySpoolWorker({
		spool,
		inserter: options.inserter,
		telemetry,
		pollIntervalMs: 5,
	});
	const server = http.createServer((incoming, outgoing) => {
		void (async () => {
			try {
				requestCount += 1;
				if (incoming.method !== "POST" || incoming.url !== "/archive") {
					outgoing.writeHead(404, { "content-type": "application/json" });
					outgoing.end('{"error":"Not found"}');
					return;
				}
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) {
					chunks.push(Buffer.from(chunk));
				}
				const body = Buffer.concat(chunks);
				try {
					batches.push(
						JSON.parse(body.toString("utf8")) as ArchiveBatchRequest,
					);
				} catch {
					// Invalid JSON remains the production handler's responsibility.
				}
				const request = new Request("http://127.0.0.1/archive", {
					method: "POST",
					headers: incoming.headers as HeadersInit,
					body,
				});
				const response = await handleArchiveRequest(request, {
					authToken: options.authToken,
					inserter: options.inserter,
					spool,
					telemetry,
				});
				const headers = Object.fromEntries(response.headers.entries());
				outgoing.writeHead(response.status, headers);
				outgoing.end(Buffer.from(await response.arrayBuffer()));
			} catch (error) {
				outgoing.writeHead(500, { "content-type": "application/json" });
				outgoing.end(
					JSON.stringify({
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		})();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("archive forwarder endpoint did not bind a TCP port");
	}
	return {
		url: `http://127.0.0.1:${address.port}/archive`,
		batches,
		get requestCount() {
			return requestCount;
		},
		strategySpoolStats: () => spool.stats(),
		waitForStrategyDrain: async () => {
			const deadline = Date.now() + 10_000;
			while (spool.stats().queuedWork > 0) {
				const result = await worker.drainOnce();
				if (result.terminal > 0) {
					throw new Error(
						"strategy spool reached terminal work during E2E drain",
					);
				}
				if (Date.now() >= deadline) {
					throw new Error("timed out waiting for strategy E2E spool drain");
				}
				if (result.completed === 0) await Bun.sleep(5);
			}
		},
		close: async () => {
			worker.stop();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			spool.close();
			if (spoolDirectory) {
				await rm(spoolDirectory, { recursive: true, force: true });
			}
		},
	};
}
