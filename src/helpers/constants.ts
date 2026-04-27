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
export type ActionName = keyof typeof Action;
export type SubscriptionType =
	(typeof SubscriptionType)[keyof typeof SubscriptionType];
export type SubscriptionTypeName = keyof typeof SubscriptionType;

function resolveEnumValue<T extends Record<string, number>>(
	enumValues: T,
	value: T[keyof T] | keyof T | undefined,
): T[keyof T] | undefined {
	if (typeof value === "number") {
		return value as T[keyof T];
	}
	if (typeof value === "string" && value in enumValues) {
		return enumValues[value] as T[keyof T];
	}
	return undefined;
}

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
	if (typeof action === "string" && action in Action) {
		return action;
	}
	return typeof action === "number"
		? (actionNames[action] ?? `unknown_${action}`)
		: `unknown_${action ?? "undefined"}`;
}

export function getSubscriptionTypeName(subscriptionType: unknown): string {
	if (
		typeof subscriptionType === "string" &&
		subscriptionType in SubscriptionType
	) {
		return subscriptionType;
	}
	return typeof subscriptionType === "number"
		? (subscriptionTypeNames[subscriptionType] ?? `unknown_${subscriptionType}`)
		: `unknown_${subscriptionType ?? "undefined"}`;
}

export function resolveAction(
	action: Action | ActionName | undefined,
): Action | undefined {
	return resolveEnumValue(Action, action);
}

export function resolveSubscriptionType(
	type: SubscriptionType | SubscriptionTypeName | undefined,
): SubscriptionType {
	const resolvedType = resolveEnumValue(SubscriptionType, type);
	return resolvedType === undefined ||
		resolvedType === SubscriptionType.NO_ACTION
		? SubscriptionType.ORDERBOOK
		: resolvedType;
}
