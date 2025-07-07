// Policy types based on the policy.json structure
export type WithdrawRule = {
	networks: string[];
	whitelist: string[];
	amounts: {
		ticker: string;
		max: number;
		min: number;
	}[];
};

export type OrderRule = {
	markets: string[];
	limits: Array<{
		from: string;
		to: string;
		min: number;
		max: number;
	}>;
};

export type PolicyConfig = {
	withdraw: {
		rule: WithdrawRule;
	};
	deposit: Record<string, null>;
	order: {
		rule: OrderRule;
	};
};

// Legacy types (keeping for backward compatibility)
export type Policy = {
	isActive: boolean;
	permissions: Array<"withdraw" | "transfer" | "convert">;
	limits: {
		dailyWithdrawLimit?: number;
		dailyTransferredAmount?: number;
		perTxTransferLimit?: number;
	};
	networks: string[];
	conversionLimits: Array<{
		from: string;
		to: string;
		min: number;
		max: number;
	}>;
};

export type Policies = {
	[apiKey: string]: Policy; // key is an Ethereum-style address like '0x...'
};

// TODO: Why are Bybit and Binance so tightly integrated into this? Should we not simply have a dynamic conversion between CCXT interface and this node?
// TODO: Otheriwse, we'll need to setup every integration supported by CCXT indidivually inside of this node?
// TODO: Rename "broker" to "cexs" or "exchanges"...
// ? The Node itself is a broker. The destination of requests is the CEX...
export const BrokerList = ["BINANCE", "BYBIT"] as const;

export type ISupportedBroker = (typeof BrokerList)[number];

export const SupportedBroker = BrokerList.reduce(
	(acc, value) => {
		acc[value] = value;
		return acc;
	},
	{} as Record<(typeof BrokerList)[number], string>,
);
