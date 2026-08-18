import { describe, expect, test } from "bun:test";
import type { SubscribeResponse } from "../src/handlers/types";
import { SubscriptionType } from "../src/helpers/constants";
import {
	buildPublicFeedKey,
	encodeSubscribeResponseWireSize,
	evaluateImmediateHedgeability,
	evaluateOrderBookBandCoverage,
	PUBLIC_FEED_SUBSCRIBER_BYTE_LIMIT,
	PUBLIC_FEED_SUBSCRIBER_FRAME_LIMIT,
	PublicFeedSubscriberBuffer,
	projectOrderBookSnapshot,
	resolveOrderBookAcquisitionProfile,
} from "../src/helpers/public-market-data-feed";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../src/proto-package-definition";

function frame(data: string, timestamp = 1): SubscribeResponse {
	return {
		data,
		timestamp,
		symbol: "BTC/USDT",
		type: SubscriptionType.ORDERBOOK,
	};
}

describe("PublicFeedSubscriberBuffer", () => {
	test("retains frames in FIFO order and tracks full protobuf wire bytes", async () => {
		const first = frame("α");
		const second = frame("second", 2);
		const buffer = new PublicFeedSubscriberBuffer({
			frameLimit: 2,
			byteLimit:
				encodeSubscribeResponseWireSize(first) +
				encodeSubscribeResponseWireSize(second),
		});

		expect(buffer.enqueue(first)).toBe(true);
		expect(buffer.enqueue(second)).toBe(true);
		expect(buffer.queuedBytes).toBe(
			encodeSubscribeResponseWireSize(first) +
				encodeSubscribeResponseWireSize(second),
		);

		const iterator = buffer[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toEqual(first);
		expect((await iterator.next()).value).toEqual(second);
		expect(buffer.queuedBytes).toBe(0);
		buffer.close();
		expect((await iterator.next()).done).toBe(true);
	});

	test("uses the production 16-frame and 1 MiB limits by default", () => {
		const buffer = new PublicFeedSubscriberBuffer();
		expect(buffer.frameLimit).toBe(PUBLIC_FEED_SUBSCRIBER_FRAME_LIMIT);
		expect(buffer.byteLimit).toBe(PUBLIC_FEED_SUBSCRIBER_BYTE_LIMIT);
	});

	test("fails an empty buffer when one wire frame exceeds byte capacity", async () => {
		const buffer = new PublicFeedSubscriberBuffer({
			frameLimit: 16,
			byteLimit: encodeSubscribeResponseWireSize(frame("x")) - 1,
		});

		expect(buffer.enqueue(frame("x"))).toBe(false);
		expect(buffer.queuedFrames).toBe(0);
		await expect(buffer[Symbol.asyncIterator]().next()).rejects.toThrow(
			"Public market-data subscriber fell behind",
		);
	});

	test("fails at the injected count boundary and releases queued bytes", async () => {
		const buffer = new PublicFeedSubscriberBuffer({
			frameLimit: 1,
			byteLimit: 1_000,
		});
		expect(buffer.enqueue(frame("first"))).toBe(true);
		expect(buffer.enqueue(frame("second"))).toBe(false);
		expect(buffer.queuedFrames).toBe(0);
		expect(buffer.queuedBytes).toBe(0);
		await expect(buffer[Symbol.asyncIterator]().next()).rejects.toThrow(
			"Public market-data subscriber fell behind",
		);
	});

	test("wire-size accounting matches the gRPC response serializer", () => {
		const service = CEX_BROKER_PACKAGE_DEFINITION[
			"cex_broker.cex_service"
		] as unknown as {
			Subscribe: { responseSerialize(value: SubscribeResponse): Buffer };
		};
		const response = frame("utf8-€", 1_770_000_000_001);
		expect(encodeSubscribeResponseWireSize(response)).toBe(
			service.Subscribe.responseSerialize(response).byteLength,
		);
	});
});

describe("public feed canonical identity", () => {
	test("normalizes exchange and defaults OHLCV timeframe to 1m", () => {
		expect(
			buildPublicFeedKey({
				exchange: "  Binance ",
				symbol: "BTC/USDT",
				marketType: "spot",
				feed: "OHLCV",
				timeframe: "",
			}),
		).toBe("binance|BTC/USDT|spot|OHLCV|1m");
	});

	test("uses acquisition profile rather than raw subscriber depth", () => {
		const profile = resolveOrderBookAcquisitionProfile({
			exchange: "binance",
			requestedDepth: 25,
			archiveDepth: 100,
		});
		const first = buildPublicFeedKey({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "ORDERBOOK",
			acquisitionProfileId: profile.id,
		});
		const second = buildPublicFeedKey({
			exchange: "BINANCE",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "ORDERBOOK",
			acquisitionProfileId: resolveOrderBookAcquisitionProfile({
				exchange: "binance",
				requestedDepth: undefined,
				archiveDepth: 100,
			}).id,
		});
		expect(second).toBe(first);
	});
});

describe("ORDERBOOK acquisition profiles", () => {
	test.each([
		"binance",
		"mexc",
	])("coalesces compatible explicit and omitted %s depths", (exchange) => {
		const explicit = resolveOrderBookAcquisitionProfile({
			exchange,
			requestedDepth: 100,
			archiveDepth: 100,
		});
		const omitted = resolveOrderBookAcquisitionProfile({
			exchange,
			requestedDepth: undefined,
			archiveDepth: 100,
		});
		expect(explicit).toEqual(omitted);
		expect(explicit).toMatchObject({
			id: `${exchange}:l2-diff:500`,
			upstreamLimit: 500,
			guaranteedRetainedDepth: 500,
			coalescingSupported: true,
		});
	});

	test("falls back to exact and omitted conservative identities", () => {
		expect(
			resolveOrderBookAcquisitionProfile({
				exchange: "kraken",
				requestedDepth: 25,
				archiveDepth: 10,
			}),
		).toMatchObject({
			id: "kraken:conservative:limit:25",
			upstreamLimit: 25,
			guaranteedRetainedDepth: 25,
			coalescingSupported: false,
		});
		expect(
			resolveOrderBookAcquisitionProfile({
				exchange: "kraken",
				requestedDepth: undefined,
				archiveDepth: 25,
			}),
		).toMatchObject({
			id: "kraken:conservative:default",
			upstreamLimit: undefined,
			guaranteedRetainedDepth: undefined,
			coalescingSupported: false,
		});
	});

	test("isolates a request deeper than the verified profile", () => {
		const profile = resolveOrderBookAcquisitionProfile({
			exchange: "binance",
			requestedDepth: 501,
			archiveDepth: 25,
		});
		expect(profile.id).toBe("binance:conservative:limit:501");
		expect(profile.coalescingSupported).toBe(false);
	});
});

describe("ORDERBOOK projection and Maker band coverage", () => {
	const snapshot = {
		bids: [
			[100, 1],
			[99, 2],
			[98, 3],
		],
		asks: [
			[101, 4],
			[102, 5],
			[103, 6],
		],
		timestamp: 1,
		receivedTimestamp: 2,
		exchange: "binance",
		symbol: "BTC/USDT",
		depthLimit: 3,
	};

	test("projects explicit depth while omitted depth reports retained depth", () => {
		expect(projectOrderBookSnapshot(snapshot, 1)).toMatchObject({
			bids: [[100, 1]],
			asks: [[101, 4]],
			depthLimit: 1,
		});
		expect(projectOrderBookSnapshot(snapshot, undefined)).toMatchObject({
			bids: snapshot.bids,
			asks: snapshot.asks,
			depthLimit: 3,
		});
	});

	test("proves both sides cross the configured price band", () => {
		expect(evaluateOrderBookBandCoverage(snapshot, 150)).toMatchObject({
			covered: true,
			bid: { covered: true },
			ask: { covered: true },
		});
	});

	test("a nominal level count does not prove a wider band", () => {
		const coverage = evaluateOrderBookBandCoverage(snapshot, 500);
		expect(coverage.covered).toBe(false);
		expect(coverage.bid).toMatchObject({ covered: false, farthestPrice: 98 });
		expect(coverage.ask).toMatchObject({ covered: false, farthestPrice: 103 });
		expect(coverage.diagnostics.join(" ")).toContain("500bps");
	});

	test("derives the immediate sell and buy caps from aggregate L2 bands", () => {
		const evidence = evaluateImmediateHedgeability(snapshot, 150);
		expect(evidence).toMatchObject({
			covered: true,
			bidDepth: 3,
			askDepth: 9,
			limitingSide: "bid",
			liquidityCap: 3,
		});
	});

	test("live and archive policy inputs are equal only when retained depth covers the band", () => {
		const live = evaluateImmediateHedgeability(snapshot, 150);
		const archived = evaluateImmediateHedgeability(
			{
				...snapshot,
				bids: snapshot.bids.slice(0, 2),
				asks: snapshot.asks.slice(0, 2),
			},
			150,
		);
		expect(live.covered).toBe(true);
		expect(archived.covered).toBe(false);
		expect(archived.diagnostics.join(" ")).toContain("150bps ask");
	});
});
