import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { Action } from "../src/helpers/constants";
import type { BrokerPoolEntry } from "../src/helpers/index";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";
import { bindServer, executeAction, grpcObj } from "./order-telemetry-fixtures";

const testPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

type TreasuryExchangeOptions = {
	has?: Record<string, unknown>;
	markets?: Record<string, unknown>;
	currencies?: Record<string, unknown>;
	deposits?: Array<Record<string, unknown>>;
	depositWithdrawFees?: Record<string, unknown>;
	balances?: Record<string, number>;
};

function createTreasuryExchange(options: TreasuryExchangeOptions = {}) {
	const calls: Record<string, unknown[][]> = {
		fetchMarkets: [],
		loadMarkets: [],
		fetchCurrencies: [],
		fetchDeposits: [],
		fetchDepositWithdrawFees: [],
		fetchDepositAddress: [],
		fetchTotalBalance: [],
		withdraw: [],
	};
	const exchange: Record<string, unknown> = {
		has: {
			fetchMarkets: true,
			fetchCurrencies: true,
			fetchDeposits: true,
			fetchDepositAddress: true,
			...(options.has ?? {}),
		},
		fees: {
			trading: {
				maker: 0,
				taker: 0.001,
			},
		},
		markets: options.markets ?? {
			"ARB/USDC": { symbol: "ARB/USDC", base: "ARB", quote: "USDC" },
		},
		currencies: options.currencies ?? {
			USDC: {
				code: "USDC",
				id: "USDC",
				networks: {
					BSC: {
						id: "BSC",
						network: "BSC",
						deposit: true,
						withdraw: true,
						fee: "0",
					},
				},
			},
		},
		fetchMarkets: async (...args: unknown[]) => {
			calls.fetchMarkets.push(args);
			return [{ symbol: "ARB/USDC", base: "ARB", quote: "USDC" }];
		},
		loadMarkets: async (...args: unknown[]) => {
			calls.loadMarkets.push(args);
			return options.markets ?? exchange.markets;
		},
		fetchCurrencies: async (...args: unknown[]) => {
			calls.fetchCurrencies.push(args);
			return exchange.currencies;
		},
		fetchDeposits: async (...args: unknown[]) => {
			calls.fetchDeposits.push(args);
			return options.deposits ?? [];
		},
		fetchDepositWithdrawFees: async (...args: unknown[]) => {
			calls.fetchDepositWithdrawFees.push(args);
			return options.depositWithdrawFees ?? {};
		},
		fetchDepositAddress: async (...args: unknown[]) => {
			calls.fetchDepositAddress.push(args);
			return { address: "0xdeposit" };
		},
		fetchTotalBalance: async (...args: unknown[]) => {
			calls.fetchTotalBalance.push(args);
			return options.balances ?? { USDC: 42 };
		},
		market: (symbol: string) => {
			const market = (exchange.markets as Record<string, unknown>)[symbol];
			if (!market) {
				throw new Error(`unsupported symbol ${symbol}`);
			}
			return market;
		},
		withdraw: async (...args: unknown[]) => {
			calls.withdraw.push(args);
			return { id: "withdraw-1", txid: "0xwithdraw" };
		},
	};
	return { exchange: exchange as Exchange, calls };
}

function createPool(exchange: Exchange): Record<string, BrokerPoolEntry> {
	return {
		binance: {
			primary: { exchange, label: "primary" },
			secondaryBrokers: [],
		},
	};
}

