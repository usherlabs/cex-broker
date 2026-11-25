import ccxt, { type Exchange } from "ccxt";
import type { ExecuteActionContext } from "../src/handlers/execute-action/context";
import type { Action } from "../src/helpers/constants";
import type { PolicyConfig } from "../src/types";

export type CallbackError = { code?: number; message?: string };
export type CallbackResponse = { result?: string; proof?: string };

export const WHITELISTED_ADDRESS = "0x00000000000000000000000000000000000000a1";

export const BTC_USDT_MARKET = {
	id: "BTCUSDT",
	symbol: "BTC/USDT",
	base: "BTC",
	quote: "USDT",
	baseId: "BTC",
	quoteId: "USDT",
	type: "spot",
	spot: true,
	margin: false,
	swap: false,
	future: false,
	option: false,
	contract: false,
	active: true,
	precision: { amount: 0.0001, price: 0.01 },
	limits: {
		amount: { min: 0.001, max: 9000 },
		price: { min: 0.01, max: 1000000 },
		cost: { min: 5, max: 9000000 },
		leverage: { min: undefined, max: undefined },
	},
	info: {},
};

export const BTC_USDT_SWAP_MARKET = {
	...BTC_USDT_MARKET,
	id: "BTCUSDT_PERP",
	symbol: "BTC/USDT:USDT",
	settle: "USDT",
	settleId: "USDT",
	type: "swap",
	subType: "linear",
	spot: false,
	swap: true,
	contract: true,
	linear: true,
	inverse: false,
	contractSize: 1,
};

export function usdtCurrency() {
	return {
		USDT: {
			id: "USDT",
			code: "USDT",
			active: true,
			deposit: true,
			withdraw: true,
			networks: {
				BSC: {
					id: "BSC",
					network: "BSC",
					active: true,
					deposit: true,
					withdraw: true,
					fee: 0.29,
					limits: { withdraw: { min: 10, max: 1000000 } },
				},
				ETH: {
					id: "ETH",
					network: "ETH",
					active: false,
					deposit: false,
					withdraw: false,
					fee: 5,
					limits: { withdraw: { min: 20, max: undefined } },
				},
			},
		},
	};
}

export function testPolicy(
	overrides: Partial<PolicyConfig> = {},
): PolicyConfig {
	return {
		withdraw: {
			rule: [
				{
					exchange: "BINANCE",
					network: "BEP20",
					whitelist: [WHITELISTED_ADDRESS],
				},
				{
					exchange: "BINANCE",
					network: "ETH",
					whitelist: [WHITELISTED_ADDRESS],
				},
			],
		},
		deposit: {
			rule: [
				{ exchange: "BINANCE", network: "BEP20", coins: ["USDT"] },
				{ exchange: "BINANCE", network: "ETH", coins: ["USDT"] },
			],
		},
		order: { rule: { markets: ["BINANCE:BTC/USDT"], limits: [] } },
		...overrides,
	} as PolicyConfig;
}

export type SideEffectCalls = Record<
	"createOrder" | "withdraw" | "fetchDepositAddress" | "fetchOrder",
	unknown[][]
>;

/**
 * A real CCXT exchange instance (so features, precision and has flags are the
 * pinned CCXT's own) whose network-facing methods are replaced with local
 * doubles. It never opens a connection.
 */
export function createOfflineExchange(
	id: "binance" | "gate" | "mexc" = "binance",
	options: {
		markets?: Record<string, unknown>[];
		currencies?: Record<string, unknown>;
		createOrderResult?: unknown;
		fetchOrderResult?: unknown;
		loadMarketsError?: Error;
	} = {},
): { broker: Exchange; calls: SideEffectCalls } {
	const ExchangeClass = ccxt[id] as unknown as new () => Exchange;
	const broker = new ExchangeClass();
	const calls: SideEffectCalls = {
		createOrder: [],
		withdraw: [],
		fetchDepositAddress: [],
		fetchOrder: [],
	};
	const markets = options.markets ?? [BTC_USDT_MARKET];
	broker.setMarkets(markets as never);
	const mutable = broker as unknown as Record<string, unknown>;
	mutable.loadMarkets = async () => {
		if (options.loadMarketsError) {
			throw options.loadMarketsError;
		}
		return broker.markets;
	};
	mutable.fetchCurrencies = async () => options.currencies ?? usdtCurrency();
	mutable.createOrder = async (...args: unknown[]) => {
		calls.createOrder.push(args);
		return options.createOrderResult ?? { id: "order-1" };
	};
	mutable.fetchOrder = async (...args: unknown[]) => {
		calls.fetchOrder.push(args);
		return (
			options.fetchOrderResult ?? {
				id: "order-1",
				clientOrderId: "client-1",
				status: "closed",
				amount: 1,
				filled: 1,
				remaining: 0,
				symbol: "BTC/USDT",
				side: "sell",
				price: 30000,
			}
		);
	};
	mutable.withdraw = async (...args: unknown[]) => {
		calls.withdraw.push(args);
		return { id: "withdrawal-1" };
	};
	mutable.fetchDepositAddress = async (...args: unknown[]) => {
		calls.fetchDepositAddress.push(args);
		return { address: "0xdeposit" };
	};
	return { broker, calls };
}

export function createActionContext(
	action: Action,
	broker: Exchange,
	options: {
		payload?: Record<string, string>;
		symbol?: string;
		policy?: PolicyConfig;
		cex?: string;
	} = {},
) {
	let callbackError: CallbackError | null = null;
	let callbackResponse: CallbackResponse | null = null;
	let callbackCount = 0;
	const cex = options.cex ?? String(broker.id);
	const ctx = {
		action,
		call: {
			request: {
				action,
				cex,
				symbol: options.symbol ?? "",
				payload: options.payload ?? {},
			},
		},
		wrappedCallback: (
			error: CallbackError | null,
			response: CallbackResponse | null,
		) => {
			callbackCount += 1;
			callbackError = error;
			callbackResponse = response;
		},
		cex,
		normalizedCex: cex,
		symbol: options.symbol,
		broker,
		verity: { proof: "" },
		policy: options.policy ?? testPolicy(),
		brokers: {},
	} as unknown as ExecuteActionContext;
	return {
		ctx,
		getError: () => callbackError,
		getResponse: () => callbackResponse,
		getResult: () => JSON.parse(callbackResponse?.result ?? "null"),
		getCallbackCount: () => callbackCount,
	};
}
