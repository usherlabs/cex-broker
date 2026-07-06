import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Exchange } from "@usherlabs/ccxt";
import { Action } from "../src/helpers/constants";
import type { BrokerPoolEntry } from "../src/helpers/index";
import { PROTO_LOADER_OPTIONS } from "../src/proto-loader-options";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";

const packageDef = protoLoader.loadSync(
	"src/proto/node.proto",
	PROTO_LOADER_OPTIONS,
);
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

function createFetchExchange(): Exchange {
	return {
		fetchTotalBalance: async () => ({ USDT: 100 }),
		fetchBalance: async () => ({ USDT: { total: 100 } }),
		has: { fetchBalance: true },
	} as unknown as Exchange;
}

function createWriteExchange(): Exchange {
	return {
		loadMarkets: async () => undefined,
		currency: (code: string) => ({
			id: code,
			networks: { ETH: { id: "ETH" } },
		}),
		currencyToPrecision: (_code: string, amount: number) => String(amount),
		withdraw: async () => ({ id: "withdraw-1" }),
	} as unknown as Exchange;
}

function createPool(exchange: Exchange): Record<string, BrokerPoolEntry> {
	return {
		binance: {
			primary: { exchange, label: "primary" },
			secondaryBrokers: [],
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
): Promise<{
	error: grpc.ServiceError | null;
	response: { result: string } | null;
}> {
	return new Promise((resolve) => {
		client.ExecuteAction(request, (error, response) => {
			resolve({ error: error ?? null, response: response ?? null });
		});
	});
}

describe("execute-action broker surface RPC", () => {
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	afterEach(async () => {
		client?.close();
		if (server) {
			await server.forceShutdown();
			server = undefined;
		}
	});

	test("rejects fetch actions when read surface is disabled", async () => {
		server = getServer(
			testPolicy,
			createPool(createFetchExchange()),
			["*"],
			false,
			"",
			undefined,
			undefined,
			{ readEnabled: false, writeEnabled: true },
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		const { error } = await executeAction(client, {
			action: Action.FetchBalances,
			cex: "binance",
			symbol: "",
			payload: {},
		});

		expect(error?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(error?.message).toContain("Read operations are disabled");
	});

	test("allows fetch actions when read surface is enabled", async () => {
		server = getServer(
			testPolicy,
			createPool(createFetchExchange()),
			["*"],
			false,
			"",
			undefined,
			undefined,
			{ readEnabled: true, writeEnabled: false },
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		const { error, response } = await executeAction(client, {
			action: Action.FetchBalances,
			cex: "binance",
			symbol: "",
			payload: {},
		});

		expect(error).toBeNull();
		expect(JSON.parse(response?.result ?? "{}")).toMatchObject({
			balances: { USDT: 100 },
		});
	});

	test("rejects Withdraw when write surface is disabled", async () => {
		server = getServer(
			testPolicy,
			createPool(createWriteExchange()),
			["*"],
			false,
			"",
			undefined,
			undefined,
			{ readEnabled: true, writeEnabled: false },
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		const { error } = await executeAction(client, {
			action: Action.Withdraw,
			cex: "binance",
			symbol: "USDT",
			payload: {},
		});

		expect(error?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(error?.message).toContain("Write operations are disabled");
	});

	test("rejects CreateOrder when write surface is disabled", async () => {
		server = getServer(
			testPolicy,
			createPool(createWriteExchange()),
			["*"],
			false,
			"",
			undefined,
			undefined,
			{ readEnabled: true, writeEnabled: false },
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		const { error } = await executeAction(client, {
			action: Action.CreateOrder,
			cex: "binance",
			symbol: "USDT",
			payload: {},
		});

		expect(error?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(error?.message).toContain("Write operations are disabled");
	});

	test("rejects Action.Call createOrder when write surface is disabled", async () => {
		const exchange = {
			...createWriteExchange(),
			createOrder: async () => ({ id: "order-1" }),
			has: { createOrder: true },
		} as unknown as Exchange;
		server = getServer(
			testPolicy,
			createPool(exchange),
			["*"],
			false,
			"",
			undefined,
			undefined,
			{ readEnabled: true, writeEnabled: false },
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		const { error } = await executeAction(client, {
			action: Action.Call,
			cex: "binance",
			symbol: "BTC/USDT",
			payload: {
				functionName: "createOrder",
				args: '["BTC/USDT","limit","buy",1,100]',
			},
		});

		expect(error?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(error?.message).toContain("Write operations are disabled");
	});

	test("rejects other write actions when write surface is disabled", async () => {
		server = getServer(
			testPolicy,
			createPool(createWriteExchange()),
			["*"],
			false,
			"",
			undefined,
			undefined,
			{ readEnabled: true, writeEnabled: false },
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		for (const action of [Action.CancelOrder, Action.Deposit]) {
			const { error } = await executeAction(client, {
				action,
				cex: "binance",
				symbol: "USDT",
				payload: {},
			});
			expect(error?.code).toBe(grpc.status.FAILED_PRECONDITION);
			expect(error?.message).toContain("Write operations are disabled");
		}
	});

	test("rejects read CCXT Call methods when read surface is disabled", async () => {
		server = getServer(
			testPolicy,
			createPool(createFetchExchange()),
			["*"],
			false,
			"",
			undefined,
			undefined,
			{ readEnabled: false, writeEnabled: true },
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		const { error } = await executeAction(client, {
			action: Action.Call,
			cex: "binance",
			symbol: "",
			payload: {
				functionName: "fetchBalance",
				args: "[]",
			},
		});

		expect(error?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(error?.message).toContain("Read operations are disabled");
	});

	test("rejects write CCXT Call methods when write surface is disabled", async () => {
		server = getServer(
			testPolicy,
			createPool(createWriteExchange()),
			["*"],
			false,
			"",
			undefined,
			undefined,
			{ readEnabled: true, writeEnabled: false },
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		const { error } = await executeAction(client, {
			action: Action.Call,
			cex: "binance",
			symbol: "",
			payload: {
				functionName: "withdraw",
				args: "[]",
			},
		});

		expect(error?.code).toBe(grpc.status.FAILED_PRECONDITION);
		expect(error?.message).toContain("Write operations are disabled");
	});
});
