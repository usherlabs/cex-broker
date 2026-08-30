import { DEFAULT_STRATEGY_SPOOL_PATH } from "./strategy-spool";

export type ClickHouseConfig = {
	url: string;
	username: string;
	password: string;
	database: string;
};

export type ForwarderConfig = {
	port: number;
	authToken?: string;
	spoolPath: string;
	clickhouse: ClickHouseConfig;
};

function parsePort(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadForwarderConfig(): ForwarderConfig {
	const authToken = process.env.ARCHIVE_FORWARDER_TOKEN?.trim();
	return {
		port: parsePort(process.env.ARCHIVE_FORWARDER_PORT, 8090),
		authToken: authToken || undefined,
		spoolPath:
			process.env.ARCHIVE_FORWARDER_SPOOL_PATH?.trim() ||
			DEFAULT_STRATEGY_SPOOL_PATH,
		clickhouse: {
			url: process.env.CLICKHOUSE_URL?.trim() || "http://localhost:8123",
			username: process.env.CLICKHOUSE_USER?.trim() || "default",
			password: process.env.CLICKHOUSE_PASSWORD ?? "",
			database: process.env.CLICKHOUSE_DATABASE?.trim() || "market_data",
		},
	};
}
