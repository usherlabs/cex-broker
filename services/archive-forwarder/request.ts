import { isArchiveRequestAuthorized } from "./auth";
import type { RowInserter } from "./insert";
import {
	MAX_ARCHIVE_ROWS,
	isArchiveBodyTooLarge,
	readBoundedArchiveBody,
} from "./limits";
import { handleArchiveBatch, parseArchiveBatchRequest } from "./router";
import type { ArchiveForwarderTelemetry } from "./telemetry";

export type ArchiveRequestDependencies = {
	authToken?: string;
	inserter: RowInserter;
	telemetry: ArchiveForwarderTelemetry;
};

export async function handleArchiveRequest(
	request: Request,
	dependencies: ArchiveRequestDependencies,
): Promise<Response> {
	if (!isArchiveRequestAuthorized(request, dependencies.authToken)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	if (isArchiveBodyTooLarge(request.headers.get("content-length"))) {
		return Response.json({ error: "Request body too large" }, { status: 413 });
	}

	const bodyRead = await readBoundedArchiveBody(request);
	if (!bodyRead.ok) {
		return Response.json(
			{
				error:
					bodyRead.status === 413
						? "Request body too large"
						: "Failed to read request body",
			},
			{ status: bodyRead.status },
		);
	}

	let body: unknown;
	try {
		body = JSON.parse(bodyRead.text);
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = parseArchiveBatchRequest(body);
	if (!parsed.ok) {
		return Response.json(
			{ error: "Invalid archive batch payload" },
			{ status: 400 },
		);
	}

	if (parsed.rejectedRowCount > 0) {
		dependencies.telemetry.recordRejectedRows(parsed.rejectedRowsByTable);
		// Name the offending tables: an unknown table (e.g. a forgotten
		// SUPPORTED_TABLES entry for a new archive table) would otherwise reject
		// the whole batch with only a count, hiding which table is at fault.
		console.warn(
			`Rejected ${parsed.rejectedRowCount}/${parsed.inputRowCount} archive row(s) from ${parsed.batch.source}; tables: ${parsed.rejectedTables.join(", ")}`,
		);
		return Response.json(
			{
				error: "Malformed archive rows in batch",
				rejected: parsed.rejectedRowCount,
				inputRows: parsed.inputRowCount,
				rejectedTables: parsed.rejectedTables,
			},
			{ status: 400 },
		);
	}

	if (parsed.batch.rows.length > MAX_ARCHIVE_ROWS) {
		return Response.json(
			{
				error: "Too many archive rows in batch",
				maxRows: MAX_ARCHIVE_ROWS,
				received: parsed.batch.rows.length,
			},
			{ status: 413 },
		);
	}

	try {
		const result = await handleArchiveBatch(
			dependencies.inserter,
			parsed.batch,
			dependencies.telemetry,
		);
		if (result.skipped > 0) {
			console.warn(
				`Skipped ${result.skipped} unsupported archive row(s) from ${parsed.batch.source}`,
			);
		}
		if (result.failed > 0) {
			console.warn(
				`Failed ${result.failed} archive row(s) from ${parsed.batch.source}: ${result.failedTables.join(", ")}`,
			);
			return Response.json(
				{ error: "Archive insert failed", ...result },
				{ status: 500 },
			);
		}
		return Response.json({ ok: true, ...result });
	} catch (error) {
		console.error("Archive insert failed:", error);
		return Response.json(
			{ error: "Archive insert failed" },
			{ status: 500 },
		);
	}
}
