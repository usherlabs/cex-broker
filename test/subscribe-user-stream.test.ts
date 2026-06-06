import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Exchange } from "@usherlabs/ccxt";
import type { BrokerPoolEntry } from "../src/helpers";
import { SubscriptionType } from "../src/helpers/constants";
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
			Subscribe(
				request: Record<string, unknown>,
				metadata?: grpc.Metadata,
			): grpc.ClientReadableStream<{
				data: string;
				timestamp: number;
				symbol: string;
				type: string;
			}>;
			close(): void;
		};
	};
};

const testPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;
	readonly sent: string[] = [];
	closed = false;

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => this.onopen?.({}));
	}

	send(data: string) {
		this.sent.push(data);
		const request = JSON.parse(data) as { id: string };
		queueMicrotask(() => {
			this.onmessage?.({
				data: JSON.stringify({
					id: request.id,
					status: 200,
					result: { subscriptionId: FakeWebSocket.instances.length - 1 },
				}),
			});
		});
	}

	close() {
		this.closed = true;
	}

	emitEvent(event: Record<string, unknown>) {
		this.onmessage?.({
			data: JSON.stringify({
				subscriptionId: FakeWebSocket.instances.indexOf(this),
				event,
			}),
		});
	}
}

function createBinanceExchange(apiKey: string, secret: string) {
	const calls = {
		watchBalance: 0,
		watchOrders: 0,
		loadMarkets: 0,
	};
	const exchange = {
		apiKey,
		secret,
		urls: {
			api: {
				ws: {
					"ws-api": {
						spot: "wss://ws-api.binance.com:443/ws-api/v3",
					},
				},
			},
		},
		loadMarkets: async () => {
			calls.loadMarkets += 1;
		},
		market: (symbol: string) => ({
			id: symbol.replace("/", "").toUpperCase(),
			symbol,
		}),
		watchBalance: async () => {
			calls.watchBalance += 1;
			throw new Error("legacy watchBalance should not be called");
		},
		watchOrders: async () => {
			calls.watchOrders += 1;
			throw new Error("legacy watchOrders should not be called");
		},
	} as unknown as Exchange;
	return { exchange, calls };
}

function createBinancePool(
	primaryExchange: Exchange,
	secondaryExchange: Exchange,
): Record<string, BrokerPoolEntry> {
	return {
		binance: {
			primary: { exchange: primaryExchange, label: "primary" },
			secondaryBrokers: [
				{ exchange: secondaryExchange, label: "secondary:1", index: 1 },
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

async function waitForSocket(): Promise<FakeWebSocket> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const socket = FakeWebSocket.instances.at(-1);
		if (socket?.sent.length) {
			return socket;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Fake Binance WebSocket was not opened");
}

function subscribeOnce(
	client: InstanceType<typeof grpcObj.cex_broker.cex_service>,
	request: Record<string, unknown>,
	metadata?: grpc.Metadata,
) {
	return new Promise<{
		data: string;
		timestamp: number;
		symbol: string;
		type: string;
	}>((resolve, reject) => {
		const stream = client.Subscribe(request, metadata);
		stream.once("data", (response) => {
			stream.cancel();
			resolve(response);
		});
		stream.once("error", (error) => {
			if ((error as grpc.ServiceError).code === grpc.status.CANCELLED) {
				return;
			}
			reject(error);
		});
	});
}

describe("Binance Subscribe user-data streams", () => {
	const originalWebSocket = globalThis.WebSocket;
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	afterEach(async () => {
		globalThis.WebSocket = originalWebSocket;
		FakeWebSocket.instances = [];
		client?.close();
		if (server) {
			await server.forceShutdown();
		}
		server = undefined;
		client = undefined;
	});

	test("streams Binance BALANCE frames through WebSocket API user-data subscription", async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const secondary = createBinanceExchange(
			"secondary-key",
			"secondary-secret",
		);
		server = getServer(
			testPolicy,
			createBinancePool(primary.exchange, secondary.exchange),
			["*"],
			false,
			"",
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);

		const responsePromise = subscribeOnce(client, {
			cex: "BINANCE",
			symbol: "BTC/USDT",
			type: SubscriptionType.BALANCE,
		});
		const socket = await waitForSocket();
		const subscribeRequest = JSON.parse(socket.sent[0] ?? "{}") as {
			method?: string;
			params?: { apiKey?: string };
		};
		socket.emitEvent({
			e: "outboundAccountPosition",
			E: 1_564_031_571_105,
			B: [{ a: "BTC", f: "1.0", l: "0.2" }],
		});

		const response = await responsePromise;
		expect(subscribeRequest.method).toBe("userDataStream.subscribe.signature");
		expect(subscribeRequest.params?.apiKey).toBe("primary-key");
		expect(JSON.parse(response.data)).toMatchObject({
			subscriptionId: 0,
			event: { e: "outboundAccountPosition" },
		});
		expect(response.symbol).toBe("BTC/USDT");
		expect(response.type).toBe("BALANCE");
		expect(primary.calls.watchBalance).toBe(0);
		expect(primary.calls.watchOrders).toBe(0);
	});

	test("streams Binance ORDERS frames for the selected secondary account", async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const secondary = createBinanceExchange(
			"secondary-key",
			"secondary-secret",
		);
		server = getServer(
			testPolicy,
			createBinancePool(primary.exchange, secondary.exchange),
			["*"],
			false,
			"",
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);
		const metadata = new grpc.Metadata();
		metadata.set("use-secondary-key", "1");

		const responsePromise = subscribeOnce(
			client,
			{
				cex: "binance",
				symbol: "BTC/USDT",
				type: SubscriptionType.ORDERS,
			},
			metadata,
		);
		const socket = await waitForSocket();
		const subscribeRequest = JSON.parse(socket.sent[0] ?? "{}") as {
			method?: string;
			params?: { apiKey?: string };
		};
		socket.emitEvent({
			e: "executionReport",
			E: 1_499_405_658_658,
			s: "ETHUSDT",
			i: 1,
		});
		socket.emitEvent({
			e: "executionReport",
			E: 1_499_405_658_659,
			s: "BTCUSDT",
			i: 2,
		});

		const response = await responsePromise;
		expect(subscribeRequest.method).toBe("userDataStream.subscribe.signature");
		expect(subscribeRequest.params?.apiKey).toBe("secondary-key");
		expect(JSON.parse(response.data)).toMatchObject({
			subscriptionId: 0,
			event: { e: "executionReport", s: "BTCUSDT", i: 2 },
		});
		expect(response.type).toBe("ORDERS");
		expect(primary.calls.watchOrders).toBe(0);
		expect(secondary.calls.watchOrders).toBe(0);
		expect(secondary.calls.loadMarkets).toBe(1);
	});
});
