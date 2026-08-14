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
});
