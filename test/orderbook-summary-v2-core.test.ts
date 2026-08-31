import { afterEach, describe, expect, test } from "bun:test";
import { buildCanonicalOrderBookRows } from "../src/helpers/market-data-archive/canonical-orderbook";
import {
	canonicalSerialize,
	createRawCapture,
	projectRawCapturePayload,
} from "../src/helpers/market-data-archive/capture-contract";
import {
	getOrderbookArchiveDepthLimit,
	getOrderbookMeasurementBandsBps,
} from "../src/helpers/market-data-archive/orderbook-depth";
import { buildCanonicalCexStreamEventRow } from "../src/helpers/market-data-archive/rows";
import type {
	MarketCaptureContext,
	OrderbookArchiveMetadata,
	OrderbookMetadataOnlyPayload,
} from "../src/helpers/market-data-archive/types";
import type { NormalizedOrderBookSnapshot } from "../src/helpers/order-book";

const context: MarketCaptureContext = {
	source: "broker_read",
	deploymentId: "collector-a",
	captureBundleId: "bundle-a",
	exchange: "binance",
	symbol: "BTC/USDT",
	assetType: "spot",
	feed: "ORDERBOOK",
	provider: "ccxt:binance",
	sourceMode: "broker_live_sampling_v1",
	schemaVersion: "1.0.0",
	checksumAlgorithm: "sha256-canonical-json-v1",
	provenanceComplete: true,
};

function book(
	overrides: Partial<NormalizedOrderBookSnapshot> = {},
): NormalizedOrderBookSnapshot {
	return {
		bids: [
			[100, 1],
			[99.95, 2],
			[99.8, 3],
			[99, 4],
		],
		asks: [
			[100.2, 5],
			[100.25, 6],
			[100.4, 7],
			[101, 8],
		],
		timestamp: 1_700_000_000_000,
		receivedTimestamp: 1_700_000_000_100,
		exchange: "binance",
		symbol: "BTC/USDT",
		depthLimit: 4,
		sequence: 42,
		...overrides,
	};
}

function metadata(
	snapshot: NormalizedOrderBookSnapshot,
	overrides: Partial<OrderbookArchiveMetadata> = {},
): OrderbookArchiveMetadata {
	return {
		captureProfileId: "binance:l2-diff:500",
		effectiveCadenceMs: 1_000,
		requestedUpstreamDepth: 500,
		observedBidCount: snapshot.bids.length,
		observedAskCount: snapshot.asks.length,
		observedFarthestBid: snapshot.bids.at(-1)?.[0] ?? Number.NaN,
		observedFarthestAsk: snapshot.asks.at(-1)?.[0] ?? Number.NaN,
		exhaustionEvidence: {
			bid: { exhausted: false, validated: true, source: "fixture" },
			ask: { exhausted: false, validated: true, source: "fixture" },
		},
		measurementBandsBps: [100, 10, 25, 10],
		...overrides,
	};
}

function build(
	snapshot = book(),
	overrides: Partial<OrderbookArchiveMetadata> = {},
) {
	const raw = createRawCapture(context, {
		payload: snapshot,
		eventTimeMs: snapshot.timestamp,
		receivedTimeMs: snapshot.receivedTimestamp,
		scope: "ccxt_normalized_object",
	});
	return {
		raw,
		rows: buildCanonicalOrderBookRows({
			context,
			snapshot,
			rawCapture: raw,
			depthLimit: 2,
			archiveMetadata: metadata(snapshot, overrides),
		}),
	};
}

function rawMetadata(
	snapshot: NormalizedOrderBookSnapshot,
	archiveMetadata: OrderbookArchiveMetadata,
): OrderbookMetadataOnlyPayload {
	return {
		capture_profile_id: archiveMetadata.captureProfileId,
		effective_cadence_ms: archiveMetadata.effectiveCadenceMs,
		requested_upstream_depth: archiveMetadata.requestedUpstreamDepth,
		archive_depth_limit: 2,
		observed_bid_count: archiveMetadata.observedBidCount,
		observed_ask_count: archiveMetadata.observedAskCount,
		observed_farthest_bid: String(snapshot.bids.at(-1)?.[0]),
		observed_farthest_ask: String(snapshot.asks.at(-1)?.[0]),
		bid_exhausted: archiveMetadata.exhaustionEvidence.bid.exhausted,
		ask_exhausted: archiveMetadata.exhaustionEvidence.ask.exhausted,
		retained_bid_count: 2,
		retained_ask_count: 2,
		measurement_bands_bps: [10, 25, 100],
	};
}

