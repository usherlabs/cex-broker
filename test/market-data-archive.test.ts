import { describe, expect, test } from "bun:test";
import type { BrokerExecutionArchiver } from "../src/helpers/broker-execution-archive";
import { archiveTickerInBackground } from "../src/helpers/market-data-archive/capture";
import {
	extractLatestOhlcvBar,
	extractOhlcvBars,
	OhlcvBarTracker,
	parseOhlcvBar,
} from "../src/helpers/market-data-archive/ohlcv-bar-tracker";
import { resolveOhlcvBootstrapLimit } from "../src/helpers/market-data-archive/ohlcv-bootstrap";
import { splitOrderBookSide } from "../src/helpers/market-data-archive/orderbook-depth";
import { OrderbookSampler } from "../src/helpers/market-data-archive/orderbook-sampler";
import {
	extractTrades,
	parseTicker,
} from "../src/helpers/market-data-archive/parse-stream";
import { buildCexStreamEventRow } from "../src/helpers/market-data-archive/rows";

describe("market data archive rows", () => {
	test("splitOrderBookSide ignores malformed levels", () => {
		expect(
			splitOrderBookSide(
				[[100, 1], ["bad", 2] as unknown as number[], [99, 3]],
				5,
			).prices,
		).toEqual([100, 99]);
	});

	test("buildCexStreamEventRow stores redacted stream payload", () => {
		const row = buildCexStreamEventRow({
			deploymentId: "deploy-a",
			exchange: "binance",
			symbol: "BTC/USDT",
			assetType: "spot",
			streamType: "BALANCE",
			payload: { apiSecret: "hidden", total: 100 },
			receivedTimestamp: 1_700_000_000_500,
		});

		expect(row.table).toBe("market_data.cex_stream_events");
		expect(JSON.stringify(row.row)).not.toContain("hidden");
	});

	test("incomplete production provenance skips market payload processing", () => {
		const originalEnvironment =
			process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT;
		const originalBundle = process.env.CEX_BROKER_CAPTURE_BUNDLE_ID;
		const originalMarketEnabled = process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
		let payloadReads = 0;
		const payload = Object.defineProperty({}, "timestamp", {
			get() {
				payloadReads += 1;
				return 1_700_000_000_000;
			},
		});
		const archiver = {
			isEnabled: () => true,
			getDeploymentId: () => "unknown",
			getSource: () => "broker_write" as const,
			enqueue: () => {
				throw new Error("ineligible market archive must not enqueue");
			},
		} as unknown as BrokerExecutionArchiver;

		try {
			process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT = "production";
			delete process.env.CEX_BROKER_CAPTURE_BUNDLE_ID;
			delete process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
			archiveTickerInBackground(archiver, undefined, {
				exchange: "binance",
				symbol: "BTC/USDT",
				assetType: "spot",
				deploymentId: "unknown",
				payload,
				receivedTimestamp: 1_700_000_000_100,
			});
			expect(payloadReads).toBe(0);
		} finally {
			if (originalEnvironment === undefined) {
				delete process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT;
			} else {
				process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT = originalEnvironment;
			}
			if (originalBundle === undefined) {
				delete process.env.CEX_BROKER_CAPTURE_BUNDLE_ID;
			} else {
				process.env.CEX_BROKER_CAPTURE_BUNDLE_ID = originalBundle;
			}
			if (originalMarketEnabled === undefined) {
				delete process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED;
			} else {
				process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = originalMarketEnabled;
			}
		}
	});
});

describe("orderbook sampler", () => {
	test("emits first sample immediately then respects interval", () => {
		const sampler = new OrderbookSampler(1_000);

		expect(sampler.shouldEmit(1_000)).toBe(true);
		expect(sampler.shouldEmit(1_500)).toBe(false);
		expect(sampler.shouldEmit(2_000)).toBe(true);
	});

	test("resets sampling window after clock rollback", () => {
		const sampler = new OrderbookSampler(1_000);

		expect(sampler.shouldEmit(2_000)).toBe(true);
		expect(sampler.shouldEmit(1_500)).toBe(true);
		expect(sampler.shouldEmit(1_600)).toBe(false);
		expect(sampler.shouldEmit(2_600)).toBe(true);
	});
});

