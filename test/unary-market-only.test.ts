import { expect, test } from "bun:test";
import { createServer } from "node:net";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "ccxt";
import type { BrokerPoolEntry } from "../src/helpers/broker";
import CEXBroker from "../src/index";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../src/proto-package-definition";
import type { PolicyConfig } from "../src/types";

type BrokerClient = grpc.Client & {
	ExecuteAction(
		request: Record<string, unknown>,
		callback: (
			error: grpc.ServiceError | null,
			response?: { result: string },
		) => void,
	): void;
	Subscribe(
		request: Record<string, unknown>,
	): grpc.ClientReadableStream<{ data: string }>;
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
const policy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};
const credentials = {
	mexc: {
		apiKey: "fixture-key",
		apiSecret: "fixture-secret",
		secondaryKeys: [],
	},
};
const environmentKeys = [
	"CEX_BROKER_ARCHIVE_ENABLED",
	"CEX_BROKER_ARCHIVE_FORWARDER_URL",
	"CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH",
	"CEX_BROKER_STREAM_HEALTH_STATE_PATH",
	"CEX_BROKER_DEPLOYMENT_ID",
	"CEX_BROKER_CAPTURE_BUNDLE_ID",
	"CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT",
	"CEX_BROKER_ARCHIVE_DEAD_LETTER_EXPORT_PATH",
] as const;
async function withoutArchiveEnvironment(
	run: () => Promise<void>,
): Promise<void> {
	const original = Object.fromEntries(
		environmentKeys.map((key) => [key, process.env[key]]),
	);
	try {
		for (const key of environmentKeys) delete process.env[key];
		await run();
	} finally {
		for (const key of environmentKeys) {
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
		}
	}
}
async function reservePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Test port not bound");
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

// Real gRPC registration and configured credentials; only venue IO is replaced.
// Pending watch requests are released on unwatch so teardown cannot leak a feed.
test.each([
	false,
	true,
])("unary-market-only binds credentialed gRPC without archive configuration (archive env=%s)", async (archiveRequested) => {
	await withoutArchiveEnvironment(async () => {
		if (archiveRequested) process.env.CEX_BROKER_ARCHIVE_ENABLED = "true";
		const broker = new CEXBroker(credentials, policy, {
			unaryMarketOnly: true,
		});
		const internals = broker as unknown as {
			brokers: Record<string, BrokerPoolEntry>;
			userDataStreamSupervisor?: unknown;
			depositReconciler?: unknown;
			fillArchivePoller?: unknown;
			depositArchivePoller?: unknown;
			accountBalanceArchivePoller?: unknown;
			userAssetArchivePoller?: unknown;
			brokerArchiver: { isEnabled(): boolean };
		};
		const exchange = internals.brokers.mexc?.primary.exchange;
		if (!exchange)
			throw new Error("Fixture must contain configured MEXC account");
		let watches = 0;
		let release: ((value: unknown) => void) | undefined;
		exchange.loadMarkets = (async () => ({
			"ETH/USDC": {
				symbol: "ETH/USDC",
				base: "ETH",
				quote: "USDC",
				spot: true,
				type: "spot",
			},
		})) as Exchange["loadMarkets"];
		exchange.markets = await exchange.loadMarkets();
		exchange.fetchTotalBalance = async () => ({ USDC: 7 });
		exchange.watchTicker = (() => {
			watches += 1;
			if (watches === 1)
				return Promise.resolve({ symbol: "ETH/USDC", last: 100 });
			return new Promise((resolve) => {
				release = resolve;
			});
		}) as Exchange["watchTicker"];
		exchange.unWatchTicker = (async () => {
			release?.({ symbol: "ETH/USDC", last: 100 });
		}) as Exchange["unWatchTicker"];
		broker.port = await reservePort();
		let client: BrokerClient | undefined;
		let market: grpc.ClientReadableStream<{ data: string }> | undefined;
		try {
			await broker.run();
			client = new grpcObject.cex_broker.cex_service(
				`127.0.0.1:${broker.port}`,
				grpc.credentials.createInsecure(),
			);
			await new Promise<void>((resolve, reject) =>
				client?.waitForReady(Date.now() + 3000, (error) =>
					error ? reject(error) : resolve(),
				),
			);
			expect(internals.userDataStreamSupervisor).toBeUndefined();
			expect(internals.depositReconciler).toBeUndefined();
			expect(internals.fillArchivePoller).toBeUndefined();
			expect(internals.depositArchivePoller).toBeUndefined();
			expect(internals.accountBalanceArchivePoller).toBeUndefined();
			expect(internals.userAssetArchivePoller).toBeUndefined();
			expect(internals.brokerArchiver.isEnabled()).toBe(false);
			const balances = await new Promise<{ result: string }>(
				(resolve, reject) =>
					client?.ExecuteAction(
						{ action: 6, cex: "mexc", payload: { balanceType: "total" } },
						(error, response) => {
							if (error) reject(error);
							else if (response) resolve(response);
							else reject(new Error("Missing unary reply"));
						},
					),
			);
			expect(JSON.parse(balances.result)).toEqual({
				balances: { USDC: 7 },
				balanceType: "total",
			});
			market = client.Subscribe({
				cex: "mexc",
				symbol: "ETH/USDC",
				type: "TICKER",
			});
			market.on("error", () => {});
			const frame = await new Promise<{ data: string }>((resolve, reject) => {
				market?.once("data", resolve);
				market?.once("error", reject);
			});
			expect(JSON.parse(frame.data)).toEqual({ symbol: "ETH/USDC", last: 100 });
			for (const type of ["BALANCE", "ORDERS"]) {
				const account = client.Subscribe({
					cex: "mexc",
					symbol: "ETH/USDC",
					type,
				});
				const error = await new Promise<grpc.ServiceError>((resolve) =>
					account.once("error", resolve),
				);
				expect(error.code).toBe(grpc.status.UNIMPLEMENTED);
				expect(error.details).toBe(
					"Account streams are disabled in unary-market-only mode",
				);
			}
		} finally {
			market?.cancel();
			client?.close();
			await broker.stop();
		}
	});
});

test.each([
	undefined,
	false,
])("default/full mode retains configured-account archive requirements (%s)", async (unaryMarketOnly) => {
	await withoutArchiveEnvironment(async () => {
		const broker = new CEXBroker(credentials, policy, { unaryMarketOnly });
		try {
			await expect(broker.run()).rejects.toThrow(
				"Configured account user streams require CEX_BROKER_ARCHIVE_ENABLED=true",
			);
		} finally {
			await broker.stop();
		}
	});
});

test("full mode retains archive constructor validation", async () => {
	await withoutArchiveEnvironment(async () => {
		process.env.CEX_BROKER_ARCHIVE_ENABLED = "true";
		expect(() => new CEXBroker(credentials, policy)).toThrow(
			"CEX_BROKER_ARCHIVE_FORWARDER_URL is missing",
		);
	});
});
