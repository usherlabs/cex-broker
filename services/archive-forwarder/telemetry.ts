import {
	createOtelMetricsFromEnv,
	type OtelMetrics,
} from "../../src/helpers/otel";
import {
	isSupportedTable,
	MALFORMED_TABLE_LABEL,
	UNSUPPORTED_TABLE_LABEL,
} from "./types";

export const ARCHIVE_FORWARDER_METRICS = {
	rowsInserted: "archive_forwarder_rows_inserted_total",
	rowsRejected: "archive_forwarder_rows_rejected_total",
	insertFailures: "archive_forwarder_insert_failures_total",
	checksumConflicts: "archive_forwarder_checksum_conflict_rows_total",
	lastSuccessfulFlush:
		"archive_forwarder_last_successful_flush_timestamp_seconds",
} as const;

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
