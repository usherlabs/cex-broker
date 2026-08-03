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
				if (error) {
					reject(error);
					return;
				}
				resolve(port);
			},
		);
	});
}

async function startSubscribeServer(
	onSubscribe: (call: SubscribeCall) => void,
): Promise<{ server: grpc.Server; port: number }> {
	const server = new grpc.Server();
	server.addService(grpcObject.cex_broker.cex_service.service, {
		Subscribe: onSubscribe,
	});
	return { server, port: await bindServer(server) };
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (condition()) {
			return;
		}
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for market-data collector condition");
}

async function runShutdownCase(): Promise<{
	exitCode: number;
	requests: SubscribeRequest[];
	cancelledCount: number;
	output: string;
}> {
	const fixtureId = crypto.randomUUID();
	const configPath = `/tmp/market-data-collector-${fixtureId}.json`;
	const requests: SubscribeRequest[] = [];
	const cancelled = new Set<string>();
	const { server, port } = await startSubscribeServer((call) => {
		requests.push(call.request);
		const requestKey = `${call.request.type}:${call.request.symbol}`;
		call.once("cancelled", () => cancelled.add(requestKey));
		call.write({
			data:
				call.request.type === "OHLCV"
					? JSON.stringify([1_700_000_000_000, 1, 2, 0.5, 1.5, 10])
					: JSON.stringify({ ok: true }),
			timestamp: Date.now(),
			symbol: call.request.symbol,
			type: call.request.type,
		});
	});
	await Bun.write(
		configPath,
		JSON.stringify({
			subscriptions: [
				{
					exchange: "binance",
					symbol: "BTC/USDT",
					feed: "ORDERBOOK",
					depthLimit: 25,
				},
				{ exchange: "binance", symbol: "BTC/USDT", feed: "TICKER" },
				{ exchange: "binance", symbol: "BTC/USDT", feed: "TRADES" },
				{
					exchange: "binance",
					symbol: "BTC/USDT",
					feed: "OHLCV",
					timeframe: "1m",
					bootstrapLimit: 100,
				},
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
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();

	try {
		await waitFor(() => requests.length === 4);
		expect(requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "ORDERBOOK",
					options: { depthLimit: "25" },
				}),
				expect.objectContaining({ type: "TICKER", options: {} }),
				expect.objectContaining({ type: "TRADES", options: {} }),
				expect.objectContaining({
					type: "OHLCV",
					options: { timeframe: "1m", bootstrapLimit: "100" },
				}),
			]),
		);

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

		await waitFor(() => cancelled.size === 4);
		return {
			exitCode: result.exitCode,
			requests,
			cancelledCount: cancelled.size,
			output: `${await stdout}\n${await stderr}`,
		};
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
}

test("entrypoint connects to an external broker for all four feeds and stops cleanly on SIGTERM", async () => {
	const result = await runShutdownCase();

	expect(result.exitCode).toBe(0);
	expect(result.requests).toHaveLength(4);
	expect(result.cancelledCount).toBe(4);
	expect(result.output).toContain("Market-data collector service stopped");
});
