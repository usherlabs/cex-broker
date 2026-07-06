import http from "node:http";

export type CapturedRequest = {
	method: string;
	headers: http.IncomingHttpHeaders;
	body: { source?: string; deployment_id?: string; rows?: unknown[] } & Record<
		string,
		unknown
	>;
};

export type ForwarderReply = { status?: number; destroy?: boolean };

export type ForwarderResponder = (
	req: CapturedRequest,
) => ForwarderReply | Promise<ForwarderReply>;

export type ForwarderServer = {
	url: string;
	requests: CapturedRequest[];
	close: () => Promise<void>;
};

/**
 * A real local HTTP forwarder for archive-writer tests. Exercises the production
 * node:http transport end to end (the enclave-safe path) instead of stubbing the
 * global fetch, which the writer no longer uses. The responder scripts the reply
 * per request: an HTTP `status`, or `destroy: true` to abort the socket and drive
 * the client's network-error path. Returning a Promise lets a test hold the
 * response in flight.
 */
export function startForwarderServer(
	responder: ForwarderResponder = () => ({ status: 200 }),
): Promise<ForwarderServer> {
	const requests: CapturedRequest[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk as Buffer));
		req.on("end", () => {
			void (async () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				const captured: CapturedRequest = {
					method: req.method ?? "",
					headers: req.headers,
					body: raw ? JSON.parse(raw) : {},
				};
				requests.push(captured);
				const { status = 200, destroy = false } = await responder(captured);
				if (destroy) {
					res.destroy();
					return;
				}
				res.writeHead(status, { "content-type": "application/json" });
				res.end("{}");
			})();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}/archive`,
				requests,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}
