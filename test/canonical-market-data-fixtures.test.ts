import { describe, expect, test } from "bun:test";
import { buildCanonicalOrderBookRows } from "../src/helpers/market-data-archive/canonical-orderbook";
import { createRawCapture } from "../src/helpers/market-data-archive/capture-contract";
import {
	buildCanonicalCexStreamEventRow,
	buildCanonicalOhlcvRow,
	buildCanonicalTickerEventRow,
	buildCanonicalTradeRow,
} from "../src/helpers/market-data-archive/rows";
import type {
	CaptureFeed,
	CaptureSourceMode,
	MarketCaptureContext,
} from "../src/helpers/market-data-archive/types";
import fixture from "./fixtures/canonical-market-capture-v1.json" with {
	type: "json",
};

type FixtureCapture = {
	feed: CaptureFeed;
	sourceMode: CaptureSourceMode;
	timeframe?: string;
	payload: unknown;
	eventTimeMs: number;
	receivedTimeMs: number;
	expected: Record<string, string>;
};

function context(capture: FixtureCapture): MarketCaptureContext {
	return {
		...fixture.context,
		source: "broker_read",
		assetType: "spot",
		feed: capture.feed,
		sourceMode: capture.sourceMode,
		timeframe: capture.timeframe,
	};
}

function raw(capture: FixtureCapture) {
	return createRawCapture(context(capture), {
		payload: capture.payload,
		eventTimeMs: capture.eventTimeMs,
		receivedTimeMs: capture.receivedTimeMs,
		scope: "ccxt_normalized_object",
	});
}

function expectIdentity(
	capture: FixtureCapture,
	actual: { rawCaptureId: string; rawChecksum: string },
	rowChecksum: unknown,
): void {
	expect(actual.rawCaptureId).toBe(capture.expected.raw_capture_id);
	expect(actual.rawChecksum).toBe(capture.expected.raw_checksum);
	expect(rowChecksum).toBe(capture.expected.normalized_row_checksum);
}

describe("canonical market-data golden fixture v1", () => {
	test("reproduces stream, ticker, trade, and OHLCV identities", () => {
		const stream = fixture.stream as FixtureCapture;
		const streamRaw = raw(stream);
		expectIdentity(
			stream,
			streamRaw,
			buildCanonicalCexStreamEventRow(context(stream), streamRaw).row
				.normalized_row_checksum,
		);

		const ticker = fixture.ticker as FixtureCapture & {
			normalized: Parameters<typeof buildCanonicalTickerEventRow>[2];
		};
		const tickerRaw = raw(ticker);
		expectIdentity(
			ticker,
			tickerRaw,
			buildCanonicalTickerEventRow(
				context(ticker),
				tickerRaw,
				ticker.normalized,
			).row.normalized_row_checksum,
		);

		const trade = fixture.trade as FixtureCapture & {
			normalized: Parameters<typeof buildCanonicalTradeRow>[2];
		};
		const tradeRaw = raw(trade);
		expectIdentity(
			trade,
			tradeRaw,
			buildCanonicalTradeRow(context(trade), tradeRaw, trade.normalized).row
				.normalized_row_checksum,
		);

		const ohlcv = fixture.ohlcv as FixtureCapture & {
			bar: Parameters<typeof buildCanonicalOhlcvRow>[0]["bar"];
			isClosed: boolean;
			brokerVersion: number;
		};
		const ohlcvRaw = raw(ohlcv);
		expectIdentity(
			ohlcv,
			ohlcvRaw,
			buildCanonicalOhlcvRow({
				context: context(ohlcv),
				rawCapture: ohlcvRaw,
				bar: ohlcv.bar,
				isClosed: ohlcv.isClosed,
				brokerVersion: ohlcv.brokerVersion,
			}).row.normalized_row_checksum,
		);
	});

	test("reproduces order-book level and summary identities", () => {
		const capture = fixture.orderbook as FixtureCapture & {
			depthLimit: number;
			payload: {
				bids: number[][];
				asks: number[][];
				timestamp: number;
				sequence: number;
			};
		};
		const rawCapture = raw(capture);
		const snapshot = {
			...capture.payload,
			receivedTimestamp: capture.receivedTimeMs,
			exchange: fixture.context.exchange,
			symbol: fixture.context.symbol,
			depthLimit: capture.depthLimit,
		};
		const rows = buildCanonicalOrderBookRows({
			context: context(capture),
			rawCapture,
			depthLimit: capture.depthLimit,
			snapshot,
			archiveMetadata: {
				captureProfileId: "fixture:orderbook:v2",
				effectiveCadenceMs: 1_000,
				requestedUpstreamDepth: capture.depthLimit,
				observedBidCount: snapshot.bids.length,
				observedAskCount: snapshot.asks.length,
				observedFarthestBid: snapshot.bids.at(-1)?.[0] ?? Number.NaN,
				observedFarthestAsk: snapshot.asks.at(-1)?.[0] ?? Number.NaN,
				exhaustionEvidence: {
					bid: { exhausted: false, validated: true, source: "fixture" },
					ask: { exhausted: false, validated: true, source: "fixture" },
				},
				measurementBandsBps: [10, 25, 50, 100],
			},
		});
		expect(rawCapture.rawCaptureId).toBe(capture.expected.raw_capture_id);
		expect(rawCapture.rawChecksum).toBe(capture.expected.raw_checksum);
		expect(rows.snapshotId).toBe(capture.expected.snapshot_id);
		expect(rows.levels[0]?.row.normalized_row_checksum).toBe(
			capture.expected.level_normalized_row_checksum,
		);
		expect(rows.summary.row.schema_version).toBe(
			capture.expected.summary_schema_version,
		);
		expect(String(rows.summary.row.normalized_row_checksum)).toHaveLength(64);
	});
});
