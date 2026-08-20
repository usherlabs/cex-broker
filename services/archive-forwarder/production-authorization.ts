import { isArchiveRequestAuthorized } from "./auth";
import type { ConfiguredProductionAuthorization } from "./config";
import type { ArchiveClusterIdentity } from "./health";

export type ProductionBackfillPreflightDependencies = {
	authToken?: string;
	authorization?: ConfiguredProductionAuthorization;
	archiveIdentity: ArchiveClusterIdentity | null;
	nowMs: number;
};

export function handleProductionBackfillPreflight(
	request: Request,
	dependencies: ProductionBackfillPreflightDependencies,
): Response {
	if (!isArchiveRequestAuthorized(request, dependencies.authToken)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const { authorization, archiveIdentity } = dependencies;
	if (!authorization || !archiveIdentity) {
		return Response.json(
			{ error: "Production backfill authorization unavailable" },
			{ status: 503 },
		);
	}
	if (
		archiveIdentity.environment !== authorization.environment ||
		archiveIdentity.cluster !== authorization.cluster
	) {
		return Response.json(
			{ error: "Archive identity does not match forwarder authorization" },
			{ status: 503 },
		);
	}
	if (
		request.headers.get("x-archive-authorization-id") !==
			authorization.authorizationId ||
		request.headers.get("x-archive-environment") !==
			authorization.environment ||
		request.headers.get("x-archive-cluster") !== authorization.cluster ||
		Date.parse(authorization.expiresAt) <= dependencies.nowMs
	) {
		return Response.json(
			{ error: "Production backfill authorization rejected" },
			{ status: 403 },
		);
	}
	return Response.json({
		ok: true,
		forwarder_identity: archiveIdentity,
		authorization: {
			authorization_id: authorization.authorizationId,
			scope: authorization.scope,
			environment: authorization.environment,
			cluster: authorization.cluster,
			expires_at: authorization.expiresAt,
			credential_validated: true,
		},
	});
}
