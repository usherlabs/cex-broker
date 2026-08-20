import { afterEach, describe, expect, test } from "bun:test";
import { loadForwarderConfig } from "../services/archive-forwarder/config";
import { DEFAULT_STRATEGY_SPOOL_PATH } from "../services/archive-forwarder/strategy-spool";

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

describe("archive forwarder spool configuration", () => {
	test("uses the documented local fallback", () => {
		delete process.env.ARCHIVE_FORWARDER_SPOOL_PATH;
		expect(loadForwarderConfig().spoolPath).toBe(DEFAULT_STRATEGY_SPOOL_PATH);
	});

	test("accepts only the forwarder-specific persistent path knob", () => {
		process.env.ARCHIVE_FORWARDER_SPOOL_PATH =
			"/var/lib/archive-forwarder/spool.sqlite";
		expect(loadForwarderConfig().spoolPath).toBe(
			"/var/lib/archive-forwarder/spool.sqlite",
		);
		expect(Object.keys(loadForwarderConfig())).not.toContain("spoolQuotaBytes");
		expect(Object.keys(loadForwarderConfig())).not.toContain(
			"spoolRetentionMs",
		);
	});

	test("loads a complete production-scoped backfill authorization", () => {
		process.env.ARCHIVE_FORWARDER_TOKEN = "production-secret";
		process.env.ARCHIVE_FORWARDER_AUTHORIZATION_ID =
			"00000000-0000-4000-8000-000000000000";
		process.env.ARCHIVE_FORWARDER_AUTHORIZATION_EXPIRES_AT =
			"2026-08-21T12:00:00.000Z";
		process.env.ARCHIVE_FORWARDER_ENVIRONMENT = "production";
		process.env.ARCHIVE_FORWARDER_CLUSTER = "cex-archive-primary";
		expect(loadForwarderConfig().productionAuthorization).toEqual({
			authorizationId: "00000000-0000-4000-8000-000000000000",
			scope: "production",
			environment: "production",
			cluster: "cex-archive-primary",
			expiresAt: "2026-08-21T12:00:00.000Z",
		});
	});

	test("disables absent authorization and rejects partial or malformed configuration", () => {
		for (const key of [
			"ARCHIVE_FORWARDER_TOKEN",
			"ARCHIVE_FORWARDER_AUTHORIZATION_ID",
			"ARCHIVE_FORWARDER_AUTHORIZATION_EXPIRES_AT",
			"ARCHIVE_FORWARDER_ENVIRONMENT",
			"ARCHIVE_FORWARDER_CLUSTER",
		]) {
			delete process.env[key];
		}
		expect(loadForwarderConfig().productionAuthorization).toBeUndefined();
		process.env.ARCHIVE_FORWARDER_AUTHORIZATION_ID = "not-a-uuid";
		expect(() => loadForwarderConfig()).toThrow(
			"production authorization configuration",
		);
	});
});

describe("archive forwarder ClickHouse configuration", () => {
	test("uses the local HTTP endpoint by default", () => {
		delete process.env.CLICKHOUSE_URL;
		expect(loadForwarderConfig().clickhouse.url).toBe("http://localhost:8123");
	});

	test("preserves a managed HTTPS endpoint", () => {
		process.env.CLICKHOUSE_URL =
			"https://example.germanywestcentral.azure.clickhouse.cloud:8443";
		expect(loadForwarderConfig().clickhouse.url).toBe(
			"https://example.germanywestcentral.azure.clickhouse.cloud:8443",
		);
	});
});
