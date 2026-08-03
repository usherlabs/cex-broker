import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Exchange } from "@usherlabs/ccxt";
import { BrokerExecutionArchiver } from "../src/helpers/broker-execution-archive/writer";
import { Action } from "../src/helpers/constants";
import type { BrokerPoolEntry } from "../src/helpers/index";
import { PROTO_LOADER_OPTIONS } from "../src/proto-loader-options";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";
import { startForwarderServer } from "./archive-forwarder-server";

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
			Subscribe(request: Record<string, unknown>): grpc.ClientReadableStream<{
				data: string;
				timestamp: string;
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

type OrderBookExchangeOptions = {
	fetchOrderBookResult?: unknown;
	watchOrderBookResult?: unknown;
	has?: Record<string, unknown>;
};

function createOrderBookExchange(options: OrderBookExchangeOptions = {}) {
	const calls: Record<string, unknown[][]> = {
		fetchOrderBook: [],
		watchOrderBook: [],
		fetchTicker: [],
	};
	const exchange: Record<string, unknown> = {
		has: {
			fetchOrderBook: true,
			watchOrderBook: true,
			fetchTicker: true,
			...(options.has ?? {}),
		},
		fetchOrderBook: async (...args: unknown[]) => {
			calls.fetchOrderBook.push(args);
			return (
				options.fetchOrderBookResult ?? {
					bids: [
						[100, 1],
						[99, 2],
					],
					asks: [
						[101, 3],
						[102, 4],
					],
					timestamp: 1770000000000,
					lastUpdateId: 42,
					apiKey: "should-not-leak",
					secret: "should-not-leak",
				}
			);
		},
		watchOrderBook: async (...args: unknown[]) => {
			calls.watchOrderBook.push(args);
			if (calls.watchOrderBook.length > 1) {
				return new Promise(() => {});
			}
			const watchOrderBookResult =
				options.watchOrderBookResult ??
				({
					bids: [
						[200, 1],
						[199, 2],
					],
					asks: [
						[201, 3],
						[202, 4],
					],
					timestamp: 1770000001000,
					nonce: 77,
				} as const);
			if (watchOrderBookResult instanceof Error) {
				throw watchOrderBookResult;
			}
			return watchOrderBookResult;
		},
		fetchTicker: async (...args: unknown[]) => {
			calls.fetchTicker.push(args);
			return { symbol: args[0], last: 123 };
		},
	};
	return { exchange: exchange as Exchange, calls };
}

function createPool(
	cex: string,
	exchange: Exchange,
): Record<string, BrokerPoolEntry> {
	return {
		[cex]: {
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

function createClient(port: number) {
	return new grpcObj.cex_broker.cex_service(
		`127.0.0.1:${port}`,
		grpc.credentials.createInsecure(),
	);
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error("timed out waiting for condition");
		await Bun.sleep(5);
	}
}

function executeAction(
	client: InstanceType<typeof grpcObj.cex_broker.cex_service>,
	request: Record<string, unknown>,
	metadata?: grpc.Metadata,
) {
	return new Promise<{ result: string; proof: string }>((resolve, reject) => {
		const callback = (
			error: grpc.ServiceError | null,
			response?: { result: string; proof: string },
		) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(response as { result: string; proof: string });
		};
		if (metadata) {
			(
				client.ExecuteAction as unknown as (
					request: Record<string, unknown>,
					metadata: grpc.Metadata,
					callback: grpc.requestCallback<{
						result: string;
						proof: string;
					}>,
				) => void
			)(request, metadata, callback);
		} else {
			client.ExecuteAction(request, callback);
		}
	});
}

function firstSubscribeFrame(
	client: InstanceType<typeof grpcObj.cex_broker.cex_service>,
	request: Record<string, unknown>,
) {
	return new Promise<{
		data: string;
		timestamp: string;
		symbol: string;
		type: string;
	}>((resolve, reject) => {
		let settled = false;
		const stream = client.Subscribe(request);
		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				stream.cancel();
				reject(new Error("timed out waiting for Subscribe frame"));
			}
		}, 2000);
		stream.on("data", (response) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			stream.cancel();
			resolve(response);
		});
		stream.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
	});
}

