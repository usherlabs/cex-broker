import type { Exchange } from "@usherlabs/ccxt";

export const ACCOUNTING_KINDS = [
	"all_orders",
	"my_trades",
	"withdrawals",
	"deposits",
	"sub_account_deposits",
	"account_snapshot",
	"account_info",
	"sub_account_assets",
	"universal_transfer",
	"sub_account_spot_transfer",
	"klines",
] as const;

export type AccountingKind = (typeof ACCOUNTING_KINDS)[number];

const BINANCE_ACCOUNTING_METHODS: Record<AccountingKind, string> = {
	all_orders: "privateGetAllOrders",
	my_trades: "privateGetMyTrades",
	withdrawals: "sapiGetCapitalWithdrawHistory",
	deposits: "sapiGetCapitalDepositHisrec",
	sub_account_deposits: "sapiGetCapitalDepositSubHisrec",
	account_snapshot: "sapiGetAccountSnapshot",
	account_info: "privateGetAccount",
	sub_account_assets: "sapiV4GetSubAccountAssets",
	universal_transfer: "sapiGetSubAccountUniversalTransfer",
	sub_account_spot_transfer: "sapiGetSubAccountSubTransferHistory",
	klines: "publicGetKlines",
};

export async function fetchAccountingData(args: {
	cex: string;
	broker: Exchange;
	kind: AccountingKind;
	params?: Record<string, unknown>;
}): Promise<unknown> {
	const cex = args.cex.trim().toLowerCase();
	if (cex !== "binance") {
		throw new Error(`Accounting action is not implemented for ${args.cex}`);
	}

	const methodName = BINANCE_ACCOUNTING_METHODS[args.kind];
	const method = (args.broker as unknown as Record<string, unknown>)[
		methodName
	];
	if (typeof method !== "function") {
		throw new Error(`Accounting method unavailable on ${cex}: ${methodName}`);
	}

	return await (
		method as (params: Record<string, unknown>) => Promise<unknown>
	).call(args.broker, compactParams(args.params ?? {}));
}

function compactParams(
	params: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(params).filter(([, value]) => value !== undefined),
	);
}