describe("Treasury discovery and deposit observation RPC", () => {
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	afterEach(async () => {
		client?.close();
		if (server) {
			await server.forceShutdown();
		}
	});

	async function start(exchange: Exchange, policy = testPolicy) {
		server = getServer(policy, createPool(exchange), ["*"], false, "");
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);
		return client;
	}

	test("serves fetchMarkets and fetchCurrencies through the Call action", async () => {
		const { exchange, calls } = createTreasuryExchange();
		const rpc = await start(exchange);

		const markets = await executeAction(rpc, {
			action: Action.Call,
			cex: "binance",
			payload: { functionName: "fetchMarkets", args: "[]", params: "{}" },
		});
		expect(JSON.parse(markets.result)).toEqual([
			{ symbol: "ARB/USDC", base: "ARB", quote: "USDC" },
		]);

		const currencies = await executeAction(rpc, {
			action: Action.Call,
			cex: "binance",
			payload: { functionName: "fetchCurrencies", args: "[]", params: "{}" },
		});
		expect(JSON.parse(currencies.result)).toHaveProperty("USDC.networks.BSC");
		expect(calls.fetchMarkets).toHaveLength(1);
		expect(calls.fetchCurrencies).toHaveLength(1);
	});

	test("falls back to loaded markets when direct fetchMarkets is unavailable", async () => {
		const { exchange, calls } = createTreasuryExchange({
			has: { fetchMarkets: false },
		});
		const rpc = await start(exchange);

		const response = await executeAction(rpc, {
			action: Action.Call,
			cex: "binance",
			payload: { functionName: "fetchMarkets", args: "[]", params: "{}" },
		});

		expect(JSON.parse(response.result)).toEqual([
			{ symbol: "ARB/USDC", base: "ARB", quote: "USDC" },
		]);
		expect(calls.fetchMarkets).toHaveLength(0);
		expect(calls.loadMarkets).toHaveLength(1);
	});

	test("serves transfer-network metadata through FetchCurrency", async () => {
		const { exchange } = createTreasuryExchange();
		const rpc = await start(exchange);

		const response = await executeAction(rpc, {
			action: Action.FetchCurrency,
			cex: "binance",
			symbol: "USDC",
		});

		expect(JSON.parse(response.result)).toMatchObject({
			exchange: "binance",
			asset: "USDC",
			code: "USDC",
			networks: {
				BSC: {
					id: "BSC",
					network: "BSC",
					operatorAlias: "BSC",
					brokerNetworkId: "BNB",
					exchangeNetworkId: "BSC",
					deposit: true,
					withdraw: true,
					fee: "0",
				},
			},
			networkAliases: {
				BNB: {
					operatorAlias: "BNB",
					brokerNetworkId: "BNB",
					exchangeNetworkId: "BSC",
					networkKey: "BSC",
				},
				BEP20: {
					operatorAlias: "BEP20",
					brokerNetworkId: "BNB",
					exchangeNetworkId: "BSC",
					networkKey: "BSC",
				},
			},
		});
	});

	test("extracts transfer fee and limit metadata for funding discovery", async () => {
		const { exchange, calls } = createTreasuryExchange({
			has: { fetchDepositWithdrawFees: true },
			depositWithdrawFees: {
				USDC: {
					withdraw: { fee: 0, percentage: false },
					networks: {
						BSC: {
							id: "BSC",
							network: "BSC",
							fee: 0,
							limits: { withdraw: { min: 1, max: 50000 } },
							withdraw: true,
							deposit: true,
						},
					},
				},
			},
		});
		const rpc = await start(exchange);

		const response = await executeAction(rpc, {
			action: Action.FetchFees,
			cex: "binance",
			symbol: "USDC",
			payload: { includeAllFees: true },
		});

		expect(JSON.parse(response.result)).toMatchObject({
			feeScope: "token",
			symbol: "USDC",
			fundingFeeSource: "fetchDepositWithdrawFees",
			fundingFeesByCurrency: {
				USDC: {
					withdraw: { fee: 0, percentage: false },
					networks: {
						BSC: {
							fee: 0,
							limits: { withdraw: { min: 1, max: 50000 } },
							withdraw: true,
							deposit: true,
						},
					},
				},
			},
		});
		expect(calls.fetchDepositWithdrawFees[0]).toEqual([["USDC"]]);
	});

	test("fails closed when a requested transfer-network alias is unsupported", async () => {
		const { exchange } = createTreasuryExchange();
		const policy: PolicyConfig = {
			withdraw: { rule: [] },
			deposit: {
				rule: [{ exchange: "BINANCE", network: "TRC20", coins: ["USDC"] }],
			},
			order: { rule: { markets: [], limits: [] } },
		};
		const rpc = await start(exchange, policy);

		await expect(
			executeAction(rpc, {
				action: Action.FetchDepositAddresses,
				cex: "binance",
				symbol: "USDC",
				payload: { chain: "TRC20" },
			}),
		).rejects.toMatchObject({
			code: grpc.status.INVALID_ARGUMENT,
			details:
				"network_alias_unresolved: USDC/TRC20 is not available in discovered transfer networks",
		});
	});

	test("resolves BNB aliases for deposit address and withdrawal calls", async () => {
		const { exchange, calls } = createTreasuryExchange();
		const policy: PolicyConfig = {
			withdraw: {
				rule: [
					{
						exchange: "BINANCE",
						network: "BNB",
						whitelist: ["0xwithdraw"],
						coins: ["USDC"],
					},
				],
			},
			deposit: {
				rule: [{ exchange: "BINANCE", network: "BEP20", coins: ["USDC"] }],
			},
			order: { rule: { markets: [], limits: [] } },
		};
		const rpc = await start(exchange, policy);

		const depositAddress = await executeAction(rpc, {
			action: Action.FetchDepositAddresses,
			cex: "binance",
			symbol: "USDC",
			payload: {
				chain: "BEP20",
			},
		});
		expect(JSON.parse(depositAddress.result)).toEqual([
			{
				address: "0xdeposit",
				operatorAlias: "BEP20",
				brokerNetworkId: "BNB",
				exchangeNetworkId: "BSC",
			},
		]);
		expect(calls.fetchDepositAddress[0]).toEqual(["USDC", { network: "BSC" }]);

		const withdraw = await executeAction(rpc, {
			action: Action.Withdraw,
			cex: "binance",
			symbol: "USDC",
			payload: {
				recipientAddress: "0xwithdraw",
				amount: "25.5",
				chain: "BNB",
			},
		});
		expect(JSON.parse(withdraw.result)).toMatchObject({
			id: "withdraw-1",
			operatorAlias: "BNB",
			brokerNetworkId: "BNB",
			exchangeNetworkId: "BSC",
		});
		expect(calls.withdraw[0]).toEqual([
			"USDC",
			25.5,
			"0xwithdraw",
			undefined,
			{ network: "BSC" },
		]);
	});

	test("returns stable policy-denied errors for transfer actions", async () => {
		const { exchange } = createTreasuryExchange();
		const policy: PolicyConfig = {
			withdraw: {
				rule: [
					{
						exchange: "BINANCE",
						network: "BEP20",
						whitelist: ["0xwithdraw"],
						coins: ["USDC"],
					},
				],
			},
			deposit: {
				rule: [{ exchange: "BINANCE", network: "BEP20", coins: ["USDC"] }],
			},
			order: { rule: { markets: [], limits: [] } },
		};
		const rpc = await start(exchange, policy);

		await expect(
			executeAction(rpc, {
				action: Action.FetchDepositAddresses,
				cex: "binance",
				symbol: "USDT",
				payload: { chain: "BEP20" },
			}),
		).rejects.toMatchObject({
			code: grpc.status.PERMISSION_DENIED,
			details: expect.stringContaining("policy_deposit_denied:"),
		});
		await expect(
			executeAction(rpc, {
				action: Action.Withdraw,
				cex: "binance",
				symbol: "ARB",
				payload: {
					recipientAddress: "0xwithdraw",
					amount: "25.5",
					chain: "BEP20",
				},
			}),
		).rejects.toMatchObject({
			code: grpc.status.PERMISSION_DENIED,
			details: expect.stringContaining("policy_withdrawal_denied:"),
		});
	});

	test("observes credited and missing deposits with stable statuses", async () => {
		const { exchange, calls } = createTreasuryExchange({
			deposits: [
				{
					id: "deposit-1",
					txid: "0xtx",
					amount: "25.5",
					address: "0xdeposit",
					status: "ok",
					confirmations: 15,
					datetime: "2026-06-04T00:00:00.000Z",
				},
			],
		});
		const rpc = await start(exchange);

		const credited = await executeAction(rpc, {
			action: Action.Deposit,
			cex: "binance",
			symbol: "USDC",
			payload: {
				recipientAddress: "0xdeposit",
				amount: "25.5",
				transactionHash: "0xtx",
				since: "1710000000000",
				params: JSON.stringify({ network: "BEP20" }),
			},
		});
		expect(JSON.parse(credited.result)).toMatchObject({
			status: "credited",
			exchange: "binance",
			asset: "USDC",
			operatorAlias: "BEP20",
			brokerNetworkId: "BNB",
			exchangeNetworkId: "BSC",
			txid: "0xtx",
			amount: "25.5",
			observedAmount: "25.5",
			expectedAmount: 25.5,
			address: "0xdeposit",
			confirmations: 15,
			creditedAt: "2026-06-04T00:00:00.000Z",
		});
		expect(calls.fetchDeposits[0]).toEqual([
			"USDC",
			1710000000000,
			50,
			{ network: "BSC" },
		]);

		const missing = await executeAction(rpc, {
			action: Action.Deposit,
			cex: "binance",
			symbol: "USDC",
			payload: {
				recipientAddress: "0xdeposit",
				amount: "25.5",
				transactionHash: "0xmissing",
			},
		});
		expect(JSON.parse(missing.result)).toMatchObject({
			status: "not_found",
			txid: "0xmissing",
			expectedAmount: 25.5,
		});
	});

	test("normalizes pending, failed, and timed-out deposit observation statuses", async () => {
		const { exchange } = createTreasuryExchange({
			deposits: [
				{
					txid: "0xpending",
					amount: "1",
					address: "0xdeposit",
					status: "pending",
				},
				{
					txid: "0xfailed",
					amount: "1",
					address: "0xdeposit",
					status: "rejected",
				},
				{
					txid: "0xtimeout",
					amount: "1",
					address: "0xdeposit",
					status: "timeout",
				},
			],
		});
		const rpc = await start(exchange);

		for (const [txid, status] of [
			["0xpending", "pending"],
			["0xfailed", "failed"],
			["0xtimeout", "timed_out"],
		] as const) {
			const response = await executeAction(rpc, {
				action: Action.Deposit,
				cex: "binance",
				symbol: "USDC",
				payload: {
					recipientAddress: "0xdeposit",
					amount: "1",
					transactionHash: txid,
				},
			});
			expect(JSON.parse(response.result)).toMatchObject({ txid, status });
		}
	});

	test("reports unsupported deposit observation without broker mutation", async () => {
		const { exchange } = createTreasuryExchange({
			has: { fetchDeposits: false },
		});
		const rpc = await start(exchange);

		const response = await executeAction(rpc, {
			action: Action.Deposit,
			cex: "binance",
			symbol: "USDC",
			payload: {
				recipientAddress: "0xdeposit",
				amount: "25.5",
				transactionHash: "0xtx",
			},
		});

		expect(JSON.parse(response.result)).toMatchObject({
			status: "unsupported",
			txid: "0xtx",
			expectedAmount: 25.5,
		});
	});

	test("rejects deposit observations with mismatched amount", async () => {
		const { exchange } = createTreasuryExchange({
			deposits: [
				{
					txid: "0xtx",
					amount: "24",
					address: "0xdeposit",
					status: "ok",
				},
			],
		});
		const rpc = await start(exchange);

		await expect(
			executeAction(rpc, {
				action: Action.Deposit,
				cex: "binance",
				symbol: "USDC",
				payload: {
					recipientAddress: "0xdeposit",
					amount: "25.5",
					transactionHash: "0xtx",
				},
			}),
		).rejects.toMatchObject({
			code: grpc.status.FAILED_PRECONDITION,
			details: "deposit_amount_mismatch: expected 25.5, observed 24",
		});
	});

	test("keeps pre-existing balance fetch action backward compatible", async () => {
		const { exchange, calls } = createTreasuryExchange({
			balances: { USDC: 42, ARB: 7 },
		});
		const rpc = await start(exchange);

		const response = await executeAction(rpc, {
			action: Action.FetchBalances,
			cex: "binance",
			symbol: "USDC",
		});

		expect(JSON.parse(response.result)).toEqual({
			balances: { USDC: 42 },
			balanceType: "total",
		});
		expect(calls.fetchTotalBalance[0]).toEqual([{ type: "spot" }]);
	});
});
