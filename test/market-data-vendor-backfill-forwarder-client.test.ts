import { describe, expect, test } from "bun:test";
import type { ForwarderBatch } from "../src/helpers/market-data-vendor-backfill/contracts";
import { createArchiveForwarderClient } from "../src/helpers/market-data-vendor-backfill/forwarder-client";

const batch: ForwarderBatch = {
	source: "external_backfill",
	deployment_id: "market-data-vendor-backfill",
	batch_id: "a".repeat(64),
	rows: [
		{
			table: "market_data.cex_order_book_depth_summary",
			row: { source: "external_backfill", snapshot_id: "snapshot-a" },
		},
	],
};

describe("market-data vendor backfill forwarder client", () => {
	test("sends bounded JSON with bearer authentication and returns only admission counts", async () => {
		const secret = "forwarder-super-secret";
		let observedRequest: Request | undefined;
		const client = createArchiveForwarderClient({
			url: "http://archive-forwarder:8090/archive",
			authToken: secret,
			fetch: async (input, init) => {
				observedRequest = new Request(input, init);
				return Response.json({
					ok: true,
					inserted: 1,
					skipped: 0,
					failed: 0,
					byTable: { "market_data.cex_order_book_depth_summary": 1 },
					failedTables: [],
				});
			},
		});

		const result = await client.submit(batch);
		expect(result).toEqual({ ok: true, inserted: 1 });
		expect(observedRequest?.url).toBe("http://archive-forwarder:8090/archive");
		expect(observedRequest?.headers.get("authorization")).toBe(
			`Bearer ${secret}`,
		);
		expect(await observedRequest?.json()).toEqual(batch);
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	test("does not reflect response bodies or credentials in failures", async () => {
		const secret = "forwarder-super-secret";
		const client = createArchiveForwarderClient({
			url: "http://archive-forwarder:8090/archive",
			authToken: secret,
			fetch: async () =>
				new Response(`provider debug: ${secret}`, { status: 503 }),
		});

		let message = "";
		try {
			await client.submit(batch);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("archive_forwarder_http_error");
		expect(message).toContain("503");
		expect(message).not.toContain(secret);
	});
});
