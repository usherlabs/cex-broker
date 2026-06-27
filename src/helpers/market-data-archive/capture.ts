import { log } from "../logger";
import type { OtelMetrics } from "../otel";
import type { BrokerExecutionArchiver } from "../broker-execution-archive/writer";
import type { BrokerArchiveRow } from "../broker-execution-archive/types";
import { OhlcvBarTracker } from "./ohlcv-bar-tracker";
import { isMarketArchiveEnabled, OrderbookSampler } from "./orderbook-sampler";
import { extractTrades, parseTicker } from "./parse-stream";
import {
	buildCandleRow,
	buildCexStreamEventRow,
	buildCexTickerEventRow,
	buildCexTradeRow,
	buildOrderbookSnapshotRow,
} from "./rows";
import type {
	CexStreamArchiveInput,
	OhlcvArchiveInput,
	OrderbookArchiveInput,
	TickerArchiveInput,
	TradesArchiveInput,
} from "./types";

type WatchStream = "orderbook" | "ohlcv" | "trades" | "ticker" | "stream";

async function recordWatchMetric(
	otelMetrics: OtelMetrics | undefined,
	metricName: string,
	labels: Record<string, string | number>,
): Promise<void> {
	try {
		await otelMetrics?.recordCounter(metricName, 1, labels);
	} catch {
		// Metrics must not affect subscribe behavior.
	}
}

function watchLabels(
	stream: WatchStream,
	input: { exchange: string; symbol: string },
): Record<string, string> {
	return {
		stream,
		exchange: input.exchange,
		symbol: input.symbol,
	};
}

export function archiveOrderbookInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	input: OrderbookArchiveInput,
	options?: { sampledOut?: boolean },
): void {
	const labels = watchLabels("orderbook", input);
	void recordWatchMetric(
		otelMetrics,
		"cex_watch_frames_received_total",
		labels,
	);

	if (!isMarketArchiveEnabled() || !archiver?.isEnabled()) {
		return;
	}

	if (options?.sampledOut) {
		void recordWatchMetric(
			otelMetrics,
			"cex_watch_frames_sampled_out_total",
			labels,
		);
		return;
	}

	queueMicrotask(() => {
		try {
			const row = buildOrderbookSnapshotRow(input);
			if (row) {
				archiver.enqueue(row);
				void recordWatchMetric(
					otelMetrics,
					"cex_watch_frames_archived_total",
					labels,
				);
			}
		} catch (error) {
			log.warn("Failed to archive orderbook snapshot", { error });
		}
	});
}

/** @deprecated Use archiveOrderbookInBackground */
export const archiveOrderbookSnapshotInBackground =
	archiveOrderbookInBackground;

/** @deprecated Use archiveOrderbookInBackground */
export const archiveOrderbookTobInBackground = archiveOrderbookInBackground;

export function archiveOhlcvInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	tracker: OhlcvBarTracker,
	input: OhlcvArchiveInput,
): void {
	const labels = watchLabels("ohlcv", input);
	void recordWatchMetric(
		otelMetrics,
		"cex_watch_frames_received_total",
		labels,
	);

	if (!isMarketArchiveEnabled() || !archiver?.isEnabled()) {
		return;
	}

	queueMicrotask(() => {
		try {
			const candidates = tracker.process(
				input.payload,
				input.receivedTimestamp,
			);
			for (const candidate of candidates) {
				const row = buildCandleRow({
					context: input,
					bar: candidate.bar,
					isClosed: candidate.isClosed,
					brokerVersion: candidate.brokerVersion,
					receivedTimestamp: input.receivedTimestamp,
				});
				archiver.enqueue(row);
			}
			if (candidates.length > 0) {
				void recordWatchMetric(
					otelMetrics,
					"cex_watch_frames_archived_total",
					labels,
				);
			}
		} catch (error) {
			log.warn("Failed to archive OHLCV candle", { error });
		}
	});
}

export function createOrderbookSampler(): OrderbookSampler {
	return new OrderbookSampler();
}

/** @deprecated Use createOrderbookSampler */
export const createOrderbookTobSampler = createOrderbookSampler;

export function createOhlcvBarTracker(): OhlcvBarTracker {
	return new OhlcvBarTracker();
}

function archiveMarketRowsInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	stream: WatchStream,
	input: { exchange: string; symbol: string },
	enqueueRows: () => BrokerArchiveRow[],
): void {
	const labels = watchLabels(stream, input);
	void recordWatchMetric(
		otelMetrics,
		"cex_watch_frames_received_total",
		labels,
	);

	if (!isMarketArchiveEnabled() || !archiver?.isEnabled()) {
		return;
	}

	queueMicrotask(() => {
		try {
			const rows = enqueueRows();
			for (const row of rows) {
				archiver.enqueue(row);
			}
			if (rows.length > 0) {
				void recordWatchMetric(
					otelMetrics,
					"cex_watch_frames_archived_total",
					labels,
				);
			}
		} catch (error) {
			log.warn(`Failed to archive ${stream} market data`, { error });
		}
	});
}

export function archiveTradesInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	input: TradesArchiveInput,
): void {
	archiveMarketRowsInBackground(archiver, otelMetrics, "trades", input, () =>
		extractTrades(input.payload, input.receivedTimestamp).map((trade) =>
			buildCexTradeRow(input, trade),
		),
	);
}

export function archiveTickerInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	input: TickerArchiveInput,
): void {
	archiveMarketRowsInBackground(archiver, otelMetrics, "ticker", input, () => {
		const ticker = parseTicker(input.payload, input.receivedTimestamp);
		return ticker ? [buildCexTickerEventRow(input, ticker)] : [];
	});
}

export function archiveCexStreamEventInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	input: CexStreamArchiveInput,
): void {
	archiveMarketRowsInBackground(archiver, otelMetrics, "stream", input, () => [
		buildCexStreamEventRow(input),
	]);
}
