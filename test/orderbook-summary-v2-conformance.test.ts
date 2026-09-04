import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	ORDER_BOOK_SUMMARY_V2_FIELDS,
	validateRetainedOrderBookRow,
} from "../services/archive-forwarder/order-book-row-contract";
import { parseArchiveBatchRequest } from "../services/archive-forwarder/router";
import { buildCanonicalOrderBookRows } from "../src/helpers/market-data-archive/canonical-orderbook";
import { createRawCapture } from "../src/helpers/market-data-archive/capture-contract";
import {
	ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELD_NAMES,
	ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELDS,
	projectOrderBookSummaryV2SupportedView,
} from "../src/helpers/market-data-archive/summary-v2-conformance";
import type {
	MarketCaptureContext,
	OrderbookArchiveMetadata,
} from "../src/helpers/market-data-archive/types";
import type { NormalizedOrderBookSnapshot } from "../src/helpers/order-book";

const fixtureUrl = new URL(
	"./fixtures/cex-order-book-depth-summary-v2-conformance/v1/fixture.json",
	import.meta.url,
);
const manifestUrl = new URL(
	"./fixtures/cex-order-book-depth-summary-v2-conformance/v1/SHA256SUMS",
	import.meta.url,
);

type AcceptedCase = {
	id: string;
	category: string;
	input: {
		context: MarketCaptureContext;
		snapshot: NormalizedOrderBookSnapshot;
		archive_metadata: OrderbookArchiveMetadata;
		archive_depth_limit: number;
		measurement_bands_bps: number[];
	};
	expected_writer: {
		table: string;
		raw_capture_id: string;
		raw_checksum: string;
		snapshot_id: string;
		normalized_row_checksum: string;
		retained_bid_rows: number;
		retained_ask_rows: number;
		row: Record<string, unknown>;
	};
	expected_supported_view: Record<string, unknown>;
};

type RejectedWriterCase = {
	id: string;
	input: AcceptedCase["input"];
	expected_outcome: { error_includes: string };
};

type Fixture = {
	fixture_schema: string;
	supported_view_fields: Array<{
		name: string;
		clickhouse_type: string;
		nullable: boolean;
	}>;
	accepted_cases: AcceptedCase[];
	batch_cases: Array<{
		id: string;
		input_rows: Array<{ table: string; row: Record<string, unknown> }>;
		expected_outcome: Record<string, number | string>;
	}>;
	rejected_writer_cases: RejectedWriterCase[];
	rejected_forwarder_cases: Array<{
		id: string;
		row: Record<string, unknown>;
		expected_error: string;
	}>;
};

async function loadFixture(): Promise<Fixture> {
	return (await Bun.file(fixtureUrl).json()) as Fixture;
}

function build(input: AcceptedCase["input"]) {
	const rawCapture = createRawCapture(input.context, {
		payload: input.snapshot,
		eventTimeMs: input.snapshot.timestamp,
		receivedTimeMs: input.snapshot.receivedTimestamp,
		scope: "ccxt_normalized_object",
	});
	const canonical = buildCanonicalOrderBookRows({
		context: input.context,
		snapshot: input.snapshot,
		rawCapture,
		depthLimit: input.archive_depth_limit,
		archiveMetadata: input.archive_metadata,
	});
	return { rawCapture, canonical };
}

function validateFixtureRow(row: Record<string, unknown>) {
	return validateRetainedOrderBookRow(
		{ table: "market_data.cex_order_book_depth_summary", row },
		String(row.source),
		String(row.deployment_id),
	);
}

