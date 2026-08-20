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

	test("proves the scoped production credential and returns a secret-free identity", async () => {
		const secret = "forwarder-production-secret";
		let observedRequest: Request | undefined;
		const client = createArchiveForwarderClient({
			url: "http://archive-forwarder:8090/archive",
			authToken: secret,
			fetch: async (input, init) => {
				observedRequest = new Request(input, init);
				return Response.json({
					ok: true,
					forwarder_identity: {
						environment: "production",
						cluster: "cex-archive-primary",
					},
					authorization: {
						authorization_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103",
						scope: "production",
						environment: "production",
						cluster: "cex-archive-primary",
						expires_at: "2026-08-21T12:00:00.000Z",
						credential_validated: true,
					},
				});
			},
		});
		const result = await client.preflight({
			authorizationId: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103",
			target: { environment: "production", cluster: "cex-archive-primary" },
		});
		expect(observedRequest?.url).toBe(
			"http://archive-forwarder:8090/health/market-data-vendor-backfill",
		);
		expect(observedRequest?.headers.get("authorization")).toBe(
			`Bearer ${secret}`,
		);
		expect(observedRequest?.headers.get("x-archive-authorization-id")).toBe(
			"018f0f4d-7b32-7a30-8f4d-1d2a6e40f103",
		);
		expect(result).toEqual({
			forwarderIdentity: {
				environment: "production",
				cluster: "cex-archive-primary",
			},
			authorization: {
				authorizationId: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103",
				scope: "production",
				environment: "production",
				cluster: "cex-archive-primary",
				expiresAt: "2026-08-21T12:00:00.000Z",
				credentialValidated: true,
			},
		});
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	test("fails closed on an incompatible preflight response", async () => {
		const client = createArchiveForwarderClient({
			url: "http://archive-forwarder:8090/archive",
			authToken: "secret",
			fetch: async () =>
				Response.json({
					ok: true,
					forwarder_identity: {
						environment: "staging",
						cluster: "wrong",
					},
					authorization: { credential_validated: false },
				}),
		});
		await expect(
			client.preflight({
				authorizationId: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103",
				target: {
					environment: "production",
					cluster: "cex-archive-primary",
				},
			}),
		).rejects.toThrow("archive_forwarder_invalid_preflight");
	});

	test("maps malformed authorization expiry to the stable preflight error", async () => {
		const client = createArchiveForwarderClient({
			url: "http://archive-forwarder:8090/archive",
			authToken: "secret",
			fetch: async () =>
				Response.json({
					ok: true,
					forwarder_identity: {
						environment: "production",
						cluster: "cex-archive-primary",
					},
					authorization: {
						authorization_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103",
						scope: "production",
						environment: "production",
						cluster: "cex-archive-primary",
						expires_at: "not-a-timestamp",
						credential_validated: true,
					},
				}),
		});
		await expect(
			client.preflight({
				authorizationId: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103",
				target: {
					environment: "production",
					cluster: "cex-archive-primary",
				},
			}),
		).rejects.toThrow("archive_forwarder_invalid_preflight");
	});
});
