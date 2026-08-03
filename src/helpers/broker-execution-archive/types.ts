export const BROKER_READ_SOURCE = "broker_read" as const;
export const BROKER_WRITE_SOURCE = "broker_write" as const;
export type BrokerArchiveSource =
	| typeof BROKER_READ_SOURCE
	| typeof BROKER_WRITE_SOURCE;

// Bumped only on a breaking broker archive column-shape change. Stamped onto
// transfer, fill, and account-balance rows so a reader can identify their layout.
export const ARCHIVE_SCHEMA_VERSION = "1" as const;

export type BrokerArchiveTable =
	| "broker_execution.order_events"
	| "broker_execution.market_metadata_snapshots"
	| "broker_execution.transfer_events"
	| "broker_execution.fill_events"
	| "broker_account.balance_snapshots"
	| "market_data.orderbook_snapshots"
	| "market_data.candles"
	| "market_data.cex_stream_events"
	| "market_data.cex_ticker_events"
	| "market_data.cex_trades"
	| "market_data.cex_ohlcv"
	| "market_data.cex_order_book_levels"
	| "market_data.cex_order_book_depth_summary";

export type BrokerArchiveRow = {
	table: BrokerArchiveTable;
	row: Record<string, unknown>;
};

export type BrokerArchiveCommonTags = {
	source: BrokerArchiveSource;
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

// A CEX value movement between accounts/wallets (as opposed to an order fill).
// Values match the fiet-maker CEX_EXECUTION_ARCHIVE_CONTRACT transfer_events grain.
export type TransferEventKind = "withdrawal" | "deposit" | "internal_transfer";

// Which movement lifecycle step produced the row (contract `lifecycle_action`).
export type TransferLifecycleAction =
	| "submit_withdrawal"
	| "observe_withdrawal"
	| "observe_deposit"
	| "submit_internal_transfer";

// fill_events.event_kind. The contract fixture uses "create_order_fill" for fills
// exploded from a createOrder result; our producer is the trade-history poller
// (createOrder results carry no trades[] on the venues in use — see WS2.2), so we
// stamp the true source here. Same column, honest provenance value.
export const FILL_EVENT_KIND = "trade_history_fill" as const;

export const ACCOUNT_BALANCE_SCOPE = "spot" as const;
export const ACCOUNT_BALANCE_PRECISION_BASIS =
	"ccxt_normalized_number" as const;
