import type { ClickHouseClient } from "@clickhouse/client";
import { clickHouseRequestDeadline } from "./clickhouse-deadline";
import type { StrategySpoolStats } from "./strategy-spool";

export type ForwarderHealthInput = {
	clickhouseOk: boolean;
	spoolOk: boolean;
	spool: StrategySpoolStats | null;
};

export function evaluateForwarderHealth(input: ForwarderHealthInput) {
	const status = !input.spoolOk
		? "unavailable"
		: input.clickhouseOk
			? "ok"
			: "degraded";
	return {
		statusCode: input.spoolOk ? 200 : 503,
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
