import type { ForwarderBatch } from "./contracts";
import type {
	ArchiveClusterIdentity,
	ProductionForwarderAuthorization,
} from "./core";

export type ArchiveForwarderClient = {
	preflight(input: {
		authorizationId: string;
		target: ArchiveClusterIdentity;
	}): Promise<{
		forwarderIdentity: ArchiveClusterIdentity;
		authorization: ProductionForwarderAuthorization;
	}>;
	submit(batch: ForwarderBatch): Promise<{ ok: boolean; inserted: number }>;
};

export type ArchiveForwarderClientOptions = {
	url: string;
	authToken?: string;
	fetch?: typeof globalThis.fetch;
};

export class ArchiveForwarderSubmissionError extends Error {
	readonly reason: string;

	constructor(reason: string, status?: number) {
		super(status === undefined ? reason : `${reason}:${status}`);
		this.name = "ArchiveForwarderSubmissionError";
		this.reason = reason;
	}
}

function parseAdmissionResult(
	value: unknown,
): { ok: boolean; inserted: number } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (
		record.ok !== true ||
		typeof record.inserted !== "number" ||
		!Number.isSafeInteger(record.inserted) ||
		record.inserted < 0
	) {
		return;
	}
	return { ok: true, inserted: record.inserted };
}

export function createArchiveForwarderClient(
	options: ArchiveForwarderClientOptions,
): ArchiveForwarderClient {
	const url = options.url.trim();
	if (!url) throw new Error("archive_forwarder_url_required");
	const request = options.fetch ?? globalThis.fetch;
	const authorizationHeaders: Record<string, string> = {};
	if (options.authToken?.trim()) {
		authorizationHeaders.authorization = `Bearer ${options.authToken.trim()}`;
	}

	return {
		async preflight(input) {
			const endpoint = new URL(url);
			endpoint.pathname = "/health/market-data-vendor-backfill";
			endpoint.search = "";
			endpoint.hash = "";
			let response: Response;
			try {
				response = await request(endpoint, {
					headers: {
						...authorizationHeaders,
						"x-archive-authorization-id": input.authorizationId,
						"x-archive-environment": input.target.environment,
						"x-archive-cluster": input.target.cluster,
					},
				});
			} catch {
				throw new ArchiveForwarderSubmissionError(
					"archive_forwarder_preflight_unreachable",
				);
			}
			if (!response.ok) {
				throw new ArchiveForwarderSubmissionError(
					"archive_forwarder_preflight_http_error",
					response.status,
				);
			}
			const value = await response.json().catch(() => undefined);
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				throw new ArchiveForwarderSubmissionError(
					"archive_forwarder_invalid_preflight",
				);
			}
			const record = value as Record<string, unknown>;
			const identity = record.forwarder_identity as
				| Record<string, unknown>
				| undefined;
			const authorization = record.authorization as
				| Record<string, unknown>
				| undefined;
			const expiresAtMs =
				typeof authorization?.expires_at === "string"
					? Date.parse(authorization.expires_at)
					: Number.NaN;
			if (
				record.ok !== true ||
				!identity ||
				identity.environment !== input.target.environment ||
				identity.cluster !== input.target.cluster ||
				!authorization ||
				authorization.authorization_id !== input.authorizationId ||
				authorization.scope !== "production" ||
				authorization.environment !== input.target.environment ||
				authorization.cluster !== input.target.cluster ||
				typeof authorization.expires_at !== "string" ||
				!Number.isSafeInteger(expiresAtMs) ||
				new Date(expiresAtMs).toISOString() !== authorization.expires_at ||
				authorization.credential_validated !== true
			) {
				throw new ArchiveForwarderSubmissionError(
					"archive_forwarder_invalid_preflight",
				);
			}
			return {
				forwarderIdentity: {
					environment: identity.environment as string,
					cluster: identity.cluster as string,
				},
				authorization: {
					authorizationId: authorization.authorization_id as string,
					scope: "production",
					environment: authorization.environment as string,
					cluster: authorization.cluster as string,
					expiresAt: authorization.expires_at,
					credentialValidated: true,
				},
			};
		},
		async submit(batch) {
			let response: Response;
			try {
				response = await request(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...authorizationHeaders,
					},
					body: JSON.stringify(batch),
				});
			} catch {
				throw new ArchiveForwarderSubmissionError(
					"archive_forwarder_unreachable",
				);
			}
			if (!response.ok) {
				throw new ArchiveForwarderSubmissionError(
					"archive_forwarder_http_error",
					response.status,
				);
			}
			const admission = parseAdmissionResult(
				await response.json().catch(() => undefined),
			);
			if (!admission) {
				throw new ArchiveForwarderSubmissionError(
					"archive_forwarder_invalid_response",
				);
			}
			return admission;
		},
	};
}