describe("order-book RPC compatibility", () => {
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	afterEach(async () => {
		client?.close();
		if (server) {
			await server.forceShutdown();
		}
	});

	test("provisioned-only rejects request credentials before provider access", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				sourcePolicy: "provisioned_only",
				provisionedProfile: "read_only_key",
			},
		);
		client = createClient(await bindServer(server));
		const metadata = new grpc.Metadata();
		metadata.set("api-secret", "must-not-be-used");

		await expect(
			executeAction(
				client,
				{
					action: Action.Call,
					cex: "binance",
					symbol: "BTC/USDT",
					payload: {
						method: "fetch_order_book_snapshot",
						depthLimit: "1",
					},
				},
				metadata,
			),
		).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
		expect(calls.fetchOrderBook).toHaveLength(0);
	});

	test("dispatches Maker capability method without invoking a fake CCXT method", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("mexc", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await executeAction(client, {
			action: Action.Call,
			cex: "mexc",
			symbol: "ARB/USDT",
			payload: {
				method: "fetch_order_book_capability",
				depthLimit: "100",
				constructionMode: "sampled_top_n_snapshot",
			},
		});

		const payload = JSON.parse(response.result);
		expect(payload).toMatchObject({
			exchange: "mexc",
			symbol: "ARB/USDT",
			provider: "ccxt_order_book",
			maxDepth: 100,
			supportsCurrentSnapshot: true,
			supportsLiveStream: true,
			supportsHistoricalSnapshots: false,
			supportsSampledTopN: false,
			supportsExactL2Reconstruction: false,
		});
		expect(calls.fetchOrderBook).toHaveLength(0);
	});

	test("dispatches Maker current snapshot method and normalizes metadata", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await executeAction(client, {
			action: Action.Call,
			cex: "binance",
			symbol: "BTC/USDT",
			payload: {
				method: "fetch_order_book_snapshot",
				depthLimit: "1",
			},
		});

		const payload = JSON.parse(response.result);
		expect(payload).toMatchObject({
			bids: [[100, 1]],
			asks: [[101, 3]],
			timestamp: 1770000000000,
			exchange: "binance",
			symbol: "BTC/USDT",
			sequence: 42,
			depthLimit: 1,
		});
		expect(typeof payload.receivedTimestamp).toBe("number");
		expect(JSON.stringify(payload)).not.toContain("should-not-leak");
		expect(calls.fetchOrderBook[0]).toEqual(["BTC/USDT", 1]);
	});

	test("archives a typed current snapshot with current-snapshot provenance", async () => {
		const originalEnabled = process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
		const originalWriteMode = process.env.CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE;
		process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = "true";
		process.env.CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE = "canonical";
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			source: "broker_read",
			deploymentId: "read-collector-test",
			deadLetterPath: join(tmpdir(), `cex-rpc-${crypto.randomUUID()}.jsonl`),
			forwarderUrl: forwarder.url,
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		try {
			const { exchange } = createOrderBookExchange();
			server = getServer(
				testPolicy,
				createPool("binance", exchange),
				["*"],
				false,
				"",
				undefined,
				archiver,
			);
			client = createClient(await bindServer(server));

			await executeAction(client, {
				action: Action.Call,
				cex: "binance",
				symbol: "BTC/USDT",
				payload: {
					method: "fetch_order_book_snapshot",
					depthLimit: "1",
				},
			});
			await waitFor(() => archiver.getStats().enqueued === 4);
			const queued = Reflect.get(archiver, "queue") as Array<{
				table: string;
				row: Record<string, unknown>;
			}>;
			expect(queued.map(({ table }) => table)).toEqual([
				"market_data.cex_stream_events",
				"market_data.cex_order_book_levels",
				"market_data.cex_order_book_levels",
				"market_data.cex_order_book_depth_summary",
			]);
			expect(queued.every(({ row }) => row.source === "broker_read")).toBe(
				true,
			);
			expect(
				queued.every(
					({ row }) => row.source_mode === "broker_current_snapshot_v1",
				),
			).toBe(true);
		} finally {
			await archiver.close();
			await forwarder.close();
			if (originalEnabled === undefined) {
				delete process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
			} else {
				process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = originalEnabled;
			}
			if (originalWriteMode === undefined) {
				delete process.env.CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE;
			} else {
				process.env.CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE = originalWriteMode;
			}
		}
	});

	test("returns typed historical unsupported including exact reconstruction", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await executeAction(client, {
			action: Action.Call,
			cex: "binance",
			symbol: "ARB/USDT",
			payload: {
				method: "fetch_historical_order_book_snapshots",
				start: "2026-06-02T00:00:00Z",
				end: "2026-06-02T00:01:00Z",
				cadence: "1s",
				depthLimit: "100",
				constructionMode: "exact_l2_reconstruction",
			},
		});

		const payload = JSON.parse(response.result);
		expect(payload).toMatchObject({
			exchange: "binance",
			symbol: "ARB/USDT",
			unsupported: true,
			unsupportedReason: "historical_order_book_provider_unsupported",
			constructionMode: "exact_l2_reconstruction",
		});
		expect(calls.fetchOrderBook).toHaveLength(0);
		expect(calls.watchOrderBook).toHaveLength(0);
	});

	test("rejects malformed order-book call input before provider access", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		await expect(
			executeAction(client, {
				action: Action.Call,
				cex: "binance",
				symbol: "BTC/USDT",
				payload: {
					method: "fetch_order_book_snapshot",
					depthLimit: "0",
				},
			}),
		).rejects.toMatchObject({
			code: grpc.status.INVALID_ARGUMENT,
		});
		expect(calls.fetchOrderBook).toHaveLength(0);
	});

	test("preserves generic non-order-book Call behavior", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await executeAction(client, {
			action: Action.Call,
			cex: "binance",
			symbol: "BTC/USDT",
			payload: {
				functionName: "fetchTicker",
				args: JSON.stringify(["BTC/USDT"]),
			},
		});

		expect(JSON.parse(response.result)).toMatchObject({
			symbol: "BTC/USDT",
			last: 123,
		});
		expect(calls.fetchTicker[0]).toEqual(["BTC/USDT"]);

		await expect(
			executeAction(client, {
				action: Action.Call,
				cex: "binance",
				symbol: "BTC/USDT",
				payload: {
					functionName: "_privateMethod",
				},
			}),
		).rejects.toMatchObject({
			code: grpc.status.INVALID_ARGUMENT,
		});
	});

	test("accepts functionName alias for order-book snapshot", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await executeAction(client, {
			action: Action.Call,
			cex: "binance",
			symbol: "BTC/USDT",
			payload: {
				functionName: "fetch_order_book_snapshot",
				depthLimit: "2",
			},
		});

		expect(JSON.parse(response.result)).toMatchObject({
			bids: [
				[100, 1],
				[99, 2],
			],
			exchange: "binance",
			symbol: "BTC/USDT",
			depthLimit: 2,
		});
		expect(calls.fetchOrderBook[0]).toEqual(["BTC/USDT", 2]);
	});

	test("returns explicit unsupported snapshot when fetchOrderBook is false", async () => {
		const { exchange, calls } = createOrderBookExchange({
			has: { fetchOrderBook: false },
		});
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const capabilityResponse = await executeAction(client, {
			action: Action.Call,
			cex: "binance",
			symbol: "BTC/USDT",
			payload: {
				method: "fetch_order_book_capability",
				depthLimit: "5",
			},
		});
		const capability = JSON.parse(capabilityResponse.result);
		expect(capability).toMatchObject({
			supportsCurrentSnapshot: false,
			supportsLiveStream: true,
		});

		await expect(
			executeAction(client, {
				action: Action.Call,
				cex: "binance",
				symbol: "BTC/USDT",
				payload: {
					method: "fetch_order_book_snapshot",
					depthLimit: "1",
				},
			}),
		).rejects.toMatchObject({ code: grpc.status.UNIMPLEMENTED });
		expect(calls.fetchOrderBook).toHaveLength(0);
	});

	test("enriches ORDERBOOK stream data while preserving omitted type compatibility", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await firstSubscribeFrame(client, {
			cex: "binance",
			symbol: "BTC/USDT",
			options: { depthLimit: "1" },
		});

		const payload = JSON.parse(response.data);
		expect(payload).toMatchObject({
			bids: [[200, 1]],
			asks: [[201, 3]],
			timestamp: 1770000001000,
			exchange: "binance",
			symbol: "BTC/USDT",
			sequence: 77,
			depthLimit: 1,
		});
		expect(typeof payload.receivedTimestamp).toBe("number");
		expect(Number(response.timestamp)).toBe(payload.receivedTimestamp);
		expect(calls.watchOrderBook[0]).toEqual(["BTC/USDT", 1]);
	});

	test("resolves explicit NO_ACTION subscription type to ORDERBOOK", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await firstSubscribeFrame(client, {
			cex: "binance",
			symbol: "BTC/USDT",
			type: 0,
		});

		const payload = JSON.parse(response.data);
		expect(payload.bids).toEqual([
			[200, 1],
			[199, 2],
		]);
		expect(payload.asks).toEqual([
			[201, 3],
			[202, 4],
		]);
		expect(calls.watchOrderBook[0]).toEqual(["BTC/USDT"]);
	});

	test("resolves out-of-range subscription type to ORDERBOOK", async () => {
		const { exchange, calls } = createOrderBookExchange();
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await firstSubscribeFrame(client, {
			cex: "binance",
			symbol: "BTC/USDT",
			type: 99,
		});

		const payload = JSON.parse(response.data);
		expect(payload.bids).toEqual([
			[200, 1],
			[199, 2],
		]);
		expect(calls.watchOrderBook[0]).toEqual(["BTC/USDT"]);
	});

	test("publishes explicit orderbook stream error when watchOrderBook rejects", async () => {
		const { exchange, calls } = createOrderBookExchange({
			watchOrderBookResult: new Error("stream boom"),
		});
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await firstSubscribeFrame(client, {
			cex: "binance",
			symbol: "BTC/USDT",
		});

		const payload = JSON.parse(response.data);
		expect(payload.error).toContain("Failed to fetch orderbook: stream boom");
		expect(payload.error).toContain("Failed to fetch orderbook");
		expect(calls.watchOrderBook).toHaveLength(1);
	});

	test("publishes explicit orderbook stream error for malformed watchOrderBook payload", async () => {
		const { exchange, calls } = createOrderBookExchange({
			watchOrderBookResult: "bad",
		});
		server = getServer(
			testPolicy,
			createPool("binance", exchange),
			["*"],
			false,
			"",
		);
		client = createClient(await bindServer(server));

		const response = await firstSubscribeFrame(client, {
			cex: "binance",
			symbol: "BTC/USDT",
		});

		const payload = JSON.parse(response.data);
		expect(payload.error).toContain("Malformed order book: expected object");
		expect(payload.error).toContain("Failed to fetch orderbook");
		expect(calls.watchOrderBook).toHaveLength(1);
	});
});
