import { describe, expect, test } from "bun:test";
import {
	evaluateForwarderHealth,
	readArchiveClusterIdentity,
} from "../services/archive-forwarder/health";

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
				archiveIdentity: null,
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
				archiveIdentity: null,
				durableAdmission: true,
				spool: { healthy: true, ...spoolStats },
			},
		});
	});

	test("returns unavailable whenever the durable spool is unhealthy", () => {
		const health = evaluateForwarderHealth({
			clickhouseOk: true,
			archiveIdentity: {
				environment: "production",
				cluster: "cex-archive-primary",
			},
			spoolOk: false,
			spool: null,
		});
		expect(health.statusCode).toBe(503);
		expect(health.body).toMatchObject({
			status: "unavailable",
			clickhouse: true,
			archiveIdentity: {
				environment: "production",
				cluster: "cex-archive-primary",
			},
			durableAdmission: false,
			spool: { healthy: false },
		});
	});

	test("reports ok only when ClickHouse and the spool are healthy", () => {
		const health = evaluateForwarderHealth({
			clickhouseOk: true,
			archiveIdentity: {
				environment: "production",
				cluster: "cex-archive-primary",
			},
			spoolOk: true,
			spool: { ...spoolStats, queuedBatches: 0, queuedWork: 0 },
		});
		expect(health.statusCode).toBe(200);
		expect(health.body.status).toBe("ok");
	});

	test("reports the deployment-owned singleton identity read from ClickHouse", async () => {
		const identity = await readArchiveClusterIdentity({
			query: async ({ query }: { query: string }) => {
				expect(query).toContain("cex_archive_cluster_identity FINAL");
				return {
					json: async () => [
						{
							environment: "production",
							cluster: "cex-archive-primary",
						},
					],
				};
			},
		} as never);
		expect(identity).toEqual({
			environment: "production",
			cluster: "cex-archive-primary",
		});
	});

	test("fails closed on a missing or conflicting singleton", async () => {
		for (const rows of [
			[],
			[
				{ environment: "production", cluster: "one" },
				{ environment: "production", cluster: "two" },
			],
		]) {
			const identity = await readArchiveClusterIdentity({
				query: async () => ({ json: async () => rows }),
			} as never);
			expect(identity).toBeNull();
		}
	});
});