describe("ORDERBOOK summary v2 core", () => {
	test("summarizes the complete observation before retaining top N", () => {
		const { raw, rows } = build();
		expect(rows.levels).toHaveLength(4);
		expect(rows.levels.every(({ row }) => row.schema_version === "1.0.0")).toBe(
			true,
		);
		expect(rows.summary.row).toMatchObject({
			schema_version: "2.0.0",
			raw_capture_id: raw.rawCaptureId,
			raw_checksum: raw.rawChecksum,
			capture_profile_id: "binance:l2-diff:500",
			effective_cadence_ms: 1_000,
			requested_upstream_depth: 500,
			observed_bid_count: 4,
			observed_ask_count: 4,
			retained_farthest_bid: 99.95,
			retained_farthest_ask: 100.25,
			bid_level_count: 2,
			ask_level_count: 2,
			measurement_bands_bps: [10, 25, 100],
		});
		expect(rows.summary.row.bid_boundary_price_by_band).toEqual([
			99.9999, 99.84975, 99.09899999999999,
		]);
		expect(rows.summary.row.ask_boundary_price_by_band).toEqual([
			100.20009999999998, 100.35024999999999, 101.101,
		]);
		expect(rows.summary.row.bid_depth_by_band).toEqual([1, 3, 6]);
		expect(rows.summary.row.ask_depth_by_band).toEqual([5, 11, 26]);
		expect(rows.summary.row.bid_status_by_band).toEqual([
			"exact",
			"exact",
			"exact",
		]);
		expect(rows.summary.row.ask_status_by_band).toEqual([
			"exact",
			"exact",
			"censored",
		]);
	});

	test("short counts stay censored unless validated exhaustion is explicit", () => {
		const snapshot = book({
			bids: [[100, 1]],
			asks: [[100.2, 5]],
		});
		const censored = build(snapshot).rows.summary.row;
		expect(censored.bid_status_by_band).toEqual([
			"censored",
			"censored",
			"censored",
		]);
		expect(censored.ask_status_by_band).toEqual([
			"censored",
			"censored",
			"censored",
		]);
		const exhausted = build(snapshot, {
			exhaustionEvidence: {
				bid: { exhausted: true, validated: true, source: "fixture" },
				ask: { exhausted: true, validated: true, source: "fixture" },
			},
		}).rows.summary.row;
		expect(exhausted.bid_status_by_band).toEqual(["exact", "exact", "exact"]);
		expect(exhausted.ask_status_by_band).toEqual(["exact", "exact", "exact"]);
	});

	test.each([
		["empty bid", book({ bids: [] }), {}],
		["empty ask", book({ asks: [] }), {}],
		["missing profile", book(), { captureProfileId: "" }],
		["zero cadence", book(), { effectiveCadenceMs: 0 }],
		["invalid requested depth", book(), { requestedUpstreamDepth: 501 }],
		["conflicting count", book(), { observedBidCount: 3 }],
		["conflicting boundary", book(), { observedFarthestAsk: 999 }],
		["empty bands", book(), { measurementBandsBps: [] }],
		["band above 10000 bps", book(), { measurementBandsBps: [10_001] }],
		[
			"more than 64 unique bands",
			book(),
			{
				measurementBandsBps: Array.from(
					{ length: 65 },
					(_, index) => index + 1,
				),
			},
		],
	] as const)("rejects %s metadata", (_name, snapshot, overrides) => {
		expect(() => build(snapshot, overrides)).toThrow();
	});

	test("summary schema version does not change stable raw or retained snapshot identity", () => {
		const first = build();
		const second = build();
		expect(second.raw.rawCaptureId).toBe(first.raw.rawCaptureId);
		expect(second.rows.snapshotId).toBe(first.rows.snapshotId);
		expect(first.rows.levels[0]?.row.schema_version).toBe("1.0.0");
		expect(first.rows.summary.row.schema_version).toBe("2.0.0");
		expect(first.rows.summary.row.normalized_row_checksum).not.toBe(
			first.rows.levels[0]?.row.normalized_row_checksum,
		);
	});
});

