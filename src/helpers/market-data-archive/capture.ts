import type { BrokerArchiveRow } from "../broker-execution-archive/types";
import {
	type BrokerExecutionArchiver,
	rethrowArchiveDurabilityError,
} from "../broker-execution-archive/writer";
import { log } from "../logger";
import type { OtelMetrics } from "../otel";
import {
	buildCanonicalOrderBookRows,
	OrderBookValidationError,
} from "./canonical-orderbook";
import {
	captureEnvironmentFromEnv,
	createMarketCaptureContext,
	resolveMarketCaptureArchiveState,
} from "./capture-context";
import {
	canonicalDecimal,
	createRawCapture,
	projectRawCapturePayload,
} from "./capture-contract";
import { OhlcvBarTracker } from "./ohlcv-bar-tracker";
import {
	getOrderbookArchiveDepthLimit,
	normalizeOrderbookMeasurementBandsBps,
} from "./orderbook-depth";
import { isMarketArchiveEnabled, OrderbookSampler } from "./orderbook-sampler";
import { extractTrades, parseTicker } from "./parse-stream";
import {
	buildCanonicalCexStreamEventRow,
	buildCanonicalOhlcvRow,
	buildCanonicalTickerEventRow,
	buildCanonicalTradeRow,
	buildCexStreamEventRow,
} from "./rows";
import type {
	CaptureFeed,
	CaptureSourceMode,
	CexStreamArchiveInput,
	MarketArchiveContext,
	MarketCaptureContext,
	OhlcvArchiveInput,
	OrderbookArchiveInput,
	OrderbookMetadataOnlyPayload,
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
	archiver: BrokerExecutionArchiver | undefined,
	feed: string,
): Record<string, string> {
	return {
		stream,
		feed,
		source: archiver?.getSource() ?? "disabled",
		exchange: input.exchange,
		symbol: input.symbol,
	};
}

function resolveCaptureContext(
	archiver: BrokerExecutionArchiver,
	input: MarketArchiveContext,
	feed: CaptureFeed,
	sourceMode: CaptureSourceMode,
): MarketCaptureContext {
	return createMarketCaptureContext({
		source: archiver.getSource(),
		deploymentId: archiver.getDeploymentId(),
		captureBundleId: process.env.CEX_BROKER_CAPTURE_BUNDLE_ID,
		exchange: input.exchange,
		symbol: input.symbol,
		assetType: input.assetType,
		feed,
		provider: `ccxt:${input.exchange.trim().toLowerCase()}`,
		sourceMode,
		timeframe: input.timeframe,
		accountSelector: input.accountSelector,
		environment: captureEnvironmentFromEnv(),
	});
}

function canArchiveMarketData(
	archiver: BrokerExecutionArchiver | undefined,
): archiver is BrokerExecutionArchiver {
	return resolveMarketCaptureArchiveState({
		archiveEnabled: archiver?.isEnabled() ?? false,
		marketArchiveEnabled: isMarketArchiveEnabled(),
		environment: process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT,
		deploymentId: archiver?.getDeploymentId(),
		captureBundleId: process.env.CEX_BROKER_CAPTURE_BUNDLE_ID,
	}).enabled;
}

