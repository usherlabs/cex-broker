import {
	createOtelMetricsFromEnv,
	type OtelMetrics,
} from "../../src/helpers/otel";
import {
	isSupportedTable,
	MALFORMED_TABLE_LABEL,
	UNSUPPORTED_TABLE_LABEL,
} from "./types";
import type { StrategySpoolStats } from "./strategy-spool";

export const ARCHIVE_FORWARDER_METRICS = {
	rowsInserted: "archive_forwarder_rows_inserted_total",
	rowsRejected: "archive_forwarder_rows_rejected_total",
	insertFailures: "archive_forwarder_insert_failures_total",
	checksumConflicts: "archive_forwarder_checksum_conflict_rows_total",
	lastSuccessfulFlush:
		"archive_forwarder_last_successful_flush_timestamp_seconds",
	strategyBatchesAdmitted:
		"archive_forwarder_strategy_batches_admitted_total",
	strategyRowsAdmitted: "archive_forwarder_strategy_rows_admitted_total",
	strategyAdmissionsRejected:
		"archive_forwarder_strategy_admissions_rejected_total",
	strategyReplayBatchesInserted:
		"archive_forwarder_strategy_replay_batches_inserted_total",
	strategyReplayRowsInserted:
		"archive_forwarder_strategy_replay_rows_inserted_total",
	strategyReplayInsertionFailures:
		"archive_forwarder_strategy_replay_insertion_failures_total",
	strategySpoolPendingBatches:
		"archive_forwarder_strategy_spool_pending_batches",
	strategySpoolPendingWork: "archive_forwarder_strategy_spool_pending_work",
	strategySpoolTerminalWork: "archive_forwarder_strategy_spool_terminal_work",
	strategySpoolExpiredWork: "archive_forwarder_strategy_spool_expired_work",
	strategySpoolBytes: "archive_forwarder_strategy_spool_accounted_bytes",
	strategySpoolOldestAge:
		"archive_forwarder_strategy_spool_oldest_age_milliseconds",
	strategyRetries: "archive_forwarder_strategy_retries_total",
	strategyTableCompletions:
		"archive_forwarder_strategy_table_completions_total",
	strategyTerminalFailures:
		"archive_forwarder_strategy_terminal_failures_total",
	strategyExpiredWork: "archive_forwarder_strategy_expired_work_total",
	lastSuccessfulStrategyDrain:
		"archive_forwarder_last_successful_strategy_drain_timestamp_seconds",
	marketDataRowsRetained: "archive_forwarder_market_data_rows_retained_total",
	marketDataRetentionRejected:
		"archive_forwarder_market_data_retention_rejected_total",
	marketDataSpoolPendingWork:
		"archive_forwarder_market_data_spool_pending_work",
	marketDataSpoolBytes: "archive_forwarder_market_data_spool_accounted_bytes",
	marketDataSpoolOldestAge:
		"archive_forwarder_market_data_spool_oldest_age_milliseconds",
} as const;

const STRATEGY_REJECTION_REASONS = new Set([
	"invalid_contract",
	"quota",
	"spool_unavailable",
]);

const MARKET_DATA_REJECTION_REASONS: Record<string, true> = {
	quota: true,
	spool_unavailable: true,
	not_retryable: true,
};

const INSERT_ERROR_CLASSES = new Set([
	"timeout",
	"connection",
	"overloaded",
	"authentication",
	"schema",
	"unknown",
]);

/**
 * Insert error classes worth retaining for a later retry. A class absent here
 * is treated as non-retryable at admission, so the sender keeps its existing
 * failure response and its own dead-letter path stays the last resort. `unknown`
 * is deliberately excluded: retaining unclassified failures would fill the spool
 * with work that can never drain.
 */
export const RETRYABLE_INSERT_ERROR_CLASSES: Record<string, true> = {
	timeout: true,
	connection: true,
	overloaded: true,
};

export type ArchiveMetricsRecorder = Pick<
	OtelMetrics,
	"recordCounter" | "setObservableGauge"
>;

export class ArchiveForwarderTelemetry {
	constructor(private readonly metrics: ArchiveMetricsRecorder) {}