describe("ORDERBOOK metadata-only raw capture", () => {
	test("stores exactly 13 metadata keys while retaining complete-observation identity", () => {
		const snapshot = book();
		const archiveMetadata = metadata(snapshot);
		const complete = createRawCapture(context, {
			payload: snapshot,
			eventTimeMs: snapshot.timestamp,
			receivedTimeMs: snapshot.receivedTimestamp,
			scope: "ccxt_normalized_object",
		});
		const payload = rawMetadata(snapshot, archiveMetadata);
		const stored = projectRawCapturePayload(complete, payload);
		const row = buildCanonicalCexStreamEventRow(context, stored, {
			payloadEncoding: "orderbook_metadata_only_v1",
		});
		const parsed = JSON.parse(String(row.row.payload_json));
		expect(Object.keys(parsed).sort()).toEqual(
			[
				"archive_depth_limit",
				"ask_exhausted",
				"bid_exhausted",
				"capture_profile_id",
				"effective_cadence_ms",
				"measurement_bands_bps",
				"observed_ask_count",
				"observed_bid_count",
				"observed_farthest_ask",
				"observed_farthest_bid",
				"requested_upstream_depth",
				"retained_ask_count",
				"retained_bid_count",
			].sort(),
		);
		expect(row.row.payload_encoding).toBe("orderbook_metadata_only_v1");
		expect(canonicalSerialize(parsed)).not.toContain("bids");
		expect(canonicalSerialize(parsed)).not.toContain("asks");
		expect(row.row.raw_capture_id).toBe(complete.rawCaptureId);
		expect(row.row.raw_checksum).toBe(complete.rawChecksum);
	});

	test("discarded deep-level changes alter identity without changing the raw shape", () => {
		const firstSnapshot = book();
		const secondSnapshot = book({
			bids: [...firstSnapshot.bids.slice(0, -1), [98.5, 4]],
		});
		const first = build(firstSnapshot);
		const second = build(secondSnapshot);
		expect(second.rows.snapshotId).toBe(first.rows.snapshotId);
		expect(second.raw.rawCaptureId).not.toBe(first.raw.rawCaptureId);
		const firstPayload = rawMetadata(firstSnapshot, metadata(firstSnapshot));
		const secondPayload = rawMetadata(secondSnapshot, metadata(secondSnapshot));
		expect(Object.keys(secondPayload)).toEqual(Object.keys(firstPayload));
	});
});

describe("ORDERBOOK archive configuration", () => {
	const originalDepth = process.env.CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT;
	const originalBands = process.env.CEX_BROKER_ORDERBOOK_MEASUREMENT_BANDS_BPS;

	afterEach(() => {
		if (originalDepth === undefined) {
			delete process.env.CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT;
		} else {
			process.env.CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT = originalDepth;
		}
		if (originalBands === undefined) {
			delete process.env.CEX_BROKER_ORDERBOOK_MEASUREMENT_BANDS_BPS;
		} else {
			process.env.CEX_BROKER_ORDERBOOK_MEASUREMENT_BANDS_BPS = originalBands;
		}
	});

	test("defaults and normalizes valid values", () => {
		delete process.env.CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT;
		delete process.env.CEX_BROKER_ORDERBOOK_MEASUREMENT_BANDS_BPS;
		expect(getOrderbookArchiveDepthLimit()).toBe(25);
		expect(getOrderbookMeasurementBandsBps()).toEqual([10, 25, 50, 100]);
		process.env.CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT = "500";
		process.env.CEX_BROKER_ORDERBOOK_MEASUREMENT_BANDS_BPS = "100,10,25,10";
		expect(getOrderbookArchiveDepthLimit()).toBe(500);
		expect(getOrderbookMeasurementBandsBps()).toEqual([10, 25, 100]);
	});

	test.each([
		"0",
		"501",
		"1.5",
		"bad",
	])("rejects invalid depth %s instead of clamping or defaulting", (value) => {
		process.env.CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT = value;
		expect(() => getOrderbookArchiveDepthLimit()).toThrow("1 and 500");
	});
});