describe("ohlcv bar tracker", () => {
	const snapshot = Array.from({ length: 500 }, (_, index) => [
		1_700_000_000_000 + index * 60_000,
		1,
		2,
		0.5,
		1.5,
		10,
	]);

	test("parseOhlcvBar accepts CCXT tuple shape", () => {
		expect(parseOhlcvBar([1_000, 1, 2, 0.5, 1.5, 10, 15])).toEqual({
			openTimeMs: 1_000,
			open: 1,
			high: 2,
			low: 0.5,
			close: 1.5,
			volume: 10,
			quoteVolume: 15,
		});
	});

	test("extractLatestOhlcvBar uses the last bar from arrays", () => {
		expect(
			extractLatestOhlcvBar([
				[1_000, 1, 2, 0.5, 1.5, 10],
				[2_000, 2, 3, 1.5, 2.5, 20],
			])?.openTimeMs,
		).toBe(2_000);
	});

	test("extractOhlcvBars deduplicates and sorts bars", () => {
		expect(
			extractOhlcvBars([
				[2_000, 2, 3, 1.5, 2.5, 20],
				[1_000, 1, 2, 0.5, 1.5, 10],
			]).map((bar) => bar.openTimeMs),
		).toEqual([1_000, 2_000]);
	});

	test("closes previous bar when open time advances", () => {
		const tracker = new OhlcvBarTracker();

		expect(tracker.process([[1_000, 1, 2, 0.5, 1.5, 10]], 100)).toEqual([
			{
				bar: {
					openTimeMs: 1_000,
					open: 1,
					high: 2,
					low: 0.5,
					close: 1.5,
					volume: 10,
				},
				isClosed: false,
				brokerVersion: 100,
			},
		]);

		expect(tracker.process([[2_000, 2, 3, 1.5, 2.5, 20]], 200)).toEqual([
			{
				bar: {
					openTimeMs: 1_000,
					open: 1,
					high: 2,
					low: 0.5,
					close: 1.5,
					volume: 10,
				},
				isClosed: true,
				brokerVersion: 200,
			},
			{
				bar: {
					openTimeMs: 2_000,
					open: 2,
					high: 3,
					low: 1.5,
					close: 2.5,
					volume: 20,
				},
				isClosed: false,
				brokerVersion: 200,
			},
		]);
	});

	test("preserves all bars in the first batch and leaves the newest open", () => {
		const tracker = new OhlcvBarTracker();

		const candidates = tracker.process(snapshot, 100);

		expect(candidates).toHaveLength(500);
		expect(
			candidates.map(({ bar, isClosed }) => ({
				openTimeMs: bar.openTimeMs,
				isClosed,
			})),
		).toEqual(
			snapshot.map(([openTimeMs], index) => ({
				openTimeMs,
				isClosed: index < snapshot.length - 1,
			})),
		);
	});

	test("repeated snapshot only re-emits the open bar update", () => {
		const tracker = new OhlcvBarTracker();
		tracker.process(snapshot, 100);

		const candidates = tracker.process(snapshot, 200);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			bar: { openTimeMs: snapshot.at(-1)?.[0] },
			isClosed: false,
			brokerVersion: 200,
		});
	});

	test("overlapping snapshot closes the previous open bar and emits the new open bar", () => {
		const tracker = new OhlcvBarTracker();
		tracker.process(snapshot, 100);
		const previousOpenTimeMs = snapshot.at(-1)?.[0] ?? 0;
		const nextOpenTimeMs = previousOpenTimeMs + 60_000;
		const overlappingSnapshot = [
			...snapshot.slice(1),
			[nextOpenTimeMs, 1.5, 2.5, 1, 2, 12],
		];

		const candidates = tracker.process(overlappingSnapshot, 200);

		expect(
			candidates.map(({ bar, isClosed, brokerVersion }) => ({
				openTimeMs: bar.openTimeMs,
				isClosed,
				brokerVersion,
			})),
		).toEqual([
			{ openTimeMs: previousOpenTimeMs, isClosed: true, brokerVersion: 200 },
			{ openTimeMs: nextOpenTimeMs, isClosed: false, brokerVersion: 200 },
		]);
	});
});

describe("ohlcv bootstrap limit", () => {
	test("resolveOhlcvBootstrapLimit clamps to configured bounds", () => {
		expect(resolveOhlcvBootstrapLimit("5000")).toBe(1000);
		expect(resolveOhlcvBootstrapLimit("50")).toBe(50);
		expect(resolveOhlcvBootstrapLimit("0")).toBe(0);
	});
});

describe("parse stream helpers", () => {
	test("parseTicker extracts ticker fields", () => {
		expect(
			parseTicker({
				last: 100,
				bid: 99.5,
				ask: 100.5,
				timestamp: 1_000,
			}),
		).toMatchObject({
			last: 100,
			bid: 99.5,
			ask: 100.5,
			eventTimeMs: 1_000_000,
		});
	});

	test("extractTrades normalizes trade arrays", () => {
		expect(
			extractTrades([
				{
					id: "1",
					timestamp: 1_000,
					side: "buy",
					price: 100,
					amount: 0.1,
				},
			]),
		).toEqual([
			expect.objectContaining({
				tradeId: "1",
				side: "buy",
				price: 100,
				amount: 0.1,
			}),
		]);
	});
});
