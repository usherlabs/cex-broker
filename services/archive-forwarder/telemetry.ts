import {
	createOtelMetricsFromEnv,
	type OtelMetrics,
} from "../../src/helpers/otel";

export const ARCHIVE_FORWARDER_METRICS = {
	rowsInserted: "archive_forwarder_rows_inserted_total",
	rowsRejected: "archive_forwarder_rows_rejected_total",
	insertFailures: "archive_forwarder_insert_failures_total",
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

	public recordRejectedRows(rowsByTable: Readonly<Record<string, number>>): void {
		for (const [table, count] of Object.entries(rowsByTable)) {
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
