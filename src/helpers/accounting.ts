import ccxt, { type Exchange } from "@usherlabs/ccxt";

export const ACCOUNTING_KINDS = [
	"orders",
	"open_orders",
	"closed_orders",
	"trades",
	"deposits",
	"withdrawals",
	"transfers",
	"ledger",
	"balances",
	"ohlcv",
] as const;

export type AccountingKind = (typeof ACCOUNTING_KINDS)[number];

type AccountingMethod =
	| "fetchOrders"
	| "fetchOpenOrders"
	| "fetchClosedOrders"
	| "fetchMyTrades"
	| "fetchDeposits"
	| "fetchWithdrawals"
	| "fetchTransfers"
	| "fetchLedger"
	| "fetchBalance"
	| "fetchOHLCV";

const ACCOUNTING_METHODS: Record<AccountingKind, AccountingMethod> = {
	orders: "fetchOrders",
	open_orders: "fetchOpenOrders",
	closed_orders: "fetchClosedOrders",
	trades: "fetchMyTrades",
	deposits: "fetchDeposits",
	withdrawals: "fetchWithdrawals",
	transfers: "fetchTransfers",
	ledger: "fetchLedger",
	balances: "fetchBalance",
	ohlcv: "fetchOHLCV",
};

export async function fetchAccountingData(args: {
	cex: string;
	broker: Exchange;
	kind: AccountingKind;
	symbol?: string;
	code?: string;
	since?: number;
	limit?: number;
	timeframe?: string;
	params?: Record<string, unknown>;
}): Promise<unknown> {
	const methodName = ACCOUNTING_METHODS[args.kind];
	assertAccountingCapability(args.cex, args.broker, methodName);
	const method = (args.broker as unknown as Record<string, unknown>)[
		methodName
	];
	if (typeof method !== "function") {
		throw new ccxt.NotSupported(
			`${args.cex} does not expose ${methodName} in this CCXT build`,
		);
	}

	const params = compactParams(args.params ?? {});
	switch (args.kind) {
		case "orders":
		case "open_orders":
		case "closed_orders":
		case "trades":
			return await callAccountingMethod(method, args.broker, [
				args.symbol,
				args.since,
				args.limit,
				params,
			]);
		case "deposits":
		case "withdrawals":
		case "transfers":
		case "ledger":
			return await callAccountingMethod(method, args.broker, [
				args.code,
				args.since,
				args.limit,
				params,
			]);
		case "balances":
			return await callAccountingMethod(method, args.broker, [params]);
		case "ohlcv": {
			const symbol = requireAccountingString(args.symbol, "symbol", args.kind);
			return await callAccountingMethod(method, args.broker, [
				symbol,
				args.timeframe ?? "1m",
				args.since,
				args.limit,
				params,
			]);
		}
	}
}

function assertAccountingCapability(
	cex: string,
	broker: Exchange,
	methodName: AccountingMethod,
): void {
	const has =
		(broker as unknown as { has?: Record<string, unknown> }).has ?? {};
	if (!has[methodName]) {
		throw new ccxt.NotSupported(
			`${cex} does not support ${methodName} through CCXT`,
		);
	}
}

async function callAccountingMethod(
	method: unknown,
	broker: Exchange,
	args: unknown[],
): Promise<unknown> {
	return await (method as (...args: unknown[]) => Promise<unknown>).apply(
		broker,
		args,
	);
}

function requireAccountingString(
	value: string | undefined,
	field: string,
	kind: AccountingKind,
): string {
	if (value && value.trim().length > 0) {
		return value;
	}
	throw new ccxt.BadRequest(`FetchAccounting ${kind} requires ${field}`);
}

function compactParams(
	params: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(params).filter(([, value]) => value !== undefined),
	);
}
