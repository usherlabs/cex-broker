import * as grpc from "@grpc/grpc-js";
import {
	Action,
	type Action as ActionType,
	SubscriptionType,
	type SubscriptionType as SubscriptionTypeValue,
} from "./constants";
import { ORDER_BOOK_CALL_METHODS } from "./order-book";

export type BrokerSurface = {
	readEnabled: boolean;
	writeEnabled: boolean;
};

export const DEFAULT_BROKER_SURFACE: BrokerSurface = {
	readEnabled: true,
	writeEnabled: true,
};

export type BrokerAccessClass = "read" | "write";

const WRITE_ACTIONS = new Set<ActionType>([
	Action.Deposit,
	Action.Withdraw,
	Action.CreateOrder,
	Action.CancelOrder,
	Action.InternalTransfer,
	Action.SetPerpConfigState,
]);

/** Fetch-style ExecuteAction values; require `readEnabled`. */
const READ_ACTIONS = new Set<ActionType>([
	Action.GetOrderDetails,
	Action.FetchBalances,
	Action.FetchDepositAddresses,
	Action.FetchTicker,
	Action.FetchCurrency,
	Action.FetchAccountId,
	Action.FetchFees,
	Action.GetPerpConfigState,
]);

const WRITE_SUBSCRIPTION_TYPES = new Set<SubscriptionTypeValue>([
	SubscriptionType.BALANCE,
	SubscriptionType.ORDERS,
]);

const ORDER_BOOK_CALL_METHOD_VALUES = new Set<string>(
	Object.values(ORDER_BOOK_CALL_METHODS),
);

const READ_CCXT_PREFIXES = [
	"fetch",
	"get",
	"load",
	"watch",
	"has",
	"parse",
	"check",
	"calculate",
	"convert",
	"iso",
	"ymd",
	"milliseconds",
	"seconds",
	"nonce",
	"uuid",
	"urlencode",
	"urlencodeBase64",
	"handle",
	"sleep",
] as const;

const WRITE_CCXT_PREFIXES = [
	"create",
	"cancel",
	"edit",
	"withdraw",
	"deposit",
	"transfer",
	"set",
	"close",
	"reduce",
	"amend",
	"repay",
	"borrow",
	"add",
	"remove",
	"position",
	"leverage",
	"margin",
	"liquidate",
	"post",
] as const;

function parseEnvFlag(
	value: string | undefined,
	defaultValue: boolean,
): boolean {
	if (value === undefined || value.trim() === "") {
		return defaultValue;
	}
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["false", "0", "no", "off"].includes(normalized)) {
		return false;
	}
	return defaultValue;
}

export function resolveBrokerSurfaceFromEnv(): BrokerSurface {
	return {
		readEnabled: parseEnvFlag(process.env.CEX_BROKER_READ_ENABLED, true),
		writeEnabled: parseEnvFlag(process.env.CEX_BROKER_WRITE_ENABLED, true),
	};
}

export function validateBrokerSurface(surface: BrokerSurface): void {
	if (!surface.readEnabled && !surface.writeEnabled) {
		throw new Error(
			"At least one broker surface must be enabled (read and/or write)",
		);
	}
}

export function classifyAction(action: ActionType): BrokerAccessClass | "call" {
	if (action === Action.Call) {
		return "call";
	}
	if (WRITE_ACTIONS.has(action)) {
		return "write";
	}
	if (READ_ACTIONS.has(action)) {
		return "read";
	}
	// Fail closed: unlisted actions are treated as write.
	return "write";
}

export function classifySubscription(
	subscriptionType: SubscriptionTypeValue,
): BrokerAccessClass {
	return WRITE_SUBSCRIPTION_TYPES.has(subscriptionType) ? "write" : "read";
}

export function classifyCcxtMethod(
	functionName: string,
): BrokerAccessClass | "unknown" {
	const normalized = functionName.trim();
	if (!normalized) {
		return "unknown";
	}
	if (ORDER_BOOK_CALL_METHOD_VALUES.has(normalized)) {
		return "read";
	}
	const lower = normalized.toLowerCase();
	if (READ_CCXT_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
		return "read";
	}
	if (WRITE_CCXT_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
		return "write";
	}
	return "unknown";
}

export function isBrokerAccessAllowed(
	surface: BrokerSurface,
	access: BrokerAccessClass | "unknown",
): boolean {
	if (access === "read") {
		return surface.readEnabled;
	}
	if (access === "write") {
		return surface.writeEnabled;
	}
	// Unclassified CCXT calls are only allowed on full brokers.
	return surface.readEnabled && surface.writeEnabled;
}

export function isWriteSurfaceEnabled(surface: BrokerSurface): boolean {
	return surface.writeEnabled;
}

export function isReadSurfaceEnabled(surface: BrokerSurface): boolean {
	return surface.readEnabled;
}

export function buildBrokerSurfaceDeniedError(
	access: BrokerAccessClass | "unknown",
): grpc.ServiceError {
	const surface = access === "write" || access === "unknown" ? "write" : "read";
	return {
		code: grpc.status.FAILED_PRECONDITION,
		message: `${surface === "write" ? "Write" : "Read"} operations are disabled on this broker deployment`,
	};
}
