import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { handleBatch } from "../src/handlers/execute-action/batch";
import type { ExecuteActionContext } from "../src/handlers/execute-action/context";
import { getActionDescriptor } from "../src/handlers/execute-action/registry";
import type { BrokerPoolEntry } from "../src/helpers";
import { Action } from "../src/helpers/constants";
import { log } from "../src/helpers/logger";
import type { OtelMetrics } from "../src/helpers/otel";
import { MAX_BATCH_REQUEST_BYTES } from "../src/schemas/action-payloads";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";
import { bindServer, executeAction, grpcObj } from "./order-telemetry-fixtures";

const testPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

const NON_BATCHABLE_ACTIONS = [
	Action.Deposit,
	Action.Withdraw,
	Action.CreateOrder,
	Action.GetOrderDetails,
	Action.CancelOrder,
	Action.FetchDepositAddresses,
	Action.Call,
	Action.InternalTransfer,
	Action.SetPerpConfigState,
	Action.Batch,
] as const;

type EvidenceCalls = {
	loadMarkets: unknown[][];
	fetchTradingFee: unknown[][];
	fetchCurrencies: unknown[][];
	fetchTicker: unknown[][];
	fetchAccountId: unknown[][];
	fetchPositions: unknown[][];
};

type EvidenceExchangeOptions = {
	accountId?: string;
	feeError?: Error;
	fees?: Record<string, Record<string, unknown>>;
	markets?: Record<string, Record<string, unknown>>;
	proofForSymbol?: Record<string, string>;
	supportsTradingFee?: boolean;
};

function createEvidenceExchange(options: EvidenceExchangeOptions = {}): {
	exchange: Exchange;
	calls: EvidenceCalls;
	setProofState: (state: { proof: string }) => void;
} {
	const calls: EvidenceCalls = {
		loadMarkets: [],
		fetchTradingFee: [],
		fetchCurrencies: [],
		fetchTicker: [],
		fetchAccountId: [],
		fetchPositions: [],
	};
	let proofState: { proof: string } | undefined;
	const markets: Record<string, Record<string, unknown>> = {
		"ARB/USDC": {
			id: "ARBUSDC",
			symbol: "ARB/USDC",
			base: "ARB",
			quote: "USDC",
			type: "spot",
			spot: true,
			active: true,
			precision: { price: 0.0001, amount: 0.01 },
			limits: {
				amount: { min: 0.1, max: 1_000_000 },
				price: {},
				cost: { min: 1 },
			},
		},
		"ARB/USDT": {
			id: "ARBUSDT",
			symbol: "ARB/USDT",
			base: "ARB",
			quote: "USDT",
			type: "spot",
			spot: true,
			active: true,
			precision: { price: 0.0001, amount: 0.01 },
			limits: {
				amount: { min: 0.1 },
				price: {},
				cost: { min: 1 },
			},
		},
	};
	const resolvedMarkets = options.markets ?? markets;
	const currencies = {
		USDC: {
			code: "USDC",
			networks: {
				BSC: {
					id: "BSC",
					network: "BSC",
					deposit: true,
					withdraw: true,
					fee: "0.25",
					limits: { withdraw: { min: "1", max: "50000" } },
				},
			},
		},
	};
	const record: Record<string, unknown> = {
		has: {
			fetchTradingFee: options.supportsTradingFee ?? true,
			fetchPositions: true,
		},
		precisionMode: 4,
		markets: resolvedMarkets,
		currencies,
		apiKey: "configured-api-key",
		secret: "configured-api-secret",
		loadMarkets: async (...args: unknown[]) => {
			calls.loadMarkets.push(args);
			return resolvedMarkets;
		},
		market: (symbol: string) => {
			const market = resolvedMarkets[symbol];
			if (!market) throw new Error(`unsupported market ${symbol}`);
			return market;
		},
		fetchTradingFee: async (...args: unknown[]) => {
			calls.fetchTradingFee.push(args);
			if (options.feeError) throw options.feeError;
			const symbol = String(args[0]);
			return (
				options.fees?.[symbol] ?? {
					symbol,
					maker: symbol === "ARB/USDT" ? "0.0001" : "0E-18",
					taker: "0.000500000000000000",
				}
			);
		},
		fetchCurrencies: async (...args: unknown[]) => {
			calls.fetchCurrencies.push(args);
			return currencies;
		},
		fetchTicker: async (...args: unknown[]) => {
			calls.fetchTicker.push(args);
			const symbol = String(args[0]);
			if (proofState && options.proofForSymbol?.[symbol]) {
				proofState.proof = options.proofForSymbol[symbol] ?? "";
			}
			return { symbol, last: symbol === "ARB/USDC" ? 1 : 2 };
		},
		fetchAccountId: async (...args: unknown[]) => {
			calls.fetchAccountId.push(args);
			return options.accountId ?? "primary-account";
		},
		fetchPositions: async (...args: unknown[]) => {
			calls.fetchPositions.push(args);
			return [{ symbol: "ARB/USDT", leverage: 2, marginMode: "cross" }];
		},
		setHttpClientOverride: () => {},
	};
	return {
		// SAFETY: the fixture implements every CCXT method exercised by these tests.
		exchange: record as unknown as Exchange,
		calls,
		setProofState: (state) => {
			proofState = state;
		},
	};
}

