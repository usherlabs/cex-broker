import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Exchange } from "@usherlabs/ccxt";
import {
	BinanceSpotUserDataStream,
	setBinanceUserDataWebSocketFactoryForTests,
} from "../src/helpers/binance-user-data-stream";
import type { BrokerPoolEntry } from "../src/helpers/broker";
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
	readonly sent: string[] = [];
	closed = false;
	private readonly listeners: Record<
		"open" | "message" | "error" | "close",
		Array<(...args: unknown[]) => void>
	> = {
		open: [],
		message: [],
		error: [],
		close: [],
	};

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => this.emit("open"));
	}

	on(
		event: "open" | "message" | "error" | "close",
		listener: (...args: unknown[]) => void,
	) {
		this.listeners[event].push(listener);
		return this;
	}

	send(data: string) {
		this.sent.push(data);
		const request = JSON.parse(data) as { id: string };
		queueMicrotask(() => {
			this.emit(
				"message",
				Buffer.from(
					JSON.stringify({
						id: request.id,
						status: 200,
						result: { subscriptionId: FakeWebSocket.instances.length - 1 },
					}),
				),
			);
		});
	}

	close() {
		this.closed = true;
	}

	emitEvent(event: Record<string, unknown>) {
		this.emit(
			"message",
			Buffer.from(
				JSON.stringify({
					subscriptionId: FakeWebSocket.instances.indexOf(this),
					event,
				}),
			),
		);
	}

	emitError(error: unknown) {
		this.emit("error", error);
	}

	emitClose(code: number, reason: string | Buffer) {
		this.emit("close", code, reason);
	}

	private emit(
		event: "open" | "message" | "error" | "close",
		...args: unknown[]
	) {
		for (const listener of this.listeners[event]) {
			listener(...args);
		}
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

function getSubscribeError(response: { data: string }): string {
	const payload = JSON.parse(response.data) as { error?: unknown };
	expect(typeof payload.error).toBe("string");
	return payload.error as string;
}

describe("Binance Subscribe user-data streams", () => {
	const originalWebSocket = globalThis.WebSocket;
	let resetWebSocketFactory: (() => void) | undefined;
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	beforeEach(() => {
		resetWebSocketFactory = setBinanceUserDataWebSocketFactoryForTests(
			(url) => new FakeWebSocket(url),
		);
		(globalThis as { WebSocket?: typeof WebSocket }).WebSocket = undefined;
	});

	afterEach(async () => {
		resetWebSocketFactory?.();
		resetWebSocketFactory = undefined;
		globalThis.WebSocket = originalWebSocket;
		FakeWebSocket.instances = [];
		client?.close();
		if (server) {
			await server.forceShutdown();
		}
		server = undefined;
		client = undefined;
	});

	async function startClient(
		primaryExchange: Exchange,
		secondaryExchange: Exchange,
	) {
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
		return client;
	}

	test("closes Binance user-data stream when unread WebSocket events exceed the bounded buffer", async () => {
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const stream = new BinanceSpotUserDataStream(primary.exchange, {
			maxBufferedEvents: 1,
		});

		try {
			const iterator = stream[Symbol.asyncIterator]();
			const socket = await waitForSocket();
			socket.emitEvent({
				e: "outboundAccountPosition",
				E: 1,
				B: [{ a: "BTC", f: "1.0", l: "0.0" }],
			});
			socket.emitEvent({
				e: "outboundAccountPosition",
				E: 2,
				B: [{ a: "ETH", f: "2.0", l: "0.0" }],
			});

			let error: unknown;
			try {
				await iterator.next();
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				"Binance user-data stream buffered event limit exceeded (1)",
			);
			expect(socket.closed).toBe(true);
		} finally {
			stream.close();
		}
	});

	test("streams Binance BALANCE frames through WebSocket API user-data subscription", async () => {
		expect(globalThis.WebSocket).toBeUndefined();
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
		expect(globalThis.WebSocket).toBeUndefined();
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

	test("surfaces ws error event diagnostics without leaking signed params", async () => {
		expect(globalThis.WebSocket).toBeUndefined();
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const secondary = createBinanceExchange(
			"secondary-key",
			"secondary-secret",
		);
		const subscribeClient = await startClient(
			primary.exchange,
			secondary.exchange,
		);

		const responsePromise = subscribeOnce(subscribeClient, {
			cex: "binance",
			symbol: "BTC/USDT",
			type: SubscriptionType.BALANCE,
		});
		const socket = await waitForSocket();
		socket.emitError({
			error: new Error(
				"proxy refused event.error apiKey=primary-key secret=primary-secret signature=deadbeef",
			),
			message: "fallback transport message",
		});

		const error = getSubscribeError(await responsePromise);
		expect(error).toContain(
			"Binance user-data WebSocket error: proxy refused event.error",
		);
		expect(error).toContain("apiKey=[redacted]");
		expect(error).toContain("secret=[redacted]");
		expect(error).toContain("signature=[redacted]");
		expect(error).not.toContain("primary-key");
		expect(error).not.toContain("primary-secret");
		expect(error).not.toContain("deadbeef");
	});

	test("surfaces ws error message diagnostics without leaking secrets", async () => {
		expect(globalThis.WebSocket).toBeUndefined();
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const secondary = createBinanceExchange(
			"secondary-key",
			"secondary-secret",
		);
		const subscribeClient = await startClient(
			primary.exchange,
			secondary.exchange,
		);

		const responsePromise = subscribeOnce(subscribeClient, {
			cex: "binance",
			symbol: "BTC/USDT",
			type: SubscriptionType.BALANCE,
		});
		const socket = await waitForSocket();
		socket.emitError({
			message:
				"transport refused event.message apiKey=primary-key secret=primary-secret signature=feedface",
		});

		const error = getSubscribeError(await responsePromise);
		expect(error).toContain(
			"Binance user-data WebSocket error: transport refused event.message",
		);
		expect(error).toContain("apiKey=[redacted]");
		expect(error).toContain("secret=[redacted]");
		expect(error).toContain("signature=[redacted]");
		expect(error).not.toContain("primary-key");
		expect(error).not.toContain("primary-secret");
		expect(error).not.toContain("feedface");
	});

	test("surfaces abnormal ws close code and reason without leaking secrets", async () => {
		expect(globalThis.WebSocket).toBeUndefined();
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const secondary = createBinanceExchange(
			"secondary-key",
			"secondary-secret",
		);
		const subscribeClient = await startClient(
			primary.exchange,
			secondary.exchange,
		);

		const responsePromise = subscribeOnce(subscribeClient, {
			cex: "binance",
			symbol: "BTC/USDT",
			type: SubscriptionType.BALANCE,
		});
		const socket = await waitForSocket();
		socket.emitClose(
			1011,
			Buffer.from(
				"upstream closed apiKey=primary-key secret=primary-secret signature=abc123",
			),
		);

		const error = getSubscribeError(await responsePromise);
		expect(error).toContain("Binance user-data WebSocket closed unexpectedly");
		expect(error).toContain("code=1011");
		expect(error).toContain("reason=upstream closed");
		expect(error).toContain("apiKey=[redacted]");
		expect(error).toContain("secret=[redacted]");
		expect(error).toContain("signature=[redacted]");
		expect(error).not.toContain("primary-key");
		expect(error).not.toContain("primary-secret");
		expect(error).not.toContain("abc123");
	});
});
