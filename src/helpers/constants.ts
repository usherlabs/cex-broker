export const CCXT_METHODS_WITH_VERITY = [
	"fetchBalance",
	"fetchDepositAddress",
	"fetchDepositAddress",
	"fetchDepositAddresses",
	"fetchDepositAddressesByNetwork",
	"fetchDeposits",
	"withdraw",
	"fetchFundingHistory",
	"fetchWithdrawals",
	"fetchWithdrawal",
	"fetchAccountId",
];

// Keep these values in sync with src/proto/node.proto.
export const Action = {
	NoAction: 0,
	Deposit: 1,
	Withdraw: 2,
	CreateOrder: 3,
	GetOrderDetails: 4,
	CancelOrder: 5,
	FetchBalances: 6,
	FetchDepositAddresses: 7,
	FetchTicker: 8,
	FetchCurrency: 9,
	Call: 10,
	FetchAccountId: 11,
	FetchFees: 12,
	InternalTransfer: 13,
} as const;

export const SubscriptionType = {
	NO_ACTION: 0,
	ORDERBOOK: 1,
	TRADES: 2,
	TICKER: 3,
	OHLCV: 4,
	BALANCE: 5,
	ORDERS: 6,
} as const;

export type Action = (typeof Action)[keyof typeof Action];
export type SubscriptionType =
	(typeof SubscriptionType)[keyof typeof SubscriptionType];

function createEnumNameMap<T extends Record<string, number>>(
	enumValues: T,
): Record<number, string> {
	return Object.fromEntries(
		Object.entries(enumValues).map(([name, value]) => [value, name]),
	);
}

const actionNames = createEnumNameMap(Action);
const subscriptionTypeNames = createEnumNameMap(SubscriptionType);

export function getActionName(action: unknown): string {
	return typeof action === "number"
		? actionNames[action] ?? `unknown_${action}`
		: `unknown_${action ?? "undefined"}`;
}

export function getSubscriptionTypeName(subscriptionType: number): string {
	return subscriptionTypeNames[subscriptionType] ?? `unknown_${subscriptionType}`;
}

export function resolveSubscriptionType(
	type: SubscriptionType | undefined,
): SubscriptionType {
	return type === undefined || type === SubscriptionType.NO_ACTION
		? SubscriptionType.ORDERBOOK
		: type;
}
