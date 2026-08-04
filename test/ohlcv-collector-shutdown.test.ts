import { expect, test } from "bun:test";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../src/proto-package-definition";

type SubscribeRequest = {
	cex: string;
	symbol: string;
	type: string;
	options: Record<string, string>;
};

type SubscribeCall = grpc.ServerWritableStream<SubscribeRequest, unknown>;

const grpcObject = grpc.loadPackageDefinition(
	CEX_BROKER_PACKAGE_DEFINITION,
) as unknown as {
	cex_broker: {
		cex_service: {
			service: grpc.ServiceDefinition<grpc.UntypedServiceImplementation>;
		};
	};
};

function bindServer(server: grpc.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.bindAsync(
			"127.0.0.1:0",
			grpc.ServerCredentials.createInsecure(),
			(error, port) => {
				if (error) reject(error);
				else resolve(port);
			},
		);
	});
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (condition()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for remote collector condition");
}

test("entrypoint cancels its remote subscription without stopping the broker", async () => {
	const requests: SubscribeRequest[] = [];
	const metadata: Array<Record<string, grpc.MetadataValue>> = [];
	let cancellations = 0;
	const server = new grpc.Server();
	server.addService(grpcObject.cex_broker.cex_service.service, {
		Subscribe(call: SubscribeCall) {
			requests.push(call.request);
			metadata.push(call.metadata.getMap());
			call.once("cancelled", () => {
				cancellations += 1;
			});
			call.write({
				data: JSON.stringify({ bid: 100, ask: 101 }),
				timestamp: Date.now(),
				symbol: call.request.symbol,
				type: call.request.type,
			});
		},
	});
	const port = await bindServer(server);
	const configPath = `/tmp/market-data-collector-${crypto.randomUUID()}.json`;
	await Bun.write(
		configPath,
		JSON.stringify({
			subscriptions: [
				{ exchange: "binance", symbol: "BTC/USDT", feed: "TICKER" },
			],
		}),
	);

	const child = Bun.spawn({
		cmd: [process.execPath, path.resolve("services/ohlcv-collector/index.ts")],
		cwd: process.cwd(),
		env: {
			...process.env,
			CEX_BROKER_URL: `127.0.0.1:${port}`,
			CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG: configPath,
			CEX_BROKER_OHLCV_COLLECTOR_CONFIG: "",
			OTEL_EXPORTER_OTLP_ENDPOINT: "",
			CEX_BROKER_OTEL_HOST: "",
			CEX_BROKER_CLICKHOUSE_HOST: "",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();

	try {
		await waitFor(() => requests.length === 1);
		expect(requests[0]).toEqual({
			cex: "binance",
			symbol: "BTC/USDT",
			type: "TICKER",
			options: {},
		});
		expect(metadata[0]?.["api-key"]).toBeUndefined();
		expect(metadata[0]?.["api-secret"]).toBeUndefined();

		child.kill("SIGTERM");
		const result = await Promise.race([
			child.exited.then((exitCode) => ({ exitCode })),
			Bun.sleep(5_000).then(() => null),
		]);
		if (!result) {
			child.kill("SIGKILL");
			await child.exited;
			throw new Error(
				`Collector did not exit within 5s\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
			);
		}
		expect(result.exitCode).toBe(0);
		await waitFor(() => cancellations === 1);

		// The independently owned broker is still bound after the collector exits.
		const probePort = await new Promise<number>((resolve, reject) => {
			server.bindAsync(
				"127.0.0.1:0",
				grpc.ServerCredentials.createInsecure(),
				(error, boundPort) => {
					if (error) reject(error);
					else resolve(boundPort);
				},
			);
		});
		expect(probePort).toBeGreaterThan(0);
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		server.forceShutdown();
		if (await Bun.file(configPath).exists()) {
			await Bun.file(configPath).delete();
		}
	}
});
