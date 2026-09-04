import { isArchiveRequestAuthorized } from "./auth";
import type { RowInserter } from "./insert";
import {
	MAX_ARCHIVE_ROWS,
	findTableRowLimitViolation,
	isArchiveBodyTooLarge,
	readBoundedArchiveBody,
} from "./limits";
import { handleArchiveBatch, parseArchiveBatchRequest } from "./router";
import {
	classifyStrategyArchiveBatch,
	validateStrategyArchiveBatch,
} from "./strategy-contract";
import {
	classifyStreamHealthArchiveBatch,
	insertStreamHealthArchiveBatch,
	type StreamHealthReplayStore,
	validateStreamHealthArchiveBatch,
} from "./stream-health-contract";
import {
	StrategySpoolQuotaError,
	StrategySpoolUnavailableError,
	type StrategyArchiveSpool,
} from "./strategy-spool";
import { classifyMarketSource } from "./market-source-contract";
import {
	classifyInsertError,
	RETRYABLE_INSERT_ERROR_CLASSES,
	type ArchiveForwarderTelemetry,
} from "./telemetry";
import type {
	ArchiveBatchRequest,
	ArchiveBatchResult,
	SupportedTable,
} from "./types";

export type ArchiveRequestDependencies = {
	authToken?: string;
	marketIdentity?: {
		source: "broker_read" | "broker_write";
		deploymentId: string;
	};
	inserter: RowInserter;
	spool?: Pick<StrategyArchiveSpool, "admit">;
	streamHealthStore?: StreamHealthReplayStore;
	telemetry: ArchiveForwarderTelemetry;
};

// Tables whose rows are worth holding through a transient ClickHouse outage.
// Strategy tables are absent on purpose: they are admit-first and never reach
// the direct-insert failure path with rows that lack a durable home.
const RETAINED_TABLE_PREFIXES = [
	"market_data.",
	"broker_execution.",
	"broker_account.",
];

type InsertFailure = { table: SupportedTable; errorClass: string };

/**
 * Durably retains rows that ClickHouse refused for a reason that will pass,
 * so a transient archive outage stops costing rows.
 *
 * Retention is all-or-nothing on purpose. A 202 tells the sender every row it
 * posted is safe, so it is only returned when every failed table was retained;
 * if any failure is non-retryable, names a table outside the retained lane,
 * or the spool refuses the batch, the caller keeps its 500 and its own
 * dead-letter path remains the last resort. Only the failed tables are handed
 * to the spool: tables that already landed must not be replayed.
 *
 * The spool class and metric names still say market_data because the lane
 * started there and both are externally consumed (persisted spool rows,
 * dashboards); the lane now also covers broker_execution and broker_account.
 */
