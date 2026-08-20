import { describe, expect, test } from "bun:test";
import { handleProductionBackfillPreflight } from "../services/archive-forwarder/production-authorization";
import { createArchiveForwarderClient } from "../src/helpers/market-data-vendor-backfill/forwarder-client";
import { startArchiveForwarderEndpoint } from "./e2e/archive/support/archive-forwarder-endpoint";

const authorization = {
	authorizationId: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103",
	scope: "production" as const,
	environment: "production",
	cluster: "cex-archive-primary",
	expiresAt: "2026-08-21T12:00:00.000Z",
};

function request(token = "production-secret") {
	return new Request("http://localhost/health/market-data-vendor-backfill", {
		headers: {
			authorization: `Bearer ${token}`,
			"x-archive-authorization-id": authorization.authorizationId,
			"x-archive-environment": authorization.environment,
			"x-archive-cluster": authorization.cluster,
		},
	});
}

describe("archive forwarder production authorization preflight", () => {
	test("the isolated HTTP endpoint exercises the production preflight route", async () => {
		const endpoint = await startArchiveForwarderEndpoint({
			inserter: async () => {},
			authToken: "production-secret",
			productionBackfill: {
				authorization,
				archiveIdentity: {
					environment: "production",
					cluster: "cex-archive-primary",
				},
				nowMs: () => Date.parse("2026-08-20T12:00:00.000Z"),
			},
		});
		try {
			const client = createArchiveForwarderClient({
				url: endpoint.url,
				authToken: "production-secret",
			});
			await expect(
				client.preflight({
					authorizationId: authorization.authorizationId,
					target: {
						environment: "production",
						cluster: "cex-archive-primary",
					},
				}),
			).resolves.toMatchObject({
				forwarderIdentity: {
					environment: "production",
					cluster: "cex-archive-primary",
				},
				authorization: { credentialValidated: true },
			});
		} finally {
			await endpoint.close();
		}
	});

	test("returns the verified singleton and secret-free scoped authorization", async () => {
		const response = handleProductionBackfillPreflight(request(), {
			authToken: "production-secret",
			authorization,
			archiveIdentity: {
				environment: "production",
				cluster: "cex-archive-primary",
			},
			nowMs: Date.parse("2026-08-20T12:00:00.000Z"),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			forwarder_identity: {
				environment: "production",
				cluster: "cex-archive-primary",
			},
			authorization: {
				authorization_id: authorization.authorizationId,
				scope: "production",
				credential_validated: true,
			},
		});
		expect(JSON.stringify(body)).not.toContain("production-secret");
	});

	test("rejects the wrong credential, target, authorization ID, or expiry", () => {
		for (const [candidate, overrides, status] of [
			[request("wrong"), {}, 401],
			[
				new Request(request(), {
					headers: {
						...Object.fromEntries(request().headers),
						"x-archive-cluster": "wrong",
					},
				}),
				{},
				403,
			],
			[
				request(),
				{ archiveIdentity: { environment: "production", cluster: "wrong" } },
				503,
			],
			[request(), { nowMs: Date.parse("2026-08-21T12:00:00.000Z") }, 403],
		] as const) {
			const response = handleProductionBackfillPreflight(candidate, {
				authToken: "production-secret",
				authorization,
				archiveIdentity: {
					environment: "production",
					cluster: "cex-archive-primary",
				},
				nowMs: Date.parse("2026-08-20T12:00:00.000Z"),
				...overrides,
			});
			expect(response.status).toBe(status);
		}
	});
});