describe("cex-order-book-depth-summary-v2-conformance/v1", () => {
	test("pins exact fixture bytes with a downstream-copyable SHA-256 manifest", async () => {
		const bytes = await Bun.file(fixtureUrl).arrayBuffer();
		const manifest = (await Bun.file(manifestUrl).text()).trim();
		const [expectedDigest, filename, extra] = manifest.split(/\s+/);
		expect(filename).toBe("fixture.json");
		expect(extra).toBeUndefined();
		expect(
			createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
		).toBe(expectedDigest);
		const serialized = new TextDecoder().decode(bytes);
		for (const secretMarker of [
			"ALCHEMY_KEY",
			"COINGECKO_DEMO_API_KEY",
			"SIGNING_PRIVATE_KEY",
			"api_secret",
			"private_key",
		]) {
			expect(serialized).not.toContain(secretMarker);
		}
	});

	test("fixes supported-view field order, ClickHouse types, and Decimal(38,18) strings", async () => {
		const fixture = await loadFixture();
		expect(fixture.fixture_schema).toBe(
			"cex-order-book-depth-summary-v2-conformance/v1",
		);
		expect(fixture.supported_view_fields).toEqual(
			ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELDS.map(
				([name, clickhouseType, nullable]) => ({
					name,
					clickhouse_type: clickhouseType,
					nullable,
				}),
			),
		);
		expect(new Set(ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELD_NAMES)).toEqual(
			new Set(ORDER_BOOK_SUMMARY_V2_FIELDS),
		);
		for (const testCase of fixture.accepted_cases) {
			expect(Object.keys(testCase.expected_supported_view)).toEqual(
				ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELD_NAMES,
			);
			for (const { name, clickhouse_type } of fixture.supported_view_fields) {
				if (!clickhouse_type.includes("Decimal(38,18)")) continue;
				const value = testCase.expected_supported_view[name];
				const decimals = Array.isArray(value) ? value : [value];
				for (const decimal of decimals) {
					expect(decimal).toMatch(/^-?\d+\.\d{18}$/);
				}
			}
		}
	});

	test("reproduces every accepted writer row, checksum, top-N count, and typed projection", async () => {
		const fixture = await loadFixture();
		for (const testCase of fixture.accepted_cases) {
			expect(testCase.input.measurement_bands_bps.length).toBeGreaterThan(0);
			expect(testCase.input.archive_depth_limit).toBeGreaterThan(0);
			const { rawCapture, canonical } = build(testCase.input);
			expect(rawCapture.rawCaptureId, testCase.id).toBe(
				testCase.expected_writer.raw_capture_id,
			);
			expect(rawCapture.rawChecksum, testCase.id).toBe(
				testCase.expected_writer.raw_checksum,
			);
			expect(canonical.snapshotId, testCase.id).toBe(
				testCase.expected_writer.snapshot_id,
			);
			expect(canonical.summary.row, testCase.id).toEqual(
				testCase.expected_writer.row,
			);
			expect(canonical.summary.row.normalized_row_checksum, testCase.id).toBe(
				testCase.expected_writer.normalized_row_checksum,
			);
			expect(
				canonical.levels.filter(({ row }) => row.side === "bid").length,
			).toBe(testCase.expected_writer.retained_bid_rows);
			expect(
				canonical.levels.filter(({ row }) => row.side === "ask").length,
			).toBe(testCase.expected_writer.retained_ask_rows);
			expect(
				projectOrderBookSummaryV2SupportedView(canonical.summary.row),
			).toEqual(testCase.expected_supported_view);
			expect(validateFixtureRow(canonical.summary.row)).toEqual({ ok: true });
		}
	});

	test("covers exact, censored, exhausted, asymmetric, truncated and top-N outcomes", async () => {
		const fixture = await loadFixture();
		const categories = new Set(
			fixture.accepted_cases.map(({ category }) => category),
		);
		for (const category of [
			"exact",
			"censored",
			"explicitly-exhausted",
			"asymmetric-non-empty",
			"truncated",
			"top-n",
		]) {
			expect(categories.has(category), category).toBe(true);
		}
		const truncated = fixture.accepted_cases.find(
			({ id }) => id === "truncated-top-n",
		);
		expect(truncated?.expected_writer.retained_bid_rows).toBe(2);
		expect(truncated?.input.snapshot.bids.length).toBeGreaterThan(2);
		expect(truncated?.expected_writer.retained_ask_rows).toBe(2);
		expect(truncated?.input.snapshot.asks.length).toBeGreaterThan(2);
	});

	test("rejects incomplete provenance, malformed books, empty sides, and unsupported sources", async () => {
		const fixture = await loadFixture();
		const categories = new Set(
			fixture.rejected_writer_cases.map(({ id }) => id),
		);
		for (const id of [
			"incomplete-provenance",
			"malformed-duplicate-bid",
			"malformed-conflicting-observed-count",
			"empty-bid",
			"empty-ask",
			"both-empty",
			"source-rejection",
		]) {
			expect(categories.has(id), id).toBe(true);
		}
		for (const testCase of fixture.rejected_writer_cases) {
			expect(testCase.input.measurement_bands_bps.length).toBeGreaterThan(0);
			expect(testCase.input.archive_depth_limit).toBeGreaterThan(0);
			expect(() => build(testCase.input), testCase.id).toThrow(
				testCase.expected_outcome.error_includes,
			);
		}
	});

	test("pins duplicate convergence and conflicting retry rejection", async () => {
		const fixture = await loadFixture();
		for (const testCase of fixture.batch_cases) {
			const first = testCase.input_rows[0]?.row;
			if (!first) throw new Error(`${testCase.id} has no rows`);
			const parsed = parseArchiveBatchRequest({
				source: first.source,
				deployment_id: first.deployment_id,
				rows: testCase.input_rows,
			});
			expect(parsed.ok, testCase.id).toBe(true);
			if (!parsed.ok) continue;
			if (testCase.id === "duplicate-identical-retry") {
				expect(parsed.batch.rows).toHaveLength(2);
				expect(parsed.checksumConflictsByTable).toEqual({});
				expect(testCase.expected_outcome.supported_view_rows).toBe(1);
			} else {
				expect(parsed.batch.rows).toHaveLength(0);
				expect(parsed.checksumConflictsByTable).toEqual({
					"market_data.cex_order_book_depth_summary": 2,
				});
			}
		}
	});

	test("pins malformed and source rejection outcomes at forwarder admission", async () => {
		const fixture = await loadFixture();
		for (const testCase of fixture.rejected_forwarder_cases) {
			const validation = validateFixtureRow(testCase.row);
			expect(validation.ok, testCase.id).toBe(false);
			if (!validation.ok) {
				expect(validation.error).toContain(testCase.expected_error);
			}
			const parsed = parseArchiveBatchRequest({
				source: "broker_read",
				deployment_id: testCase.row.deployment_id,
				rows: [
					{
						table: "market_data.cex_order_book_depth_summary",
						row: testCase.row,
					},
				],
			});
			expect(parsed.ok, testCase.id).toBe(true);
			if (parsed.ok) {
				expect(parsed.batch.rows).toHaveLength(0);
				expect(parsed.rejectedRowCount).toBe(1);
			}
		}
	});
});
