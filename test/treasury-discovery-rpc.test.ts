import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import {
	BrokerExecutionArchiver,
	WithdrawalObservationTracker,
} from "../src/helpers/broker-execution-archive";
import { Action } from "../src/helpers/constants";
import type { BrokerPoolEntry } from "../src/helpers/index";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";
import { startForwarderServer } from "./archive-forwarder-server";
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
	withdrawals?: Array<Record<string, unknown>>;
	depositWithdrawFees?: Record<string, unknown>;
	balances?: Record<string, number>;
};

function createTreasuryExchange(options: TreasuryExchangeOptions = {}) {
	const calls: Record<string, unknown[][]> = {
		fetchMarkets: [],
		loadMarkets: [],
		fetchCurrencies: [],
		fetchDeposits: [],
		fetchWithdrawals: [],
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
			fetchWithdrawals: true,
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
		fetchWithdrawals: async (...args: unknown[]) => {
			calls.fetchWithdrawals.push(args);
			return options.withdrawals ?? [];
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

describe("Treasury discovery and transfer observation RPC", () => {
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	afterEach(async () => {
		client?.close();
		if (server) {
			await server.forceShutdown();
		}
	});

	async function start(
		exchange: Exchange,
		policy = testPolicy,
		brokerArchiver?: BrokerExecutionArchiver,
		withdrawalObservationTracker?: WithdrawalObservationTracker,
	) {
		server = getServer(
			policy,
			createPool(exchange),
			["*"],
			false,
			"",
			undefined,
			brokerArchiver,
			undefined,
			withdrawalObservationTracker,
		);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);
		return client;
	}

	test("archives evolving fetchWithdrawals venue observations without changing the RPC result", async () => {
		const forwarder = await startForwarderServer();
		const withdrawals = [
			{
				id: "wd-1",
				txid: "tx-1",
				currency: "USDC",
				status: "pending",
				amount: 12.5,
				address: "0xrecipient",
				network: "ARBITRUM",
				fee: { cost: 0, currency: "USDC" },
				datetime: "2026-07-01T00:00:00.000Z",
				info: { amount: "12.50000000", completeTime: "" },
			},
			{
				id: "wd-2",
				txid: "tx-2",
				currency: "ETH",
				status: "ok",
				amount: "1.25",
				fee: { cost: "0.005", currency: "ETH" },
			},
		];
		const options = { withdrawals };
		const { exchange, calls } = createTreasuryExchange(options);
		(
			exchange as unknown as Record<
				string,
				(...args: unknown[]) => Promise<unknown>
			>
		).fetchWithdrawalsHistory = async () => [
			{ id: "not-an-exact-fetch-withdrawals-call", currency: "USDC" },
		];
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deploymentId: "test-deploy",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		const tracker = new WithdrawalObservationTracker();

		try {
			const rpc = await start(exchange, testPolicy, archiver, tracker);
			const request = {
				action: Action.Call,
				cex: "binance",
				payload: {
					functionName: "fetchWithdrawals",
					args: '["USDC", 1700000000000]',
					params: '{"limit": 50}',
				},
			};

			const initial = await executeAction(rpc, request);
			expect(JSON.parse(initial.result)).toEqual(withdrawals);
			expect(calls.fetchWithdrawals[0]).toEqual([
				"USDC",
				1700000000000,
				{ limit: 50 },
			]);
			await Promise.resolve();
			await archiver.flush();

			const initialRows = forwarder.requests.flatMap(
				(post) => post.body.rows ?? [],
			) as Array<{ table: string; row: Record<string, unknown> }>;
			expect(initialRows).toHaveLength(2);
			expect(initialRows[0]).toMatchObject({
				table: "broker_execution.transfer_events",
				row: {
					schema_version: "1",
					event_kind: "withdrawal",
					lifecycle_action: "observe_withdrawal",
					exchange: "binance",
					account_selector: "primary",
					asset_symbol: "USDC",
					external_id: "wd-1",
					txid: "tx-1",
					status: "pending",
					amount: "12.50000000",
					fee_amount: "0",
					fee_currency: "USDC",
					address: "0xrecipient",
					network: "ARBITRUM",
					exchange_timestamp: "2026-07-01T00:00:00.000Z",
					result_index: 0,
				},
			});
			expect(initialRows[0]?.row.payload_json).toBe(
				JSON.stringify(withdrawals[0]),
			);
			expect(initialRows[1]?.row).toMatchObject({
				asset_symbol: "ETH",
				external_id: "wd-2",
				txid: "tx-2",
				fee_amount: "0.005",
				fee_currency: "ETH",
				result_index: 1,
			});

			const nonExact = await executeAction(rpc, {
				...request,
				payload: {
					functionName: "fetchWithdrawalsHistory",
					args: "[]",
					params: "{}",
				},
			});
			expect(JSON.parse(nonExact.result)).toEqual([
				{ id: "not-an-exact-fetch-withdrawals-call", currency: "USDC" },
			]);
			expect(tracker.getSize()).toBe(2);

			await executeAction(rpc, request);
			await Promise.resolve();
			expect(archiver.getQueueDepth()).toBe(0);

			withdrawals[0] = {
				...withdrawals[0],
				status: "ok",
				txid: "tx-1-final",
				info: {
					amount: "12.50000000",
					completeTime: "2026-07-01T00:05:00.000Z",
				},
			};
			await executeAction(rpc, request);
			await Promise.resolve();
			await archiver.flush();

			const allRows = forwarder.requests.flatMap(
				(post) => post.body.rows ?? [],
			) as Array<{ row: Record<string, unknown> }>;
			expect(allRows).toHaveLength(3);
			expect(allRows[2]?.row).toMatchObject({
				external_id: "wd-1",
				txid: "tx-1-final",
				status: "ok",
				result_index: 0,
			});
		} finally {
			await archiver.close();
			await forwarder.close();
		}
	});

	test("keeps fetchWithdrawals successful and the tracker empty when archiving is disabled", async () => {
		const withdrawals = [{ id: "wd-1", currency: "USDC", status: "pending" }];
		const { exchange } = createTreasuryExchange({ withdrawals });
		const tracker = new WithdrawalObservationTracker();
		const rpc = await start(
			exchange,
			testPolicy,
			BrokerExecutionArchiver.disabled(),
			tracker,
		);

		const response = await executeAction(rpc, {
			action: Action.Call,
			cex: "binance",
			payload: { functionName: "fetchWithdrawals", args: "[]", params: "{}" },
		});

		expect(JSON.parse(response.result)).toEqual(withdrawals);
		expect(tracker.getSize()).toBe(0);
	});

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

	test("allows callable treasury methods when capability metadata is missing", async () => {
		const { exchange, calls } = createTreasuryExchange();
		const rpc = await start(exchange);

		const response = await executeAction(rpc, {
			action: Action.Call,
			cex: "binance",
			payload: { functionName: "fetchTotalBalance", args: "[]", params: "{}" },
		});

		expect(JSON.parse(response.result)).toEqual({ USDC: 42 });
		expect(calls.fetchTotalBalance).toHaveLength(1);
	});

	test("rejects callable treasury methods when capability is explicitly false", async () => {
		const { exchange, calls } = createTreasuryExchange({
			has: { fetchTotalBalance: false },
		});
		const rpc = await start(exchange);

		await expect(
			executeAction(rpc, {
				action: Action.Call,
				cex: "binance",
				payload: {
					functionName: "fetchTotalBalance",
					args: "[]",
					params: "{}",
				},
			}),
		).rejects.toMatchObject({
			code: grpc.status.INVALID_ARGUMENT,
		});
		expect(calls.fetchTotalBalance).toHaveLength(0);
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

	test("rejects deposit observations with mismatched address", async () => {
		const { exchange } = createTreasuryExchange({
			deposits: [
				{
					txid: "0xtx",
					amount: "25.5",
					address: "0xother",
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
			details:
				"deposit_address_mismatch: expected address 0xdeposit, observed 0xother",
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