export function archiveOrderbookInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	input: OrderbookArchiveInput,
	options?: {
		sampledOut?: boolean;
		sourceMode?: "broker_live_sampling_v1" | "broker_current_snapshot_v1";
		depthLimit?: number;
	},
): void {
	const labels = watchLabels("orderbook", input, archiver, "ORDERBOOK");
	void recordWatchMetric(
		otelMetrics,
		"cex_watch_frames_received_total",
		labels,
	);

	if (!canArchiveMarketData(archiver)) {
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
			const context = resolveCaptureContext(
				archiver,
				input,
				"ORDERBOOK",
				options?.sourceMode ?? "broker_live_sampling_v1",
			);
			const depthLimit = options?.depthLimit ?? getOrderbookArchiveDepthLimit();
			const measurementBandsBps = normalizeOrderbookMeasurementBandsBps(
				input.archiveMetadata.measurementBandsBps,
			);
			const archiveMetadata = {
				...input.archiveMetadata,
				measurementBandsBps,
			};
			const completeRawCapture = createRawCapture(context, {
				payload: input.snapshot,
				eventTimeMs: input.snapshot.timestamp,
				receivedTimeMs: input.snapshot.receivedTimestamp,
				scope: "ccxt_normalized_object",
			});
			const canonical = buildCanonicalOrderBookRows({
				context,
				snapshot: input.snapshot,
				rawCapture: completeRawCapture,
				depthLimit,
				archiveMetadata,
			});
			const rawMetadata: OrderbookMetadataOnlyPayload = {
				capture_profile_id: archiveMetadata.captureProfileId,
				effective_cadence_ms: archiveMetadata.effectiveCadenceMs,
				requested_upstream_depth: archiveMetadata.requestedUpstreamDepth,
				archive_depth_limit: depthLimit,
				observed_bid_count: archiveMetadata.observedBidCount,
				observed_ask_count: archiveMetadata.observedAskCount,
				observed_farthest_bid: canonicalDecimal(
					archiveMetadata.observedFarthestBid,
				),
				observed_farthest_ask: canonicalDecimal(
					archiveMetadata.observedFarthestAsk,
				),
				bid_exhausted: archiveMetadata.exhaustionEvidence.bid.exhausted,
				ask_exhausted: archiveMetadata.exhaustionEvidence.ask.exhausted,
				retained_bid_count: canonical.levels.filter(
					({ row }) => row.side === "bid",
				).length,
				retained_ask_count: canonical.levels.filter(
					({ row }) => row.side === "ask",
				).length,
				measurement_bands_bps: measurementBandsBps,
			};
			const storedRawCapture = projectRawCapturePayload(
				completeRawCapture,
				rawMetadata,
			);
			archiver.enqueue(
				buildCanonicalCexStreamEventRow(context, storedRawCapture, {
					payloadEncoding: "orderbook_metadata_only_v1",
				}),
			);
			for (const row of canonical.levels) archiver.enqueue(row);
			archiver.enqueue(canonical.summary);
			void recordWatchMetric(
				otelMetrics,
				"cex_watch_frames_archived_total",
				labels,
			);
		} catch (error) {
			rethrowArchiveDurabilityError(error);
			if (error instanceof OrderBookValidationError) {
				void recordWatchMetric(otelMetrics, "cex_watch_frames_invalid_total", {
					...labels,
					reason: error.reason,
				});
			}
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
	const labels = watchLabels("ohlcv", input, archiver, "OHLCV");
	void recordWatchMetric(
		otelMetrics,
		"cex_watch_frames_received_total",
		labels,
	);

	if (!canArchiveMarketData(archiver)) {
		return;
	}

	queueMicrotask(() => {
		try {
			const candidates = tracker.process(
				input.payload,
				input.receivedTimestamp,
			);
			const context = resolveCaptureContext(
				archiver,
				input,
				"OHLCV",
				input.sourceMode ?? "broker_live_stream_v1",
			);
			const rawCapture =
				candidates.length > 0
					? createRawCapture(context, {
							payload: input.payload,
							eventTimeMs:
								candidates[0]?.bar.openTimeMs ?? input.receivedTimestamp,
							receivedTimeMs: input.receivedTimestamp,
							scope: "ccxt_normalized_object",
						})
					: undefined;
			if (rawCapture) {
				archiver.enqueue(buildCanonicalCexStreamEventRow(context, rawCapture));
			}
			for (const candidate of candidates) {
				if (rawCapture) {
					archiver.enqueue(
						buildCanonicalOhlcvRow({
							context,
							rawCapture,
							bar: candidate.bar,
							isClosed: candidate.isClosed,
							brokerVersion: candidate.brokerVersion,
						}),
					);
				}
			}
			if (candidates.length > 0) {
				void recordWatchMetric(
					otelMetrics,
					"cex_watch_frames_archived_total",
					labels,
				);
			}
		} catch (error) {
			rethrowArchiveDurabilityError(error);
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
	feed: string,
	enqueueRows: () => BrokerArchiveRow[],
): void {
	const labels = watchLabels(stream, input, archiver, feed);
	void recordWatchMetric(
		otelMetrics,
		"cex_watch_frames_received_total",
		labels,
	);

	if (!canArchiveMarketData(archiver)) {
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
			rethrowArchiveDurabilityError(error);
			log.warn(`Failed to archive ${stream} market data`, { error });
		}
	});
}

export function archiveTradesInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	input: TradesArchiveInput,
): void {
	archiveMarketRowsInBackground(
		archiver,
		otelMetrics,
		"trades",
		input,
		"TRADES",
		() => {
			if (!archiver) return [];
			const trades = extractTrades(input.payload, input.receivedTimestamp);
			if (trades.length === 0) return [];
			const context = resolveCaptureContext(
				archiver,
				input,
				"TRADES",
				"broker_live_stream_v1",
			);
			const raw = createRawCapture(context, {
				payload: input.payload,
				eventTimeMs: trades[0]?.eventTimeMs ?? input.receivedTimestamp,
				receivedTimeMs: input.receivedTimestamp,
				scope: "ccxt_normalized_object",
			});
			return [
				buildCanonicalCexStreamEventRow(context, raw),
				...trades.map((trade) => buildCanonicalTradeRow(context, raw, trade)),
			];
		},
	);
}

export function archiveTickerInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	input: TickerArchiveInput,
): void {
	archiveMarketRowsInBackground(
		archiver,
		otelMetrics,
		"ticker",
		input,
		"TICKER",
		() => {
			const ticker = parseTicker(input.payload, input.receivedTimestamp);
			if (!ticker || !archiver) return [];
			const context = resolveCaptureContext(
				archiver,
				input,
				"TICKER",
				"broker_live_stream_v1",
			);
			const raw = createRawCapture(context, {
				payload: input.payload,
				eventTimeMs: ticker.eventTimeMs,
				receivedTimeMs: input.receivedTimestamp,
				scope: "ccxt_normalized_object",
			});
			return [
				buildCanonicalCexStreamEventRow(context, raw),
				buildCanonicalTickerEventRow(context, raw, ticker),
			];
		},
	);
}

export function archiveCexStreamEventInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	input: CexStreamArchiveInput,
): void {
	if (input.streamType === "ORDERBOOK") {
		throw new Error(
			"Generic ORDERBOOK archive events are unsupported; use archiveOrderbookInBackground",
		);
	}
	archiveMarketRowsInBackground(
		archiver,
		otelMetrics,
		"stream",
		input,
		input.streamType,
		() => [
			buildCexStreamEventRow({
				...input,
				source: archiver?.getSource(),
			}),
		],
	);
}
