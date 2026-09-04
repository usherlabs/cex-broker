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
	test("fails the health check while ClickHouse is down, still reporting durable admission", () => {
		expect(
			evaluateForwarderHealth({
				clickhouseOk: false,
				spoolOk: true,
				spool: spoolStats,
			}),
		).toEqual({
			// An unreachable ClickHouse is not a healthy forwarder, even though the
			// spool keeps accepting: a 200 here let a total archive outage read as
			// healthy on every operator surface. `status` still separates this from
			// the harder failure where nothing is being retained at all.
			statusCode: 503,
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
