import { describe, expect, test } from "bun:test";
import {
	BACKFILL_REQUEST_SCHEMA_VERSION,
	BACKFILL_RESULT_SCHEMA_VERSION,
	backfillRequestSchema,
	createBackfillIdempotencyKey,
	type MarketDataVendorBackfillRequest,
	parseBackfillRequest,
} from "../src/helpers/market-data-vendor-backfill/contracts";

export function validBackfillRequest(
	overrides: Partial<MarketDataVendorBackfillRequest> = {},
): MarketDataVendorBackfillRequest {
	const business = {
		schemaVersion: BACKFILL_REQUEST_SCHEMA_VERSION,
		requestId: "maker-run-2026-08-19:BTC-USDT",
		providerPolicy: {
			provider: "cryptohftdata" as const,
			allowedAdapterVersions: ["cryptohftdata-orderbook/v1"],
		},
		scope: {
			exchange: "binance",
			tradingPair: "BTC-USDT",
			sourceSymbol: "BTCUSDT",
			marketType: "spot" as const,
			feed: "ORDERBOOK" as const,
		},
		window: {
			startTimeMs: 1_700_000_000_000,
			endTimeMs: 1_700_003_600_000,
		},
		depth: 2,
		constructionMode: "sampled_top_n_snapshot" as const,
		requiredClockTargetsMs: [1_700_000_900_000, 1_700_002_700_000],
		maxPriorAsOfLagMs: 60_000,
		sourcePolicy: "authoritative_window" as const,
		budgets: {
			maxFiles: 3,
			maxBytes: 10_000_000,
			maxRows: 100_000,
			maxDurationMs: 60_000,
			maxBoundaryLookbackMs: 3_600_000,
		},
		expectedProduct: {
			packageName: "@usherlabs/cex-broker",
			canonicalSchemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
		},
	};
	const merged = { ...business, ...overrides };
	return {
		...merged,
		idempotencyKey: createBackfillIdempotencyKey(merged),
	};
}

describe("market-data vendor backfill contracts", () => {
	test("validates the versioned request and deterministic business identity", () => {
		const request = validBackfillRequest();
		expect(parseBackfillRequest(request)).toEqual(request);
		expect(createBackfillIdempotencyKey(request)).toBe(request.idempotencyKey);
		expect(BACKFILL_RESULT_SCHEMA_VERSION).toBe(
			"market-data-vendor-backfill-result/v1",
		);
	});

	test("request identity excludes caller attempt identity but binds business scope", () => {
		const first = validBackfillRequest();
		const renamed = validBackfillRequest({
			requestId: "another-maker-attempt",
		});
		const deeper = validBackfillRequest({ depth: 3 });
		expect(renamed.idempotencyKey).toBe(first.idempotencyKey);
		expect(deeper.idempotencyKey).not.toBe(first.idempotencyKey);
	});

	test("rejects an incorrect identity, unbounded window, and unknown fields", () => {
		expect(() =>
			parseBackfillRequest({
				...validBackfillRequest(),
				idempotencyKey: "0".repeat(64),
			}),
		).toThrow("idempotencyKey");
		expect(
			backfillRequestSchema.safeParse({
				...validBackfillRequest(),
				window: { startTimeMs: 10, endTimeMs: 10 },
			}).success,
		).toBe(false);
		expect(
			backfillRequestSchema.safeParse({
				...validBackfillRequest(),
				apiKey: "must-not-be-a-wire-field",
			}).success,
		).toBe(false);
	});
});
