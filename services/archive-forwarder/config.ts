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
	marketSource?: "broker_read" | "broker_write";
	marketDeploymentId?: string;
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
	const rawMarketSource = process.env.ARCHIVE_FORWARDER_MARKET_SOURCE;
	const rawMarketDeploymentId =
		process.env.ARCHIVE_FORWARDER_MARKET_DEPLOYMENT_ID;
	const marketSource = rawMarketSource?.trim() || undefined;
	const marketDeploymentId = rawMarketDeploymentId?.trim() || undefined;
	if (
		(rawMarketSource !== undefined && marketSource === undefined) ||
		(rawMarketDeploymentId !== undefined && marketDeploymentId === undefined)
	) {
		throw new Error(
			"ARCHIVE_FORWARDER_MARKET_SOURCE and ARCHIVE_FORWARDER_MARKET_DEPLOYMENT_ID must be non-empty when configured",
		);
	}
	if (
		marketSource !== undefined &&
		marketSource !== "broker_read" &&
		marketSource !== "broker_write"
	) {
		throw new Error(
			"ARCHIVE_FORWARDER_MARKET_SOURCE must be broker_read or broker_write",
		);
	}
	if ((marketSource === undefined) !== (marketDeploymentId === undefined)) {
		throw new Error(
			"ARCHIVE_FORWARDER_MARKET_SOURCE and ARCHIVE_FORWARDER_MARKET_DEPLOYMENT_ID must be configured together",
		);
	}
	return {
		port: parsePort(process.env.ARCHIVE_FORWARDER_PORT, 8090),
		authToken: authToken || undefined,
		marketSource,
		marketDeploymentId,
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
