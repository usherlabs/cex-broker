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
		expect(Object.keys(loadForwarderConfig())).not.toContain(
			"productionAuthorization",
		);
	});

	test("binds market admission to one deployment-owned broker identity", () => {
		process.env.ARCHIVE_FORWARDER_MARKET_SOURCE = "broker_read";
		process.env.ARCHIVE_FORWARDER_MARKET_DEPLOYMENT_ID = "market-reader-eu-1";
		expect(loadForwarderConfig()).toMatchObject({
			marketSource: "broker_read",
			marketDeploymentId: "market-reader-eu-1",
		});
		delete process.env.ARCHIVE_FORWARDER_MARKET_DEPLOYMENT_ID;
		expect(() => loadForwarderConfig()).toThrow("configured together");
		process.env.ARCHIVE_FORWARDER_MARKET_DEPLOYMENT_ID = "   ";
		expect(() => loadForwarderConfig()).toThrow("must be non-empty");
		process.env.ARCHIVE_FORWARDER_MARKET_DEPLOYMENT_ID = "market-reader-eu-1";
		process.env.ARCHIVE_FORWARDER_MARKET_SOURCE = "   ";
		expect(() => loadForwarderConfig()).toThrow("must be non-empty");
		process.env.ARCHIVE_FORWARDER_MARKET_SOURCE = "external_backfill";
		expect(() => loadForwarderConfig()).toThrow("broker_read or broker_write");
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