	public recordRowsInserted(table: string, count: number): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.rowsInserted,
				count,
				{ table },
			),
		);
	}

	/**
	 * Rejected rows are precisely the rows whose table is unknown, so their names
	 * come straight from the request payload. Every distinct label value becomes a
	 * permanent series in the metrics SDK, so emitting them verbatim lets any client
	 * grow our memory without bound — and a metrics pipeline that can be exhausted
	 * by traffic is worse than no metrics.
	 *
	 * Labels are therefore bounded to the supported-table set plus two fixed
	 * buckets. The bound lives here, at the metric boundary, rather than at the one
	 * current call site, so a future caller cannot reintroduce the problem. The raw
	 * names are still reported and logged per request, where they are bounded by the
	 * batch and are what an operator actually needs for diagnosis.
	 */
	public recordRejectedRows(rowsByTable: Readonly<Record<string, number>>): void {
		const bounded = new Map<string, number>();
		for (const [table, count] of Object.entries(rowsByTable)) {
			const label =
				table === MALFORMED_TABLE_LABEL || isSupportedTable(table)
					? table
					: UNSUPPORTED_TABLE_LABEL;
			bounded.set(label, (bounded.get(label) ?? 0) + count);
		}
		for (const [table, count] of bounded) {
			this.bestEffort(() =>
				this.metrics.recordCounter(
					ARCHIVE_FORWARDER_METRICS.rowsRejected,
					count,
					{ table },
				),
			);
		}
	}

	public recordInsertFailure(table: string, error: unknown): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.insertFailures,
				1,
				{ table, error_class: classifyInsertError(error) },
			),
		);
	}

	public recordChecksumConflicts(
		source: string,
		rowsByTable: Readonly<Record<string, number>>,
	): void {
		const boundedSource =
			source === "broker_read" || source === "broker_write" ? source : "other";
		for (const [table, count] of Object.entries(rowsByTable)) {
			this.bestEffort(() =>
				this.metrics.recordCounter(
					ARCHIVE_FORWARDER_METRICS.checksumConflicts,
					count,
					{ source: boundedSource, feed: "ORDERBOOK", table },
				),
			);
		}
	}

	public recordSuccessfulFlush(completedAt: Date = new Date()): void {
		this.bestEffort(() =>
			this.metrics.setObservableGauge(
				ARCHIVE_FORWARDER_METRICS.lastSuccessfulFlush,
				Math.floor(completedAt.getTime() / 1_000),
				{},
			),
		);
	}

	public recordStrategyAdmission(rowCount: number): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyBatchesAdmitted,
				1,
				{},
			),
		);
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyRowsAdmitted,
				rowCount,
				{},
			),
		);
	}

	public recordStrategyAdmissionRejected(reason: string): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyAdmissionsRejected,
				1,
				{ reason: STRATEGY_REJECTION_REASONS.has(reason) ? reason : "other" },
			),
		);
	}

	public recordStrategyReplaySuccess(rowCount: number): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyReplayBatchesInserted,
				1,
				{},
			),
		);
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyReplayRowsInserted,
				rowCount,
				{},
			),
		);
	}

	public recordStrategyReplayInsertionFailure(): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyReplayInsertionFailures,
				1,
				{},
			),
		);
	}

	public recordMarketDataRetention(rowCount: number): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.marketDataRowsRetained,
				rowCount,
				{},
			),
		);
	}

	public recordMarketDataRetentionRejected(reason: string): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.marketDataRetentionRejected,
				1,
				{
					reason: MARKET_DATA_REJECTION_REASONS[reason] ? reason : "other",
				},
			),
		);
	}

	public recordMarketDataSpoolStats(stats: StrategySpoolStats): void {
		for (const [name, value] of [
			[ARCHIVE_FORWARDER_METRICS.marketDataSpoolPendingWork, stats.queuedWork],
			[ARCHIVE_FORWARDER_METRICS.marketDataSpoolBytes, stats.accountedBytes],
			[ARCHIVE_FORWARDER_METRICS.marketDataSpoolOldestAge, stats.oldestAgeMs],
		] as const) {
			this.bestEffort(() => this.metrics.setObservableGauge(name, value, {}));
		}
	}

	public recordStrategySpoolStats(stats: StrategySpoolStats): void {
		for (const [name, value] of [
			[ARCHIVE_FORWARDER_METRICS.strategySpoolPendingBatches, stats.queuedBatches],
			[ARCHIVE_FORWARDER_METRICS.strategySpoolPendingWork, stats.queuedWork],
			[ARCHIVE_FORWARDER_METRICS.strategySpoolTerminalWork, stats.terminalWork],
			[ARCHIVE_FORWARDER_METRICS.strategySpoolExpiredWork, stats.expiredWork],
			[ARCHIVE_FORWARDER_METRICS.strategySpoolBytes, stats.accountedBytes],
			[ARCHIVE_FORWARDER_METRICS.strategySpoolOldestAge, stats.oldestAgeMs],
		] as const) {
			this.bestEffort(() => this.metrics.setObservableGauge(name, value, {}));
		}
	}

	public recordStrategyRetry(table: string, errorClass: string): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyRetries,
				1,
				{
					table: isSupportedTable(table) ? table : UNSUPPORTED_TABLE_LABEL,
					error_class: INSERT_ERROR_CLASSES.has(errorClass)
						? errorClass
						: "unknown",
				},
			),
		);
	}

	public recordStrategyTableCompletion(
		table: string,
		completedAt: Date = new Date(),
	): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyTableCompletions,
				1,
				{ table: isSupportedTable(table) ? table : UNSUPPORTED_TABLE_LABEL },
			),
		);
		this.bestEffort(() =>
			this.metrics.setObservableGauge(
				ARCHIVE_FORWARDER_METRICS.lastSuccessfulStrategyDrain,
				Math.floor(completedAt.getTime() / 1_000),
				{},
			),
		);
	}

	public recordStrategyExpired(count: number): void {
		if (count <= 0) return;
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyExpiredWork,
				count,
				{},
			),
		);
	}

	public recordStrategyTerminalFailure(table: string, errorClass: string): void {
		this.bestEffort(() =>
			this.metrics.recordCounter(
				ARCHIVE_FORWARDER_METRICS.strategyTerminalFailures,
				1,
				{
					table: isSupportedTable(table) ? table : UNSUPPORTED_TABLE_LABEL,
					error_class: INSERT_ERROR_CLASSES.has(errorClass)
						? errorClass
						: "unknown",
				},
			),
		);
	}

	private bestEffort(action: () => void | Promise<void>): void {
		try {
			const result = action();
			if (result instanceof Promise) {
				void result.catch(() => {});
			}
		} catch {
			// Metrics must never affect archive request handling or insertion.
		}
	}
}

