import type { ClickHouseClient } from "@clickhouse/client";

export async function pingClickHouse(
	client: ClickHouseClient,
): Promise<boolean> {
	try {
		const result = await client.query({
			query: "SELECT 1 AS ok",
			format: "JSONEachRow",
		});
		const rows = (await result.json()) as Array<{ ok: number }>;
		return rows[0]?.ok === 1;
	} catch {
		return false;
	}
}