function createPool(
	primary: Exchange,
	secondary?: Exchange,
): Record<string, BrokerPoolEntry> {
	return {
		mexc: {
			primary: { exchange: primary, label: "primary" },
			secondaryBrokers: secondary
				? [{ exchange: secondary, label: "secondary:1", index: 1 }]
				: [],
		},
	};
}

function batchRequest(children: unknown[]) {
	return {
		action: Action.Batch,
		cex: "mexc",
		payload: { requests: JSON.stringify(children) },
	};
}

describe("read-only action batching", () => {
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	afterEach(async () => {
		client?.close();
		if (server) await server.forceShutdown();
	});

	async function start(
		pool: Record<string, BrokerPoolEntry>,
		otelMetrics?: OtelMetrics,
	) {
		server = getServer(testPolicy, pool, ["*"], false, "", otelMetrics);
		const port = await bindServer(server);
		client = new grpcObj.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);
		return client;
	}

	test("preserves ordered child results and exact per-pair commission calls", async () => {
		const { exchange, calls } = createEvidenceExchange();
		const rpc = await start(createPool(exchange));
		const response = await executeAction(
			rpc,
			batchRequest([
				{
					id: "fee-usdc",
					action: Action.FetchFees,
					symbol: "ARB/USDC",
					payload: {},
				},
				{
					id: "fee-usdt",
					action: Action.FetchFees,
					symbol: "ARB/USDT",
					payload: {},
				},
				{
					id: "rules-usdc",
					action: Action.FetchMarketRules,
					symbol: "ARB/USDC",
					payload: {},
				},
				{
					id: "network-usdc",
					action: Action.FetchCurrency,
					symbol: "USDC",
					payload: { network: "BEP20" },
				},
			]),
		);
		const envelope = JSON.parse(response.result);
		expect(response.proof).toBe("");
		expect(response.result).not.toContain("configured-api-key");
		expect(response.result).not.toContain("configured-api-secret");
		expect(envelope.schemaVersion).toBe("cex-broker-action-batch/v1");
		expect(envelope.responses.map((entry: { id: string }) => entry.id)).toEqual(
			["fee-usdc", "fee-usdt", "rules-usdc", "network-usdc"],
		);
		expect(calls.fetchTradingFee).toEqual([["ARB/USDC"], ["ARB/USDT"]]);
		const firstFee = JSON.parse(envelope.responses[0].response.result);
		const secondFee = JSON.parse(envelope.responses[1].response.result);
		expect(firstFee).toMatchObject({
			canonicalPair: "ARB-USDC",
			sourceSymbol: "ARBUSDC",
			makerBasisPoints: "0",
			takerBasisPoints: "5",
		});
		expect(secondFee).toMatchObject({
			canonicalPair: "ARB-USDT",
			sourceSymbol: "ARBUSDT",
			makerBasisPoints: "1",
			takerBasisPoints: "5",
		});
		expect(firstFee).not.toHaveProperty("effectiveFrom");
		expect(secondFee).not.toHaveProperty("effectiveUntil");
		const rules = JSON.parse(envelope.responses[2].response.result);
		expect(rules).toMatchObject({
			schemaVersion: "cex-market-rule-evidence/v1",
			canonicalPair: "ARB-USDC",
			unifiedSymbol: "ARB/USDC",
			sourceSymbol: "ARBUSDC",
			priceIncrement: "0.0001",
			amountIncrement: "0.01",
			minimumAmount: "0.1",
			minimumNotional: "1",
			maximumAmount: "1000000",
			accountSelector: "primary",
		});
		expect(rules).not.toHaveProperty("maximumNotional");
		const network = JSON.parse(envelope.responses[3].response.result);
		expect(network).toMatchObject({
			schemaVersion: "cex-transfer-network-evidence/v1",
			operatorNetworkAlias: "BEP20",
			withdrawalFee: "0.25",
			withdrawalLimits: { minimum: "1", maximum: "50000" },
		});
	});

	test("preserves unary payload semantics and result strings", async () => {
		const { exchange, calls } = createEvidenceExchange();
		const rpc = await start(createPool(exchange));
		const unary = await executeAction(rpc, {
			action: Action.FetchTicker,
			cex: "mexc",
			symbol: "ARB/USDC",
			payload: {},
		});
		const batched = await executeAction(
			rpc,
			batchRequest([
				{
					id: "ticker",
					action: Action.FetchTicker,
					symbol: "ARB/USDC",
					payload: {},
				},
				{
					id: "perp",
					action: Action.GetPerpConfigState,
					symbol: "",
					payload: { symbol: "ARB/USDT", params: "{}" },
				},
			]),
		);
		const envelope = JSON.parse(batched.result);
		expect(envelope.responses[0].response.result).toBe(unary.result);
		expect(calls.fetchPositions).toEqual([[["ARB/USDT"], {}]]);
	});

	test("prevalidates the complete batch before any provider call", async () => {
		const { exchange, calls } = createEvidenceExchange();
		const rpc = await start(createPool(exchange));
		const invalidBatches = [
			batchRequest([
				{
					id: "valid-first",
					action: Action.FetchTicker,
					symbol: "ARB/USDC",
					payload: {},
				},
				{
					id: "invalid-last",
					action: Action.FetchCurrency,
					symbol: "USDC",
					payload: {},
				},
			]),
			batchRequest([
				{
					id: "same",
					action: Action.FetchTicker,
					symbol: "ARB/USDC",
					payload: {},
				},
				{
					id: "same",
					action: Action.FetchTicker,
					symbol: "ARB/USDT",
					payload: {},
				},
			]),
			batchRequest([
				{ id: "nested", action: Action.Batch, symbol: "", payload: {} },
			]),
			batchRequest([
				{ id: "write", action: Action.Withdraw, symbol: "USDC", payload: {} },
			]),
			batchRequest([
				{
					id: "override",
					action: Action.GetPerpConfigState,
					symbol: "",
					payload: { params: '{"apiKey":"forbidden"}' },
				},
			]),
			batchRequest(
				Array.from({ length: 33 }, (_, index) => ({
					id: `item-${index}`,
					action: Action.FetchTicker,
					symbol: "ARB/USDC",
					payload: {},
				})),
			),
			{ action: Action.Batch, cex: "mexc", payload: { requests: "not-json" } },
			batchRequest([
				{
					id: "oversized-payload",
					action: Action.GetPerpConfigState,
					symbol: "",
					payload: { params: "x".repeat(MAX_BATCH_REQUEST_BYTES) },
				},
			]),
		];
		for (const request of invalidBatches) {
			await expect(executeAction(rpc, request)).rejects.toMatchObject({
				code: grpc.status.INVALID_ARGUMENT,
			});
		}
		for (const action of NON_BATCHABLE_ACTIONS) {
			await expect(
				executeAction(
					rpc,
					batchRequest([
						{ id: `forbidden-${action}`, action, symbol: "", payload: {} },
					]),
				),
			).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
		}
		expect(calls.fetchTicker).toHaveLength(0);
		expect(calls.fetchTradingFee).toHaveLength(0);
		expect(calls.fetchCurrencies).toHaveLength(0);
	});

	test("enforces the FetchFees hard cut and fail-closed source checks", async () => {
		const mismatch = createEvidenceExchange({
			fees: {
				"ARB/USDC": {
					symbol: "ARB/USDT",
					maker: "0",
					taker: "0.0005",
				},
			},
		});
		const rpc = await start(createPool(mismatch.exchange));
		await expect(
			executeAction(rpc, {
				action: Action.FetchFees,
				cex: "mexc",
				symbol: "USDC",
				payload: {},
			}),
		).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
		await expect(
			executeAction(rpc, {
				action: Action.FetchFees,
				cex: "mexc",
				symbol: "ARB/USDC",
				payload: { includeAllFees: "true" },
			}),
		).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
		expect(mismatch.calls.loadMarkets).toHaveLength(0);
		expect(mismatch.calls.fetchTradingFee).toHaveLength(0);

		await expect(
			executeAction(rpc, {
				action: Action.FetchFees,
				cex: "mexc",
				symbol: "ARB/USDC",
				payload: {},
			}),
		).rejects.toMatchObject({
			code: grpc.status.FAILED_PRECONDITION,
			details: expect.stringContaining("fee_unavailable:"),
		});
		expect(mismatch.calls.fetchTradingFee).toHaveLength(1);

		client?.close();
		await server?.forceShutdown();
		client = undefined;
		server = undefined;
		const unsupported = createEvidenceExchange({ supportsTradingFee: false });
		const unsupportedRpc = await start(createPool(unsupported.exchange));
		await expect(
			executeAction(unsupportedRpc, {
				action: Action.FetchFees,
				cex: "mexc",
				symbol: "ARB/USDC",
				payload: {},
			}),
		).rejects.toMatchObject({
			code: grpc.status.FAILED_PRECONDITION,
			details: expect.stringContaining("fee_unavailable:"),
		});
		expect(unsupported.calls.fetchTradingFee).toHaveLength(0);
	});

	test("redacts configured credential values from errors, logs, and telemetry", async () => {
		const { exchange } = createEvidenceExchange({
			feeError: new Error(
				"AuthenticationError: apiKey=configured-api-key secret=configured-api-secret",
			),
		});
		const metricCalls: unknown[][] = [];
		const metrics = {
			recordCounter: (...args: unknown[]) => metricCalls.push(args),
			recordHistogram: (...args: unknown[]) => metricCalls.push(args),
		};
		const logCalls: unknown[][] = [];
		const logSpy = spyOn(log, "error").mockImplementation(
			(...args: unknown[]) => {
				logCalls.push(args);
				return log;
			},
		);
		try {
			const rpc = await start(
				createPool(exchange),
				metrics as unknown as OtelMetrics,
			);
			const response = await executeAction(
				rpc,
				batchRequest([
					{
						id: "fee",
						action: Action.FetchFees,
						symbol: "ARB/USDC",
						payload: {},
					},
				]),
			);
			for (const retained of [response.result, logCalls, metricCalls]) {
				const serialized = JSON.stringify(retained);
				expect(serialized).not.toContain("configured-api-key");
				expect(serialized).not.toContain("configured-api-secret");
			}
			expect(response.result).toContain("[redacted]");
		} finally {
			logSpy.mockRestore();
		}
	});

	test("fails closed when required market-rule fields are absent", async () => {
		const { exchange, calls } = createEvidenceExchange({
			markets: {
				"ARB/USDC": {
					id: "ARBUSDC",
					symbol: "ARB/USDC",
					base: "ARB",
					quote: "USDC",
					type: "spot",
					spot: true,
					active: true,
					precision: { price: 0.0001, amount: 0.01 },
					limits: { amount: { min: 0.1 }, cost: {} },
				},
			},
		});
		const rpc = await start(createPool(exchange));
		await expect(
			executeAction(rpc, {
				action: Action.FetchMarketRules,
				cex: "mexc",
				symbol: "ARB/USDC",
				payload: {},
			}),
		).rejects.toMatchObject({
			code: grpc.status.UNIMPLEMENTED,
			details: expect.stringContaining("venue_discovery_unavailable:"),
		});
		expect(calls.loadMarkets).toHaveLength(1);
	});

	test("returns outer OK with unary-equivalent child errors and continues", async () => {
		const { exchange, calls } = createEvidenceExchange({
			fees: { "ARB/USDC": { maker: "0" } },
		});
		const rpc = await start(createPool(exchange));
		const response = await executeAction(
			rpc,
			batchRequest([
				{
					id: "fee",
					action: Action.FetchFees,
					symbol: "ARB/USDC",
					payload: {},
				},
				{
					id: "ticker",
					action: Action.FetchTicker,
					symbol: "ARB/USDT",
					payload: {},
				},
			]),
		);
		const envelope = JSON.parse(response.result);
		expect(envelope.responses[0]).toMatchObject({
			response: null,
			error: {
				code: "fee_unavailable",
				grpcStatus: grpc.status.FAILED_PRECONDITION,
			},
		});
		expect(envelope.responses[0].error.message).not.toContain(
			"configured-api-secret",
		);
		expect(envelope.responses[1].error).toBeNull();
		expect(calls.fetchTicker).toHaveLength(1);
	});

	test("uses one selected secondary broker for every child", async () => {
		const primary = createEvidenceExchange({ accountId: "primary-account" });
		const secondary = createEvidenceExchange({
			accountId: "secondary-account",
		});
		const rpc = await start(createPool(primary.exchange, secondary.exchange));
		const metadata = new grpc.Metadata();
		metadata.set("use-secondary-key", "1");
		const response = await executeAction(
			rpc,
			batchRequest([
				{
					id: "account",
					action: Action.FetchAccountId,
					symbol: "",
					payload: {},
				},
				{
					id: "fees",
					action: Action.FetchFees,
					symbol: "ARB/USDC",
					payload: {},
				},
			]),
			metadata,
		);
		const envelope = JSON.parse(response.result);
		expect(JSON.parse(envelope.responses[0].response.result)).toEqual({
			accountId: "secondary-account",
		});
		expect(JSON.parse(envelope.responses[1].response.result)).toMatchObject({
			accountSelector: "secondary:1",
			credentialSource: "configured_pool",
		});
		expect(primary.calls.fetchAccountId).toHaveLength(0);
		expect(primary.calls.fetchTradingFee).toHaveLength(0);
		expect(secondary.calls.fetchAccountId).toHaveLength(1);
		expect(secondary.calls.fetchTradingFee).toHaveLength(1);
	});

	test("isolates child proofs and completes the outer callback once", async () => {
		const fixture = createEvidenceExchange({
			proofForSymbol: { "ARB/USDC": "proof-usdc" },
		});
		const callbacks: Array<[unknown, unknown]> = [];
		const metadata = new grpc.Metadata();
		const request = batchRequest([
			{
				id: "first",
				action: Action.FetchTicker,
				symbol: "ARB/USDC",
				payload: {},
			},
			{
				id: "second",
				action: Action.FetchTicker,
				symbol: "ARB/USDT",
				payload: {},
			},
		]);
		const context = {
			call: { request, metadata },
			wrappedCallback: (error: unknown, value: unknown) => {
				callbacks.push([error, value]);
			},
			action: Action.Batch,
			policy: testPolicy,
			brokers: createPool(fixture.exchange),
			metadata,
			normalizedCex: "mexc",
			cex: "mexc",
			symbol: undefined,
			selectedBrokerAccount: {
				exchange: fixture.exchange,
				label: "primary",
			},
			broker: fixture.exchange,
			verity: { proof: "outer-proof-must-not-survive" },
			applyVerityToBroker: (_target: Exchange, proofState = { proof: "" }) =>
				fixture.setProofState(proofState),
			useVerity: true,
			verityProverUrl: "http://verity.invalid",
			withdrawalObservationTracker: undefined,
		} as unknown as ExecuteActionContext;

		await handleBatch(context, getActionDescriptor);

		expect(callbacks).toHaveLength(1);
		const response = callbacks[0]?.[1] as { result: string; proof: string };
		const envelope = JSON.parse(response.result);
		expect(response.proof).toBe("");
		expect(envelope.responses[0].response.proof).toBe("proof-usdc");
		expect(envelope.responses[1].response.proof).toBe("");
	});
});
