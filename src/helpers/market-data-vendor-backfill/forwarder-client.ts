import type { ForwarderBatch } from "./contracts";

export type ArchiveForwarderClient = {
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

	return {
		async submit(batch) {
			let response: Response;
			try {
				response = await request(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(options.authToken?.trim()
							? { authorization: `Bearer ${options.authToken.trim()}` }
							: {}),
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
