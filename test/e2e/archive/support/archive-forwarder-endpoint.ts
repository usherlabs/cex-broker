import http from "node:http";
import type { RowInserter } from "../../../../services/archive-forwarder/insert";
import { handleArchiveRequest } from "../../../../services/archive-forwarder/request";
import { ArchiveForwarderTelemetry } from "../../../../services/archive-forwarder/telemetry";
import type { ArchiveBatchRequest } from "../../../../services/archive-forwarder/types";
import type { ArchiveForwarderEndpoint } from "./archive-e2e-contracts";

export async function startArchiveForwarderEndpoint(options: {
	inserter: RowInserter;
	authToken?: string;
}): Promise<ArchiveForwarderEndpoint> {
	let requestCount = 0;
	const batches: ArchiveBatchRequest[] = [];
	const telemetry = new ArchiveForwarderTelemetry({
		recordCounter: () => {},
		setObservableGauge: () => {},
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
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
