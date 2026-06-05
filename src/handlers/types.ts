import type {
	ActionName,
	Action as ActionType,
	SubscriptionTypeName,
	SubscriptionType as SubscriptionTypeValue,
} from "../helpers/constants";

export type ActionRequest = {
	action?: ActionType | ActionName;
	payload?: Record<string, string>;
	cex?: string;
	symbol?: string;
};

export type ActionResponse = {
	result: string;
	proof?: string;
};

export type SubscribeRequest = {
	cex?: string;
	symbol?: string;
	type?: SubscriptionTypeValue | SubscriptionTypeName;
	options?: Record<string, string>;
};

export type SubscribeResponse = {
	data: string;
	timestamp: number;
	symbol: string;
	type: SubscriptionTypeValue;
};
