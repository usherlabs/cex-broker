import { describe, expect, test } from "bun:test";
import { evaluateForwarderHealth } from "../services/archive-forwarder/health";

const spoolStats = {
	queuedBatches: 2,
	queuedWork: 3,
	terminalWork: 1,
	expiredWork: 4,
	accountedBytes: 12_345,
	oldestAgeMs: 6_000,
	lastErrorClass: "connection",
};

describe("archive forwarder health contract", () => {
	test("is degraded but available while ClickHouse is down and spool is healthy", () => {
		expect(
			evaluateForwarderHealth({
				clickhouseOk: false,
				spoolOk: true,
				spool: spoolStats,
			}),
		).toEqual({
			statusCode: 200,
			body: {
				status: "degraded",
				clickhouse: false,
				durableAdmission: true,
				spool: { healthy: true, ...spoolStats },
			},
		});
	});

	test("returns unavailable whenever the durable spool is unhealthy", () => {
		const health = evaluateForwarderHealth({
			clickhouseOk: true,
			spoolOk: false,
			spool: null,
		});
		expect(health.statusCode).toBe(503);
		expect(health.body).toMatchObject({
			status: "unavailable",
			clickhouse: true,
			durableAdmission: false,
			spool: { healthy: false },
		});
	});

	test("reports ok only when ClickHouse and the spool are healthy", () => {
		const health = evaluateForwarderHealth({
			clickhouseOk: true,
			spoolOk: true,
			spool: { ...spoolStats, queuedBatches: 0, queuedWork: 0 },
		});
		expect(health.statusCode).toBe(200);
		expect(health.body.status).toBe("ok");
	});
});
