import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { TRACE_METADATA_KEY } from "../src/helpers/trace-context";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../src/proto-package-definition";

type BrokerClient = grpc.Client & {
	ExecuteAction(
		request: Record<string, unknown>,
		callback: (error: grpc.ServiceError | null, response?: unknown) => void,
	): void;
	ExecuteAction(
		request: Record<string, unknown>,
		metadata: grpc.Metadata,
		callback: (error: grpc.ServiceError | null, response?: unknown) => void,
	): void;
};

const grpcObject = grpc.loadPackageDefinition(
	CEX_BROKER_PACKAGE_DEFINITION,
) as unknown as {
	cex_broker: {
		cex_service: new (
			address: string,
			credentials: grpc.ChannelCredentials,
		) => BrokerClient;
	};
};

async function listen(
	server: ReturnType<typeof createServer>,
): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Test server did not bind to a TCP port");
	}
	return address.port;
}

async function reservePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	return port;
}

function waitForReady(client: grpc.Client): Promise<void> {
	return new Promise((resolve, reject) => {
		client.waitForReady(Date.now() + 5_000, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

test("standalone CLI flushes operational metrics and exits cleanly on repeated signals", async () => {
	const sockets = new Set<Socket>();
	const requestChunks: Uint8Array[] = [];
	const collector = createServer((socket) => {
		sockets.add(socket);
		socket.on("data", (chunk) => requestChunks.push(new Uint8Array(chunk)));
		socket.once("close", () => sockets.delete(socket));
	});
	const collectorPort = await listen(collector);
	const brokerPort = await reservePort();
	const childEnvironment = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith("CEX_BROKER_") && !key.startsWith("OTEL_EXPORTER_OTLP"),
		),
	) as Record<string, string>;
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			path.resolve("src/cli.ts"),
			"--policy",
			path.resolve("policy/policy.json"),
			"--port",
			String(brokerPort),
			"--whitelistAll",
		],
		cwd: process.cwd(),
		env: {
			...childEnvironment,
			NODE_ENV: "production",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
			OTEL_SERVICE_NAME: "cli-shutdown-test",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	let client: BrokerClient | undefined;

	try {
		client = new grpcObject.cex_broker.cex_service(
			`127.0.0.1:${brokerPort}`,
			grpc.credentials.createInsecure(),
		);
		await waitForReady(client);
		const rpcError = await new Promise<grpc.ServiceError | null>((resolve) => {
			client?.ExecuteAction({}, (error) => resolve(error));
		});
		expect(rpcError?.code).toBe(grpc.status.INVALID_ARGUMENT);

		const started = performance.now();
		child.kill("SIGTERM");
		await Bun.sleep(25);
		child.kill("SIGINT");
		const result = await Promise.race([
			child.exited.then((exitCode) => ({ exitCode })),
			Bun.sleep(4_500).then(() => null),
		]);
		if (!result) {
			child.kill("SIGKILL");
			await child.exited;
			throw new Error(
				`CLI did not exit within 4.5s\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
			);
		}
		const elapsedMs = performance.now() - started;
		const output = `${await stdout}\n${await stderr}`;
		const requests = Buffer.concat(requestChunks).toString("utf8");

		expect(result.exitCode).toBe(0);
		expect(elapsedMs).toBeLessThan(4_500);
		expect(requests).toContain("POST /v1/metrics");
		expect(requests).toContain("POST /v1/logs");
		expect(requests).toContain("CEXBroker graceful shutdown requested");
		expect(requests).toContain("signal");
		expect(requests).toContain("SIGTERM");
		expect(output).toContain("CEXBroker graceful shutdown requested");
		expect(output).toContain("CEXBroker graceful shutdown complete");
	} finally {
		client?.close();
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => collector.close(() => resolve()));
	}
}, 10_000);

test("standalone CLI exports correlated ExecuteAction logs without adding trace_id to metrics", async () => {
	const traceId = "0123456789abcdef0123456789abcdef";
	const requests = {
		logs: [] as Uint8Array[],
		metrics: [] as Uint8Array[],
	};
	const collector = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = new Uint8Array(await request.arrayBuffer());
			if (request.method === "POST" && url.pathname === "/v1/logs") {
				requests.logs.push(body);
				return new Response(null, { status: 200 });
			}
			if (request.method === "POST" && url.pathname === "/v1/metrics") {
				requests.metrics.push(body);
				return new Response(null, { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		},
	});
	const brokerPort = await reservePort();
	const childEnvironment = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith("CEX_BROKER_") && !key.startsWith("OTEL_EXPORTER_OTLP"),
		),
	) as Record<string, string>;
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			path.resolve("src/cli.ts"),
			"--policy",
			path.resolve("policy/policy.json"),
			"--port",
			String(brokerPort),
			"--whitelistAll",
		],
		cwd: process.cwd(),
		env: {
			...childEnvironment,
			NODE_ENV: "production",
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
			OTEL_SERVICE_NAME: "cli-trace-correlation-test",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	let client: BrokerClient | undefined;

	try {
		client = new grpcObject.cex_broker.cex_service(
			`127.0.0.1:${brokerPort}`,
			grpc.credentials.createInsecure(),
		);
		await waitForReady(client);
		const metadata = new grpc.Metadata();
		metadata.set(TRACE_METADATA_KEY, traceId);
		const rpcError = await new Promise<grpc.ServiceError | null>((resolve) => {
			client?.ExecuteAction({}, metadata, (error) => resolve(error));
		});
		expect(rpcError?.code).toBe(grpc.status.INVALID_ARGUMENT);

		const started = performance.now();
		child.kill("SIGTERM");
		const result = await Promise.race([
			child.exited.then((exitCode) => ({ exitCode })),
			Bun.sleep(4_500).then(() => null),
		]);
		if (!result) {
			child.kill("SIGKILL");
			await child.exited;
			throw new Error(
				`CLI did not exit within 4.5s\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
			);
		}
		const elapsedMs = performance.now() - started;
		const logsPayload = Buffer.concat(requests.logs).toString("utf8");
		const metricsPayload = Buffer.concat(requests.metrics).toString("utf8");

		expect(result.exitCode).toBe(0);
		expect(elapsedMs).toBeLessThan(4_500);
		expect(requests.logs.some((body) => body.byteLength > 0)).toBe(true);
		expect(requests.metrics.some((body) => body.byteLength > 0)).toBe(true);
		expect(logsPayload).toContain(traceId);
		expect(logsPayload).toContain("ExecuteAction failed");
		expect(logsPayload).toContain("INVALID_ARGUMENT");
		expect(logsPayload).toContain('"key":"trace_id"');
		expect(logsPayload).toContain('"key":"grpc_status"');
		expect(logsPayload).not.toContain("ExecuteAction started [object Object]");
		expect(logsPayload).not.toContain("ExecuteAction failed [object Object]");
		expect(metricsPayload).not.toContain(traceId);
	} finally {
		client?.close();
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		collector.stop();
	}
}, 20_000);
