export const BROKER_WRITE_SOURCE = "broker_write" as const;

export type BrokerArchiveTable =
	| "broker_execution.order_events"
	| "broker_execution.market_metadata_snapshots"
	| "market_data.orderbook_snapshots"
	| "market_data.candles"
	| "market_data.cex_stream_events"
	| "market_data.cex_ticker_events"
	| "market_data.cex_trades";

export type BrokerArchiveRow = {
	table: BrokerArchiveTable;
	row: Record<string, unknown>;
};

export type BrokerArchiveCommonTags = {
	source: typeof BROKER_WRITE_SOURCE;
	deployment_id: string;
	account_selector: string;
	exchange: string;
	symbol: string;
	broker_observed_timestamp: string;
};

export type OrderArchiveAction =
	| "CreateOrder"
	| "CancelOrder"
	| "GetOrderDetails";

export type SubscribeArchiveType = "ORDERS" | "BALANCE";