export function createArchiveForwarderTelemetry(): ArchiveForwarderTelemetry {
	return new ArchiveForwarderTelemetry(
		createOtelMetricsFromEnv({
			defaultServiceName: "archive-forwarder",
			allowLegacyBrokerConfig: false,
		}),
	);
}

export function classifyInsertError(error: unknown): string {
	const message =
		error instanceof Error
			? `${error.name} ${error.message}`.toLowerCase()
			: String(error).toLowerCase();

	// Checked before every other class: a server that refuses the allocation is
	// rejecting work it would accept once load drops, which is retryable, while
	// the generic `unknown` bucket is treated as non-retryable at admission. The
	// wire form carries both the prose and the type name, so match on both.
	if (
		/memory limit exceeded|memory_limit_exceeded|too many simultaneous queries|too_many_simultaneous_queries/.test(
			message,
		)
	) {
		return "overloaded";
	}
	if (/timeout|timed out|abort/.test(message)) return "timeout";
	if (/econn|connection|network|socket|fetch failed/.test(message)) {
		return "connection";
	}
	if (/unauthorized|forbidden|authentication|credential/.test(message)) {
		return "authentication";
	}
	if (
		/unknown (table|column)|does not exist|doesn't exist|table missing/.test(
			message,
		)
	) {
		return "schema";
	}
	return "unknown";
}
