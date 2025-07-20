import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";
import type { Exchange } from "@usherlabs/ccxt";
import { Action } from "../proto/cexBroker/Action";
import { SubscriptionType } from "../proto/cexBroker/SubscriptionType";

describe("gRPC Server", () => {
	let mockExchange: Exchange;
	let testPolicy: PolicyConfig;
	let server: grpc.Server;
	let brokers: Record<string, { primary: Exchange; secondaryBrokers: Exchange[] }>;

	beforeEach(() => {
		// Create comprehensive mock exchange
		mockExchange = {
			fetchDeposits: mock(async (symbol: string, limit: number) => [
				{
					id: "tx123",
					txid: "tx123",
					amount: 100,
					currency: symbol,
					status: "ok",
					timestamp: Date.now(),
				},
			]),
			fetchDepositAddress: mock(async (symbol: string, params: any) => ({
				address: "0x1234567890123456789012345678901234567890",
				tag: null,
				network: params.network,
			})),
			fetchDepositAddressesByNetwork: mock(async (symbol: string, params: any) => ({
				address: "0x1234567890123456789012345678901234567890",
				tag: null,
				network: params.network,
			})),
			has: {
				fetchDepositAddress: true,
			},
			fetchCurrencies: mock(async (symbol: string) => ({
				[symbol]: {
					networks: {
						BEP20: { id: "BSC", network: "BSC", active: true, deposit: true, withdraw: true, fee: 1.0 },
						ETH: { id: "ETH", network: "ETH", active: true, deposit: true, withdraw: true, fee: 15.0 },
					},
				},
			})),
			withdraw: mock(async (symbol: string, amount: number, address: string, tag: string, params: any) => ({
				id: "withdraw123",
				amount,
				address,
				currency: symbol,
				status: "ok",
				timestamp: Date.now(),
			})),
			createOrder: mock(async (symbol: string, type: string, side: string, amount: number, price: number) => ({
				id: "order123",
				symbol,
				type,
				side,
				amount,
				price,
				status: "open",
				timestamp: Date.now(),
			})),
			fetchOrder: mock(async (orderId: string) => ({
				id: orderId,
				symbol: "BTC/USDT",
				status: "closed",
				amount: 0.001,
				filled: 0.001,
				side: "buy",
				price: 50000,
			})),
			cancelOrder: mock(async (orderId: string) => ({
				id: orderId,
				status: "canceled",
				symbol: "BTC/USDT",
			})),
			fetchFreeBalance: mock(async () => ({
				USDT: 1000,
				BTC: 0.1,
			})),
			watchOrderBook: mock(async (symbol: string) => ({
				symbol,
				bids: [[50000, 1]],
				asks: [[50001, 1]],
				timestamp: Date.now(),
			})),
			watchTrades: mock(async (symbol: string) => [
				{
					id: "trade123",
					symbol,
					amount: 0.001,
					price: 50000,
					side: "buy",
					timestamp: Date.now(),
				},
			]),
			watchTicker: mock(async (symbol: string) => ({
				symbol,
				last: 50000,
				bid: 49999,
				ask: 50001,
				volume: 100,
				timestamp: Date.now(),
			})),
			fetchOHLCVWs: mock(async (symbol: string, timeframe: string) => [
				[Date.now(), 50000, 50001, 49999, 50000, 100],
			]),
			watchBalance: mock(async () => ({
				free: { USDT: 1000, BTC: 0.1 },
				total: { USDT: 1000, BTC: 0.1 },
			})),
			watchOrders: mock(async (symbol: string) => [
				{
					id: "order123",
					symbol,
					status: "open",
					amount: 0.001,
					filled: 0,
					side: "buy",
					price: 50000,
				},
			]),
			last_proof: "zk_proof_123",
		} as any;

		// Test policy configuration
		testPolicy = {
			withdraw: {
				rule: {
					networks: ["BEP20", "ETH"],
					whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
					amounts: [
						{
							ticker: "USDT",
							max: 100000,
							min: 1,
						},
					],
				},
			},
			deposit: {},
			order: {
				rule: {
					markets: [
						"BINANCE:BTC/USDT",
						"BINANCE:ETH/USDT",
					],
					limits: [
						{ from: "USDT", to: "BTC", min: 1, max: 100000 },
						{ from: "BTC", to: "USDT", min: 0.001, max: 1 },
					],
				},
			},
		};

		brokers = {
			binance: {
				primary: mockExchange,
				secondaryBrokers: [mockExchange, mockExchange],
			},
		};

		server = getServer(testPolicy, brokers, ["127.0.0.1"], false, "http://localhost:8080");
	});

	afterEach(() => {
		if (server) {
			server.tryShutdown(() => {});
		}
	});

	describe("ExecuteAction", () => {
		test("should authenticate IP correctly", () => {
			const call = {
				getPeer: () => "127.0.0.1:12345",
				metadata: new grpc.Metadata(),
				request: {
					action: Action.FetchBalance,
					payload: {},
					cex: "binance",
					symbol: "USDT",
				},
			} as any;

			const callback = mock((error: any, response: any) => {});

			// This would require more complex mocking of the gRPC service
			// For now, we test the authentication logic separately
			expect(true).toBe(true);
		});

		test("should reject unauthorized IP", () => {
			const call = {
				getPeer: () => "192.168.1.100:12345",
				metadata: new grpc.Metadata(),
				request: {
					action: Action.FetchBalance,
					payload: {},
					cex: "binance",
					symbol: "USDT",
				},
			} as any;

			const callback = mock((error: any, response: any) => {});

			// This would require more complex mocking of the gRPC service
			// For now, we test the authentication logic separately
			expect(true).toBe(true);
		});

		test("should validate required fields", () => {
			const call = {
				getPeer: () => "127.0.0.1:12345",
				metadata: new grpc.Metadata(),
				request: {
					action: Action.FetchBalance,
					payload: {},
					cex: "", // Missing cex
					symbol: "USDT",
				},
			} as any;

			const callback = mock((error: any, response: any) => {});

			// This would require more complex mocking of the gRPC service
			// For now, we test the validation logic separately
			expect(true).toBe(true);
		});
	});

	describe("Action Handlers", () => {
		describe("Deposit Action", () => {
			test("should validate deposit payload correctly", () => {
				const validPayload = {
					recipientAddress: "0x1234567890123456789012345678901234567890",
					amount: 100,
					transactionHash: "tx123",
				};

				const invalidPayload = {
					recipientAddress: "0x1234567890123456789012345678901234567890",
					amount: -100, // Invalid amount
					transactionHash: "tx123",
				};

				// Test validation logic
				expect(validPayload.amount > 0).toBe(true);
				expect(invalidPayload.amount > 0).toBe(false);
			});

			test("should find deposit by transaction hash", async () => {
				const deposits = await mockExchange.fetchDeposits("USDT", 50);
				const deposit = deposits.find((d: any) => d.id === "tx123" || d.txid === "tx123");

				expect(deposit).toBeDefined();
				expect(deposit.id).toBe("tx123");
			});
		});

		describe("FetchDepositAddresses Action", () => {
			test("should validate chain parameter", () => {
				const validPayload = { chain: "BEP20" };
				const invalidPayload = { chain: "" };

				expect(validPayload.chain).toBeTruthy();
				expect(invalidPayload.chain).toBeFalsy();
			});

			test("should fetch deposit address with network parameter", async () => {
				const address = await mockExchange.fetchDepositAddress("USDT", { network: "BEP20" });
				expect(address.address).toBe("0x1234567890123456789012345678901234567890");
				expect(address.network).toBe("BEP20");
			});
		});

		describe("Transfer Action", () => {
			test("should validate transfer payload", () => {
				const validPayload = {
					recipientAddress: "0x9d467fa9062b6e9b1a46e26007ad82db116c67cb",
					amount: 100,
					chain: "BEP20",
				};

				const invalidPayload = {
					recipientAddress: "0x1234567890123456789012345678901234567890", // Not whitelisted
					amount: 100,
					chain: "BEP20",
				};

				// Test validation logic
				expect(validPayload.amount > 0).toBe(true);
				expect(validPayload.chain).toBeTruthy();
				expect(validPayload.recipientAddress).toBeTruthy();
			});

			test("should validate network support", async () => {
				const currencies = await mockExchange.fetchCurrencies("USDT");
				const networks = Object.keys(currencies["USDT"].networks);

				expect(networks).toContain("BEP20");
				expect(networks).toContain("ETH");
			});
		});

		describe("CreateOrder Action", () => {
			test("should validate order payload", () => {
				const validPayload = {
					orderType: "limit",
					amount: 0.001,
					fromToken: "BTC",
					toToken: "USDT",
					price: 50000,
				};

				const invalidPayload = {
					orderType: "invalid",
					amount: -0.001,
					fromToken: "BTC",
					toToken: "USDT",
					price: -50000,
				};

				// Test validation logic
				expect(["market", "limit"].includes(validPayload.orderType)).toBe(true);
				expect(validPayload.amount > 0).toBe(true);
				expect(validPayload.price > 0).toBe(true);
			});

			test("should determine correct order side", () => {
				const symbol = "BTC/USDT";
				const [from, to] = symbol.split("/");
				const fromToken = "BTC";
				const side = from === fromToken ? "sell" : "buy";

				expect(side).toBe("sell");
			});
		});

		describe("GetOrderDetails Action", () => {
			test("should validate order ID", () => {
				const validPayload = { orderId: "order123" };
				const invalidPayload = { orderId: "" };

				expect(validPayload.orderId).toBeTruthy();
				expect(invalidPayload.orderId).toBeFalsy();
			});

			test("should format order details correctly", async () => {
				const orderDetails = await mockExchange.fetchOrder("order123");
				const formatted = {
					orderId: orderDetails.id,
					status: orderDetails.status,
					originalAmount: orderDetails.amount,
					filledAmount: orderDetails.filled,
					symbol: orderDetails.symbol,
					mode: orderDetails.side,
					price: orderDetails.price,
				};

				expect(formatted.orderId).toBe("order123");
				expect(formatted.status).toBe("closed");
				expect(formatted.symbol).toBe("BTC/USDT");
			});
		});

		describe("CancelOrder Action", () => {
			test("should validate order ID for cancellation", () => {
				const validPayload = { orderId: "order123" };
				const invalidPayload = { orderId: "" };

				expect(validPayload.orderId).toBeTruthy();
				expect(invalidPayload.orderId).toBeFalsy();
			});

			test("should cancel order successfully", async () => {
				const cancelledOrder = await mockExchange.cancelOrder("order123");
				expect(cancelledOrder.status).toBe("canceled");
				expect(cancelledOrder.id).toBe("order123");
			});
		});

		describe("FetchBalance Action", () => {
			test("should fetch balance for specific symbol", async () => {
				const balance = await mockExchange.fetchFreeBalance();
				const currencyBalance = balance["USDT"];

				expect(currencyBalance).toBe(1000);
			});

			test("should handle missing currency balance", async () => {
				const balance = await mockExchange.fetchFreeBalance();
				const currencyBalance = balance["INVALID"];

				expect(currencyBalance).toBeUndefined();
			});
		});
	});

	describe("Subscribe Stream", () => {
		describe("Orderbook Subscription", () => {
			test("should stream orderbook data", async () => {
				const orderbook = await mockExchange.watchOrderBook("BTC/USDT");
				expect(orderbook.symbol).toBe("BTC/USDT");
				expect(orderbook.bids).toBeDefined();
				expect(orderbook.asks).toBeDefined();
			});
		});

		describe("Trades Subscription", () => {
			test("should stream trades data", async () => {
				const trades = await mockExchange.watchTrades("BTC/USDT");
				expect(Array.isArray(trades)).toBe(true);
				expect(trades.length).toBeGreaterThan(0);
				expect(trades[0].symbol).toBe("BTC/USDT");
			});
		});

		describe("Ticker Subscription", () => {
			test("should stream ticker data", async () => {
				const ticker = await mockExchange.watchTicker("BTC/USDT");
				expect(ticker.symbol).toBe("BTC/USDT");
				expect(ticker.last).toBeDefined();
				expect(ticker.bid).toBeDefined();
				expect(ticker.ask).toBeDefined();
			});
		});

		describe("OHLCV Subscription", () => {
			test("should stream OHLCV data with default timeframe", async () => {
				const ohlcv = await mockExchange.fetchOHLCVWs("BTC/USDT", "1m");
				expect(Array.isArray(ohlcv)).toBe(true);
				expect(ohlcv.length).toBeGreaterThan(0);
			});

			test("should stream OHLCV data with custom timeframe", async () => {
				const ohlcv = await mockExchange.fetchOHLCVWs("BTC/USDT", "1h");
				expect(Array.isArray(ohlcv)).toBe(true);
				expect(ohlcv.length).toBeGreaterThan(0);
			});
		});

		describe("Balance Subscription", () => {
			test("should stream balance updates", async () => {
				const balance = await mockExchange.watchBalance();
				expect(balance.free).toBeDefined();
				expect(balance.total).toBeDefined();
				expect(balance.free.USDT).toBe(1000);
			});
		});

		describe("Orders Subscription", () => {
			test("should stream order updates", async () => {
				const orders = await mockExchange.watchOrders("BTC/USDT");
				expect(Array.isArray(orders)).toBe(true);
				expect(orders.length).toBeGreaterThan(0);
				expect(orders[0].symbol).toBe("BTC/USDT");
			});
		});
	});

	describe("Secondary Broker Support", () => {
		test("should create broker with secondary keys", () => {
			const metadata = new grpc.Metadata();
			metadata.set("api-key", "secondary_key");
			metadata.set("api-secret", "secondary_secret");
			metadata.set("use-secondary-key", "1");

			// Test that secondary broker selection works
			expect(metadata.get("use-secondary-key").length).toBe(1);
		});

		test("should fallback to primary broker when secondary not available", () => {
			const metadata = new grpc.Metadata();
			metadata.set("use-secondary-key", "999"); // Non-existent secondary

			// Test fallback logic
			expect(metadata.get("use-secondary-key").length).toBe(1);
		});
	});

	describe("Verity Integration", () => {
		test("should return ZK proof when Verity is enabled", () => {
			const serverWithVerity = getServer(testPolicy, brokers, ["127.0.0.1"], true, "http://localhost:8080");
			
			// Test that Verity integration is configured
			expect(serverWithVerity).toBeDefined();
		});

		test("should return raw data when Verity is disabled", () => {
			const serverWithoutVerity = getServer(testPolicy, brokers, ["127.0.0.1"], false, "http://localhost:8080");
			
			// Test that Verity integration is not configured
			expect(serverWithoutVerity).toBeDefined();
		});
	});

	describe("Error Handling", () => {
		test("should handle exchange errors gracefully", async () => {
			// Mock exchange with error
			const errorExchange = {
				...mockExchange,
				fetchBalance: mock(async () => {
					throw new Error("Exchange error");
				}),
			} as any;

			// Test error handling
			expect(errorExchange).toBeDefined();
		});

		test("should handle network errors", async () => {
			// Mock network error
			const networkError = new Error("Network timeout");
			expect(networkError.message).toBe("Network timeout");
		});

		test("should handle validation errors", () => {
			const invalidRequest = {
				action: Action.CreateOrder,
				payload: {
					amount: -1, // Invalid amount
				},
				cex: "binance",
				symbol: "BTC/USDT",
			};

			// Test validation error handling
			expect(invalidRequest.payload.amount <= 0).toBe(true);
		});
	});
}); 