import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Exchange } from "@usherlabs/ccxt";
import type { BrokerExecutionArchiver } from "../src/helpers/broker-execution-archive";
import type { BrokerArchiveRow } from "../src/helpers/broker-execution-archive/types";
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
		this.emitMessage({
			subscriptionId: FakeWebSocket.instances.indexOf(this),
			event,
		});
	}

	emitMessage(message: unknown) {
		this.emit("message", Buffer.from(JSON.stringify(message)));
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

function createBinanceExchange(
	apiKey: string,
	secret: string,
	options: { balance?: unknown } = {},
) {
	const calls = {
		watchBalance: 0,
		watchOrders: 0,
		loadMarkets: 0,
		market: [] as string[],
		fetchBalance: [] as Array<{ type: string }>,
		parseWsOrder: [] as Array<Record<string, unknown>>,
		safeBalance: [] as Array<Record<string, unknown>>,
	};
	const marketsById = new Map<string, { id: string; symbol: string }>();
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
		market: (symbol: string) => {
			calls.market.push(symbol);
			const market = {
				id: symbol.replace("/", "").toUpperCase(),
				symbol,
			};
			marketsById.set(market.id, market);
			return market;
		},
		fetchBalance: async (params: { type: string }) => {
			calls.fetchBalance.push(params);
			if (params.type !== "spot") {
				throw new Error(`unexpected balance type: ${params.type}`);
			}
			return (
				options.balance ?? {
					free: { BTC: 3 },
					total: { BTC: 4 },
				}
			);
		},
		parseWsOrder: (event: Record<string, unknown>) => {
			calls.parseWsOrder.push(event);
			if (event.e !== "executionReport") {
				throw new Error(`unexpected order event: ${String(event.e)}`);
			}
			const market = marketsById.get(String(event.s));
			if (!market) {
				throw new Error(`market was not loaded: ${String(event.s)}`);
			}
			const amount = Number(event.q);
			const filled = Number(event.z);
			const cost = Number(event.Z);
			const average = filled > 0 ? cost / filled : undefined;
			const orderPrice = Number(event.p);
			const commission = Number(event.n);
			return {
				id: String(event.i),
				clientOrderId: String(event.c),
				status:
					event.X === "FILLED"
						? "closed"
						: event.X === "CANCELED"
							? "canceled"
							: "open",
				symbol: market.symbol,
				amount,
				filled,
				price: orderPrice > 0 ? orderPrice : average,
				timestamp: Number(event.O ?? event.T),
				...(commission > 0 && {
					fee: { cost: commission, currency: String(event.N) },
					fees: [{ cost: commission, currency: String(event.N) }],
				}),
			};
		},
		safeBalance: (balance: Record<string, unknown>) => {
			calls.safeBalance.push(balance);
			const result: Record<string, unknown> = {
				...balance,
				free: {},
				used: {},
				total: {},
			};
			for (const [asset, value] of Object.entries(balance)) {
				if (["info", "timestamp", "datetime"].includes(asset)) continue;
				const account = value as { free: string; used: string };
				const free = Number(account.free);
				const used = Number(account.used);
				const normalized = { free, used, total: free + used };
				result[asset] = normalized;
				(result.free as Record<string, number>)[asset] = free;
				(result.used as Record<string, number>)[asset] = used;
				(result.total as Record<string, number>)[asset] = normalized.total;
			}
			return result;
		},
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

function createRecordingArchiver() {
	const rows: BrokerArchiveRow[] = [];
	const archiver = {
		isEnabled: () => true,
		getDeploymentId: () => "test-deployment",
		getSource: () => "broker_read" as const,
		enqueue: (row: BrokerArchiveRow) => rows.push(row),
	} as unknown as BrokerExecutionArchiver;
	return { archiver, rows };
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

async function waitFor(
	condition: () => boolean,
	{
		timeoutMs = 2_000,
		intervalMs = 10,
	}: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	if (condition()) return;
	throw new Error(`Timed out waiting for test condition after ${timeoutMs}ms`);
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
		brokerArchiver?: BrokerExecutionArchiver,
	) {
		server = getServer(
			testPolicy,
			createBinancePool(primaryExchange, secondaryExchange),
			["*"],
			false,
			"",
			undefined,
			brokerArchiver,
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

	test("sends a Binance-compatible user-data request id", async () => {
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const stream = new BinanceSpotUserDataStream(primary.exchange);

		try {
			const socket = await waitForSocket();
			const request = JSON.parse(socket.sent[0] ?? "{}") as { id?: string };

			expect(request.id).toMatch(/^[a-zA-Z0-9-_]{1,36}$/);
		} finally {
			stream.close();
		}
	});

	test("uses different request ids for concurrent Binance user-data streams", async () => {
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const firstStream = new BinanceSpotUserDataStream(primary.exchange);
		const secondStream = new BinanceSpotUserDataStream(primary.exchange);

		try {
			await waitForSocket();
			const requestIds = FakeWebSocket.instances.map((socket) => {
				const request = JSON.parse(socket.sent[0] ?? "{}") as { id?: string };
				return request.id;
			});

			expect(requestIds).toHaveLength(2);
			expect(requestIds[0]).not.toBe(requestIds[1]);
		} finally {
			firstStream.close();
			secondStream.close();
		}
	});

	test("surfaces unmatched Binance user-data request errors", async () => {
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const stream = new BinanceSpotUserDataStream(primary.exchange);

		try {
			const iterator = stream[Symbol.asyncIterator]();
			const nextEvent = iterator.next();
			const socket = await waitForSocket();
			socket.emitMessage({
				id: null,
				status: 400,
				error: {
					code: -1135,
					msg: "Invalid 'id' in JSON request",
				},
			});

			let error: unknown;
			try {
				await nextEvent;
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				"Invalid 'id' in JSON request",
			);
			expect((error as Error).message).toContain("code -1135");
			expect((error as Error).message).not.toContain("closed unexpectedly");
		} finally {
			stream.close();
		}
	});

	test("normalizes outboundAccountPosition as a canonical balance snapshot and archives the raw event", async () => {
		expect(globalThis.WebSocket).toBeUndefined();
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const secondary = createBinanceExchange(
			"secondary-key",
			"secondary-secret",
		);
		const archive = createRecordingArchiver();
		const subscribeClient = await startClient(
			primary.exchange,
			secondary.exchange,
			archive.archiver,
		);

		const responsePromise = subscribeOnce(subscribeClient, {
			cex: "BINANCE",
			symbol: "BTC/USDT",
			type: SubscriptionType.BALANCE,
		});
		const socket = await waitForSocket();
		const subscribeRequest = JSON.parse(socket.sent[0] ?? "{}") as {
			method?: string;
			params?: { apiKey?: string };
		};
		const rawEvent = {
			e: "outboundAccountPosition",
			E: 1_564_031_571_105,
			B: [
				{ a: "BTC", f: "1.0", l: "0.2" },
				{ a: "USDT", f: "25.5", l: "4.5" },
			],
		};
		socket.emitEvent(rawEvent);

		const response = await responsePromise;
		expect(subscribeRequest.method).toBe("userDataStream.subscribe.signature");
		expect(subscribeRequest.params?.apiKey).toBe("primary-key");
		expect(JSON.parse(response.data)).toEqual({
			info: rawEvent,
			timestamp: rawEvent.E,
			datetime: new Date(rawEvent.E).toISOString(),
			BTC: { free: 1, used: 0.2, total: 1.2 },
			USDT: { free: 25.5, used: 4.5, total: 30 },
			free: { BTC: 1, USDT: 25.5 },
			used: { BTC: 0.2, USDT: 4.5 },
			total: { BTC: 1.2, USDT: 30 },
		});
		expect(response.symbol).toBe("BTC/USDT");
		expect(response.type).toBe("BALANCE");
		expect(primary.calls.safeBalance).toEqual([
			{
				info: rawEvent,
				timestamp: rawEvent.E,
				datetime: new Date(rawEvent.E).toISOString(),
				BTC: { free: "1.0", used: "0.2" },
				USDT: { free: "25.5", used: "4.5" },
			},
		]);
		expect(primary.calls.fetchBalance).toEqual([]);
		expect(primary.calls.watchBalance).toBe(0);
		expect(primary.calls.watchOrders).toBe(0);

		await waitFor(() => archive.rows.length >= 2);
		expect(archive.rows).toHaveLength(2);
		for (const table of [
			"broker_execution.order_events",
			"market_data.cex_stream_events",
		]) {
			expect(
				archive.rows
					.filter((row) => row.table === table)
					.map((row) => JSON.parse(String(row.row.payload_json))),
			).toEqual([rawEvent]);
		}
	});

	test("refreshes the authoritative primary balance for balanceUpdate", async () => {
		const authoritativeBalance = {
			free: { BTC: 2.5, USDT: 10 },
			total: { BTC: 3, USDT: 12 },
		};
		const primary = createBinanceExchange("primary-key", "primary-secret", {
			balance: authoritativeBalance,
		});
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
		socket.emitEvent({
			e: "balanceUpdate",
			E: 1_700_000_000_000,
			a: "BTC",
			d: "0.5",
			T: 1_700_000_000_001,
		});

		expect(JSON.parse((await responsePromise).data)).toEqual(
			authoritativeBalance,
		);
		expect(primary.calls.fetchBalance).toEqual([{ type: "spot" }]);
		expect(secondary.calls.fetchBalance).toEqual([]);
		expect(primary.calls.safeBalance).toEqual([]);
	});

	test("refreshes externalLockUpdate through the selected secondary account", async () => {
		const secondaryBalance = {
			free: { BTC: 7 },
			total: { BTC: 8 },
		};
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const secondary = createBinanceExchange(
			"secondary-key",
			"secondary-secret",
			{ balance: secondaryBalance },
		);
		const subscribeClient = await startClient(
			primary.exchange,
			secondary.exchange,
		);
		const metadata = new grpc.Metadata();
		metadata.set("use-secondary-key", "1");
		const responsePromise = subscribeOnce(
			subscribeClient,
			{
				cex: "binance",
				symbol: "BTC/USDT",
				type: SubscriptionType.BALANCE,
			},
			metadata,
		);

		const socket = await waitForSocket();
		socket.emitEvent({
			e: "externalLockUpdate",
			E: 1_700_000_000_010,
			a: "BTC",
			d: "1.0",
			T: 1_700_000_000_011,
		});

		expect(JSON.parse((await responsePromise).data)).toEqual(secondaryBalance);
		expect(primary.calls.fetchBalance).toEqual([]);
		expect(secondary.calls.fetchBalance).toEqual([{ type: "spot" }]);
	});

	test("normalizes executionReport for the selected account and requested market", async () => {
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
		const metadata = new grpc.Metadata();
		metadata.set("use-secondary-key", "1");

		const responsePromise = subscribeOnce(
			subscribeClient,
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
		const rawEvent = {
			e: "executionReport",
			E: 1_499_405_658_659,
			s: "BTCUSDT",
			i: 2,
			c: "client-2",
			X: "FILLED",
			q: "2.0",
			z: "2.0",
			p: "0",
			Z: "202.5",
			O: 1_499_405_658_600,
			T: 1_499_405_658_659,
			t: 77,
			n: "0.01",
			N: "BNB",
		};
		socket.emitEvent(rawEvent);

		const response = await responsePromise;
		expect(subscribeRequest.method).toBe("userDataStream.subscribe.signature");
		expect(subscribeRequest.params?.apiKey).toBe("secondary-key");
		expect(JSON.parse(response.data)).toEqual({
			id: "2",
			clientOrderId: "client-2",
			status: "closed",
			symbol: "BTC/USDT",
			amount: 2,
			filled: 2,
			price: 101.25,
			timestamp: 1_499_405_658_600,
			tradeId: "77",
		});
		expect(response.type).toBe("ORDERS");
		expect(primary.calls.watchOrders).toBe(0);
		expect(secondary.calls.watchOrders).toBe(0);
		expect(secondary.calls.loadMarkets).toBe(1);
		expect(secondary.calls.market).toEqual(["BTC/USDT"]);
		expect(secondary.calls.parseWsOrder).toEqual([rawEvent]);
	});

	test("archives listStatus without emitting it and continues to the next executionReport", async () => {
		const primary = createBinanceExchange("primary-key", "primary-secret");
		const secondary = createBinanceExchange(
			"secondary-key",
			"secondary-secret",
		);
		const archive = createRecordingArchiver();
		const subscribeClient = await startClient(
			primary.exchange,
			secondary.exchange,
			archive.archiver,
		);
		const responsePromise = subscribeOnce(subscribeClient, {
			cex: "binance",
			symbol: "BTC/USDT",
			type: SubscriptionType.ORDERS,
		});
		const socket = await waitForSocket();
		const listStatus = {
			e: "listStatus",
			E: 1_700_000_000_100,
			s: "BTCUSDT",
			g: 42,
			l: "EXEC_STARTED",
			L: "EXECUTING",
		};
		const executionReport = {
			e: "executionReport",
			E: 1_700_000_000_101,
			s: "BTCUSDT",
			i: 9,
			c: "client-9",
			X: "NEW",
			q: "1",
			z: "0",
			p: "100",
			Z: "0",
			O: 1_700_000_000_090,
			T: 1_700_000_000_101,
			t: -1,
			n: "0",
			N: null,
		};
		socket.emitEvent(listStatus);
		socket.emitEvent(executionReport);

		expect(JSON.parse((await responsePromise).data)).toEqual({
			id: "9",
			clientOrderId: "client-9",
			status: "open",
			symbol: "BTC/USDT",
			amount: 1,
			filled: 0,
			price: 100,
			timestamp: 1_700_000_000_090,
		});
		expect(primary.calls.parseWsOrder).toEqual([executionReport]);

		await waitFor(() => archive.rows.length >= 4);
		expect(archive.rows).toHaveLength(4);
		for (const table of [
			"broker_execution.order_events",
			"market_data.cex_stream_events",
		]) {
			expect(
				archive.rows
					.filter((row) => row.table === table)
					.map((row) => JSON.parse(String(row.row.payload_json))),
			).toEqual([listStatus, executionReport]);
		}
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
