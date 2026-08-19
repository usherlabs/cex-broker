import { describe, expect, test } from "bun:test";
import { handleArchiveRequest } from "../services/archive-forwarder/request";
import {
	ArchiveForwarderTelemetry,
	type ArchiveMetricsRecorder,
} from "../services/archive-forwarder/telemetry";
import { buildCanonicalOrderBookRows } from "../src/helpers/market-data-archive/canonical-orderbook";
import { createMarketCaptureContext } from "../src/helpers/market-data-archive/capture-context";
import {
	BACKFILL_PROMOTION_SCHEMA_VERSION,
	EXTERNAL_BACKFILL_SOURCE,
	type PromotionReceipt,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	finalizePromotionReceipt,
	promotionReceiptToArchiveRow,
} from "../src/helpers/market-data-vendor-backfill/promotion";

const noopRecorder: ArchiveMetricsRecorder = {
	recordCounter: () => {},
	setObservableGauge: () => {},
};

function post(body: unknown): Request {
	return new Request("http://localhost/archive", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function receipt(): PromotionReceipt {
	return finalizePromotionReceipt(
		{
			schemaVersion: BACKFILL_PROMOTION_SCHEMA_VERSION,
			requestId: "maker-run-a",
			idempotencyKey: "1".repeat(64),
			status: "passing",
			source: EXTERNAL_BACKFILL_SOURCE,
			provider: "cryptohftdata",
			adapterVersion: "cryptohftdata-orderbook/v1",
			captureBundleId: "2".repeat(64),
			exchange: "binance",
			tradingPair: "BTC-USDT",
			marketType: "spot",
			feed: "ORDERBOOK",
			startTimeMs: 1_700_000_000_000,
			endTimeMs: 1_700_003_600_000,
			depth: 20,
			constructionMode: "sampled_top_n_snapshot",
			canonicalSchemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
			vendorSemanticDigest: "3".repeat(64),
			canonicalSemanticDigest: "4".repeat(64),
			prefixDigest: "5".repeat(64),
			suffixDigest: "6".repeat(64),
			seamVerified: true,
			coverageVerified: true,
			datasetObjects: [
				{
					identity: "binance/2023/11/14/22/BTCUSDT.parquet.zst",
					checksum: "7".repeat(64),
					bytes: 123,
					rows: 45,
				},
			],
		},
		1_800_000_000_000,
	);
}

function candidate() {
	return buildCanonicalOrderBookRows({
		context: {
			source: EXTERNAL_BACKFILL_SOURCE,
			deploymentId: "market-data-vendor-backfill",
			captureBundleId: "2".repeat(64),
			exchange: "binance",
			symbol: "BTC-USDT",
			tradingPair: "BTC-USDT",
			sourceSymbol: "BTCUSDT",
			assetType: "spot",
			feed: "ORDERBOOK",
			provider: "cryptohftdata",
			sourceMode: "historical_vendor_orderbook_v1",
			schemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
			provenanceComplete: true,
		},
		rawCapture: {
			rawCaptureId: "3".repeat(64),
			rawCaptureScope: "vendor_normalized_dataset_file",
			rawChecksum: "4".repeat(64),
			redactedPayload: { dataset_object_checksum: "4".repeat(64) },
			eventTimeMs: 1_700_000_000_000,
			receivedTimeMs: 1_700_000_000_010,
			checksumAlgorithm: "sha256-canonical-json-v1",
		},
		depthLimit: 1,
		constructionMode: "sampled_top_n_snapshot",
		snapshot: {
			bids: [[100, 1]],
			asks: [[101, 2]],
			timestamp: 1_700_000_000_000,
			receivedTimestamp: 1_700_000_000_010,
			exchange: "binance",
			symbol: "BTC-USDT",
			depthLimit: 1,
			sequence: "9007199254740993",
		},
	});
}

describe("external market-data forwarder admission", () => {
	test("admits provenance-complete candidates and rejects incomplete candidates", async () => {
		const canonical = candidate();
		const validCandidate = canonical.summary;
		const validLevel = canonical.levels[0];
		if (!validLevel) throw new Error("synthetic level missing");
		for (const [row, expectedStatus] of [
			[validCandidate, 200],
			[validLevel, 200],
			[
				{
					...validCandidate,
					row: { ...validCandidate.row, provider: undefined },
				},
				400,
			],
			[
				{
					...validCandidate,
					row: { ...validCandidate.row, best_bid: 99 },
				},
				400,
			],
		] as const) {
			let inserted = false;
			const response = await handleArchiveRequest(
				post({
					source: EXTERNAL_BACKFILL_SOURCE,
					deployment_id: "market-data-vendor-backfill",
					batch_id: "8".repeat(64),
					rows: [row],
				}),
				{
					inserter: async () => {
						inserted = true;
					},
					telemetry: new ArchiveForwarderTelemetry(noopRecorder),
				},
			);
			expect(response.status).toBe(expectedStatus);
			expect(inserted).toBe(expectedStatus === 200);
		}
	});

	test("admits a valid passing promotion synchronously", async () => {
		const inserted: Array<{ table: string; rows: Record<string, unknown>[] }> =
			[];
		const promotion = receipt();
		const response = await handleArchiveRequest(
			post({
				source: EXTERNAL_BACKFILL_SOURCE,
				deployment_id: "market-data-vendor-backfill",
				batch_id: "8".repeat(64),
				rows: [promotionReceiptToArchiveRow(promotion)],
			}),
			{
				inserter: async (table, rows) => inserted.push({ table, rows }),
				telemetry: new ArchiveForwarderTelemetry(noopRecorder),
			},
		);
		expect(response.status).toBe(200);
		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.table).toBe(
			"market_data.cex_order_book_capture_promotions",
		);
	});

	test("rejects a failed or identity-tampered promotion before insertion", async () => {
		for (const mutation of [
			(row: Record<string, unknown>) => ({ ...row, status: "failed" }),
			(row: Record<string, unknown>) => ({
				...row,
				receipt_id: "9".repeat(64),
			}),
		]) {
			let inserted = false;
			const valid = promotionReceiptToArchiveRow(receipt());
			const response = await handleArchiveRequest(
				post({
					source: EXTERNAL_BACKFILL_SOURCE,
					deployment_id: "market-data-vendor-backfill",
					rows: [{ ...valid, row: mutation(valid.row) }],
				}),
				{
					inserter: async () => {
						inserted = true;
					},
					telemetry: new ArchiveForwarderTelemetry(noopRecorder),
				},
			);
			expect(response.status).toBe(400);
			expect(inserted).toBe(false);
		}
	});

	test("rejects mixed promotion/candidate batches and promotion rows under broker sources", async () => {
		const promotion = promotionReceiptToArchiveRow(receipt());
		const candidate = {
			table: "market_data.cex_order_book_depth_summary",
			row: { source: EXTERNAL_BACKFILL_SOURCE },
		};
		for (const body of [
			{
				source: EXTERNAL_BACKFILL_SOURCE,
				deployment_id: "worker",
				rows: [promotion, candidate],
			},
			{
				source: "broker_read",
				deployment_id: "worker",
				rows: [
					{ ...promotion, row: { ...promotion.row, source: "broker_read" } },
				],
			},
		]) {
			const response = await handleArchiveRequest(post(body), {
				inserter: async () => {
					throw new Error("must not insert");
				},
				telemetry: new ArchiveForwarderTelemetry(noopRecorder),
			});
			expect(response.status).toBe(400);
		}
	});

	test("normal broker capture configuration remains closed to external_backfill", () => {
		expect(() =>
			createMarketCaptureContext({
				source: EXTERNAL_BACKFILL_SOURCE as never,
				deploymentId: "worker",
				captureBundleId: "bundle",
				exchange: "binance",
				symbol: "BTC/USDT",
				assetType: "spot",
				feed: "ORDERBOOK",
				sourceMode: "broker_live_sampling_v1",
			}),
		).toThrow("broker archive source");
	});
});
