import { DEFAULT_STRATEGY_SPOOL_PATH } from "./strategy-spool";

export type ClickHouseConfig = {
	url: string;
	username: string;
	password: string;
	database: string;
};

export type ConfiguredProductionAuthorization = {
	authorizationId: string;
	scope: "production";
	environment: string;
	cluster: string;
	expiresAt: string;
};

export type ForwarderConfig = {
	port: number;
	authToken?: string;
	productionAuthorization?: ConfiguredProductionAuthorization;
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

function productionAuthorization(
	authToken: string | undefined,
): ConfiguredProductionAuthorization | undefined {
	const authorizationId =
		process.env.ARCHIVE_FORWARDER_AUTHORIZATION_ID?.trim();
	const expiresAt =
		process.env.ARCHIVE_FORWARDER_AUTHORIZATION_EXPIRES_AT?.trim();
	const environment = process.env.ARCHIVE_FORWARDER_ENVIRONMENT?.trim();
	const cluster = process.env.ARCHIVE_FORWARDER_CLUSTER?.trim();
	if (![authorizationId, expiresAt, environment, cluster].some(Boolean)) {
		return undefined;
	}
	const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
	if (
		!authToken ||
		!authorizationId ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			authorizationId,
		) ||
		!expiresAt ||
		!Number.isSafeInteger(expiresAtMs) ||
		new Date(expiresAtMs).toISOString() !== expiresAt ||
		!environment ||
		!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(environment) ||
		!cluster ||
		!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(cluster)
	) {
		throw new Error("Invalid production authorization configuration");
	}
	return {
		authorizationId,
		scope: "production",
		environment,
		cluster,
		expiresAt,
	};
}

export function loadForwarderConfig(): ForwarderConfig {
	const authToken = process.env.ARCHIVE_FORWARDER_TOKEN?.trim();
	return {
		port: parsePort(process.env.ARCHIVE_FORWARDER_PORT, 8090),
		authToken: authToken || undefined,
		productionAuthorization: productionAuthorization(authToken || undefined),
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
