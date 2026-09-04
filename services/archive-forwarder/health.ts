import type { ClickHouseClient } from "@clickhouse/client";
import { clickHouseRequestDeadline } from "./clickhouse-deadline";
import type { StrategySpoolStats } from "./strategy-spool";

export type ForwarderHealthInput = {
	clickhouseOk: boolean;
	spoolOk: boolean;
	spool: StrategySpoolStats | null;
};

/**
 * `statusCode` answers "is this forwarder doing its job right now", not merely
 * "is the process up". An unreachable ClickHouse is reported as 503 even though
 * the spool keeps accepting, because a 200 here previously let a total archive
 * outage look healthy to every operator surface for days.
 *
 * Consequence to keep in mind: the container healthcheck polls this endpoint, so
 * a ClickHouse outage marks the container unhealthy, and any compose unit that
 * gates on `service_healthy` will refuse to start until ClickHouse recovers.
 * `status` still distinguishes the two failure modes: `degraded` means rows are
 * being retained durably, `unavailable` means they are not.
 */
export function evaluateForwarderHealth(input: ForwarderHealthInput) {
	const status = !input.spoolOk
		? "unavailable"
		: input.clickhouseOk
			? "ok"
			: "degraded";
	return {
		statusCode: input.spoolOk && input.clickhouseOk ? 200 : 503,
		body: {
			status,
			clickhouse: input.clickhouseOk,
			durableAdmission: input.spoolOk,
			spool: input.spoolOk
				? { healthy: true, ...input.spool }
				: { healthy: false },
		},
	};
}

export async function pingClickHouse(
	client: ClickHouseClient,
): Promise<boolean> {
	try {
		const result = await client.query({
			query: "SELECT 1 AS ok",
			format: "JSONEachRow",
			abort_signal: clickHouseRequestDeadline(),
		});
		const rows = (await result.json()) as Array<{ ok: number }>;
		return rows[0]?.ok === 1;
	} catch {
		return false;
	}
}
