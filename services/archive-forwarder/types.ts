export type ArchiveRow = {
	table: string;
	row: Record<string, unknown>;
};

export type ArchiveBatchRequest = {
	source: string;
	deployment_id: string;
	rows: ArchiveRow[];
};

export type ArchiveBatchResult = {
	inserted: number;
	skipped: number;
	failed: number;
	byTable: Record<string, number>;
	failedTables: string[];
};

export const SUPPORTED_TABLES = [
	"market_data.candles",
	"market_data.orderbook_snapshots",
	"market_data.cex_stream_events",
	"market_data.cex_ticker_events",
	"market_data.cex_trades",
	"broker_execution.order_events",
	"broker_execution.market_metadata_snapshots",
	"strategy_data.policy_evaluation_events",
	"strategy_data.strategy_policy_snapshots",
	"strategy_data.inventory_settlement_events",
] as const;

export type SupportedTable = (typeof SUPPORTED_TABLES)[number];

export function isSupportedTable(table: string): table is SupportedTable {
	return (SUPPORTED_TABLES as readonly string[]).includes(table);
}
