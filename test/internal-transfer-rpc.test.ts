import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Exchange } from "@usherlabs/ccxt";
import type { BrokerPoolEntry } from "../src/helpers/index";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";

const packageDef = protoLoader.loadSync("src/proto/node.proto", {
	keepCase: true,
	longs: String,
	enums: String,
	defaults: true,
	oneofs: true,
});
const grpcObj = grpc.loadPackageDefinition(packageDef) as {
	cex_broker: {
		cex_service: new (
			address: string,
			credentials: grpc.ChannelCredentials,
		) => {
			ExecuteAction(
				request: Record<string, unknown>,
				callback: grpc.requestCallback<{ result: string; proof: string }>,
			): void;
			close(): void;
		};
	};
};

const testPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

function createMockExchange(enabledMethods: string[]) {
	const calls: Record<string, unknown[]> = {};
	const exchange: Record<string, unknown> = {
		loadMarkets: async () => undefined,
		currency: (code: string) => ({ id: code }),
		currencyToPrecision: (_code: string, amount: number) => String(amount),
	};
	for (const method of enabledMethods) {
		calls[method] = [];
		exchange[method] = async (params: Record<string, unknown>) => {
			calls[method].push(params);
			return { txnId: `${method}-ok` };
		};
	}
	return { exchange: exchange as Exchange, calls };
}

function createBinancePool(
	primaryExchange: Exchange,
	secondaryExchange: Exchange,
	destEmail?: string,
): Record<string, BrokerPoolEntry> {
	return {
		binance: {
			primary: { exchange: primaryExchange, label: "primary" },
			secondaryBrokers: [
				{ exchange: secondaryExchange, label: "secondary:1", index: 1 },
				{
					exchange: secondaryExchange,
					label: "secondary:2",
					index: 2,
					email: destEmail,
				},
			],
		},
	};
}

function bindServer(server: grpc.Server) {
	return new Promise<number>((resolve, reject) => {
		server.bindAsync(
			"127.0.0.1:0",
			grpc.ServerCredentials.createInsecure(),
			(error, port) => {
				if (error) {
					reject(error);
					return;
				}
				server.start();
				resolve(port);
			},
		);
	});
}

function executeAction(
	client: InstanceType<typeof grpcObj.cex_broker.cex_service>,
	request: Record<string, unknown>,
) {
	return new Promise<{ result: string; proof: string }>((resolve, reject) => {
		client.ExecuteAction(request, (error, response) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(response as { result: string; proof: string });
		});
	});
}

describe("InternalTransfer RPC", () => {
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	afterEach(async () => {
		client?.close();
		if (server) {
			await server.forceShutdown();
		}
	});

	test("returns FAILED_PRECONDITION when sub→sub dest email is missing", async () => {
		const { exchange: primaryExchange } = createMockExchange([]);
		const { exchange: secondaryExchange } = createMockExchange([
			"sapiPostSubAccountTransferSubToSub",
		]);
		server = getServer(
			testPolicy,
			createBinancePool(primaryExchange, secondaryExchange),
			["*"],
			false,
			"",
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		await expect(
			executeAction(client, {
				action: 13,
				cex: "binance",
				symbol: "USDT",
				payload: {
					amount: "1",
					fromAccount: "secondary:1",
					toAccount: "secondary:2",
				},
			}),
		).rejects.toMatchObject({
			code: grpc.status.FAILED_PRECONDITION,
			details:
				"Destination account 'secondary:2' requires an email configured for sub-to-sub transfers",
		});
	});

	test("allows default sub→master transfer without a dest email", async () => {
		const { exchange: primaryExchange } = createMockExchange([]);
		const { exchange: secondaryExchange, calls } = createMockExchange([
			"sapiPostSubAccountTransferSubToMaster",
		]);
		server = getServer(
			testPolicy,
			createBinancePool(primaryExchange, secondaryExchange),
			["*"],
			false,
			"",
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		const response = await executeAction(client, {
			action: 13,
			cex: "binance",
			symbol: "USDT",
			payload: {
				amount: "1.25",
				fromAccount: "secondary:1",
			},
		});

		expect(JSON.parse(response.result)).toMatchObject({
			txnId: "sapiPostSubAccountTransferSubToMaster-ok",
		});
		expect(calls.sapiPostSubAccountTransferSubToMaster).toHaveLength(1);
		expect(calls.sapiPostSubAccountTransferSubToMaster[0]).toMatchObject({
			asset: "USDT",
			amount: "1.25",
		});
	});
});