function retainFailedDurableRows(
	batch: ArchiveBatchRequest,
	failures: readonly InsertFailure[],
	result: ArchiveBatchResult,
	dependencies: ArchiveRequestDependencies,
): Response | undefined {
	const retainable =
		failures.length > 0 &&
		failures.every(
			(failure) =>
				RETAINED_TABLE_PREFIXES.some((prefix) =>
					failure.table.startsWith(prefix),
				) &&
				RETRYABLE_INSERT_ERROR_CLASSES[failure.errorClass],
		);
	if (!retainable) {
		dependencies.telemetry.recordMarketDataRetentionRejected("not_retryable");
		return undefined;
	}
	if (!dependencies.spool) {
		dependencies.telemetry.recordMarketDataRetentionRejected("spool_unavailable");
		return undefined;
	}
	const failedTables: Record<string, true> = {};
	for (const failure of failures) {
		failedTables[failure.table] = true;
	}
	const failedRows = batch.rows.filter((row) => failedTables[row.table]);
	try {
		const admitted = dependencies.spool.admit(
			{ ...batch, rows: failedRows },
			"market_data",
		);
		dependencies.telemetry.recordMarketDataRetention(failedRows.length);
		return Response.json(
			{
				ok: true,
				accepted: true,
				inserted: result.inserted,
				retained: failedRows.length,
				batchId: admitted.batchId,
				byTable: result.byTable,
			},
			{ status: 202 },
		);
	} catch (error) {
		if (
			!(error instanceof StrategySpoolQuotaError) &&
			!(error instanceof StrategySpoolUnavailableError)
		) {
			console.error("Market data retention failed:", error);
		}
		dependencies.telemetry.recordMarketDataRetentionRejected(
			error instanceof StrategySpoolQuotaError ? "quota" : "spool_unavailable",
		);
		return undefined;
	}
}

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

	if (
		classifyMarketSource(body, dependencies.marketIdentity) ===
		"invalid_market_source"
	) {
		return Response.json(
			{ error: "Market archive source must be broker_read or broker_write" },
			{ status: 400 },
		);
	}

	const streamHealthClassification = classifyStreamHealthArchiveBatch(body);
	if (
		streamHealthClassification === "invalid_stream_health_mix" ||
		streamHealthClassification === "invalid_stream_health_source"
	) {
		return Response.json(
			{ error: "Invalid stream health archive source or table mix" },
			{ status: 400 },
		);
	}
	const streamHealthValidation =
		streamHealthClassification === "stream_health"
			? validateStreamHealthArchiveBatch(body)
			: undefined;
	if (streamHealthValidation && !streamHealthValidation.ok) {
		return Response.json({ error: streamHealthValidation.error }, { status: 400 });
	}

	const strategyClassification = classifyStrategyArchiveBatch(body);
	if (
		strategyClassification === "invalid_strategy_mix" ||
		strategyClassification === "invalid_strategy_source"
	) {
		dependencies.telemetry.recordStrategyAdmissionRejected("invalid_contract");
		return Response.json(
			{ error: "Invalid strategy archive source or table mix" },
			{ status: 400 },
		);
	}
	if (
		strategyClassification === "strategy_runtime" ||
		strategyClassification === "strategy_replay"
	) {
		const validation = validateStrategyArchiveBatch(body);
		if (!validation.ok) {
			dependencies.telemetry.recordStrategyAdmissionRejected("invalid_contract");
			return Response.json({ error: validation.error }, { status: 400 });
		}
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
		dependencies.telemetry.recordChecksumConflicts(
			parsed.batch.source,
			parsed.checksumConflictsByTable,
		);
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
	const tableLimit = findTableRowLimitViolation(parsed.batch.rows);
	if (tableLimit) {
		return Response.json(
			{ error: "Too many archive rows for table", ...tableLimit },
			{ status: 413 },
		);
	}

	if (streamHealthValidation?.ok) {
		if (!dependencies.streamHealthStore) {
			return Response.json(
				{ error: "Stream health replay store unavailable" },
				{ status: 503 },
			);
		}
		const result = await insertStreamHealthArchiveBatch(
			dependencies.inserter,
			dependencies.streamHealthStore,
			streamHealthValidation,
		);
		if (!result.ok) {
			return Response.json({ error: result.error }, { status: result.status });
		}
		if (result.inserted > 0) {
			dependencies.telemetry.recordRowsInserted(
				"broker_stream_health.snapshots",
				result.inserted,
			);
			dependencies.telemetry.recordSuccessfulFlush();
		}
		return Response.json(result);
	}

	if (strategyClassification === "strategy_runtime") {
		if (!dependencies.spool) {
			dependencies.telemetry.recordStrategyAdmissionRejected("spool_unavailable");
			return Response.json(
				{ error: "Strategy archive spool unavailable" },
				{ status: 503 },
			);
		}
		try {
			const admitted = dependencies.spool.admit(parsed.batch);
			dependencies.telemetry.recordStrategyAdmission(parsed.batch.rows.length);
			return Response.json(
				{
					ok: true,
					accepted: true,
					batchId: admitted.batchId,
					rows: parsed.batch.rows.length,
				},
				{ status: 202 },
			);
		} catch (error) {
			if (error instanceof StrategySpoolQuotaError) {
				dependencies.telemetry.recordStrategyAdmissionRejected("quota");
				return Response.json(
					{ error: "Strategy archive spool quota exceeded" },
					{ status: 429 },
				);
			}
			if (!(error instanceof StrategySpoolUnavailableError)) {
				console.error("Strategy archive spool admission failed:", error);
			}
			dependencies.telemetry.recordStrategyAdmissionRejected("spool_unavailable");
			return Response.json(
				{ error: "Strategy archive spool unavailable" },
				{ status: 503 },
			);
		}
	}

	const insertFailures: InsertFailure[] = [];
	try {
		const result = await handleArchiveBatch(
			dependencies.inserter,
			parsed.batch,
			dependencies.telemetry,
			(table, error) => {
				insertFailures.push({ table, errorClass: classifyInsertError(error) });
			},
		);
		if (result.skipped > 0) {
			console.warn(
				`Skipped ${result.skipped} unsupported archive row(s) from ${parsed.batch.source}`,
			);
		}
		if (result.failed > 0) {
			if (strategyClassification === "strategy_replay") {
				dependencies.telemetry.recordStrategyReplayInsertionFailure();
			}
			console.warn(
				`Failed ${result.failed} archive row(s) from ${parsed.batch.source}: ${result.failedTables.join(", ")}`,
			);
			// Replay batches are excluded: they are a re-drive of rows that already
			// have a durable home, so retaining them here would double-store them.
			const retained =
				strategyClassification === "strategy_replay"
					? undefined
					: retainFailedDurableRows(
							parsed.batch,
							insertFailures,
							result,
							dependencies,
						);
			if (retained) {
				return retained;
			}
			return Response.json(
				{ error: "Archive insert failed", ...result },
				{ status: 500 },
			);
		}
		if (strategyClassification === "strategy_replay") {
			dependencies.telemetry.recordStrategyReplaySuccess(result.inserted);
		}
		return Response.json({ ok: true, ...result });
	} catch (error) {
		if (strategyClassification === "strategy_replay") {
			dependencies.telemetry.recordStrategyReplayInsertionFailure();
		}
		console.error("Archive insert failed:", error);
		return Response.json(
			{ error: "Archive insert failed" },
			{ status: 500 },
		);
	}
}
