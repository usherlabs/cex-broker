import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildCanonicalOrderBookRows } from "../src/helpers/market-data-archive/canonical-orderbook";
import {
	canonicalSerialize,
	createRawCapture,
} from "../src/helpers/market-data-archive/capture-contract";
import {
	ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELDS,
	projectOrderBookSummaryV2SupportedView,
} from "../src/helpers/market-data-archive/summary-v2-conformance";
import type {
	MarketCaptureContext,
	OrderbookArchiveMetadata,
} from "../src/helpers/market-data-archive/types";
import type { NormalizedOrderBookSnapshot } from "../src/helpers/order-book";

const FIXTURE_DIRECTORY = join(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"cex-order-book-depth-summary-v2-conformance",
	"v1",
);
const FIXTURE_PATH = join(FIXTURE_DIRECTORY, "fixture.json");
const MANIFEST_PATH = join(FIXTURE_DIRECTORY, "SHA256SUMS");
const TABLE = "market_data.cex_order_book_depth_summary";

const baseContext: MarketCaptureContext = {
	source: "broker_read",
	deploymentId: "summary-v2-fixture-deployment",
	captureBundleId: "summary-v2-fixture-bundle",
	exchange: "fixture-exchange",
	symbol: "BTC/USDT",
	tradingPair: "BTC-USDT",
	sourceSymbol: "BTCUSDT",
	assetType: "spot",
	feed: "ORDERBOOK",
	provider: "fixture:normalized-l2",
	sourceMode: "broker_live_sampling_v1",
	schemaVersion: "1.0.0",
	checksumAlgorithm: "sha256-canonical-json-v1",
	provenanceComplete: true,
};

const baseSnapshot: NormalizedOrderBookSnapshot = {
	bids: [
		[100, 1],
		[99.9, 2],
		[99.7, 3],
		[99, 4],
	],
	asks: [
		[100.2, 5],
		[100.3, 6],
		[100.5, 7],
		[101.2, 8],
	],
	timestamp: 1_900_000_000_000,
	receivedTimestamp: 1_900_000_000_025,
	exchange: "fixture-exchange",
	symbol: "BTC/USDT",
	depthLimit: 4,
	sequence: 9001,
};

type AcceptedDefinition = {
	id: string;
	category: string;
	snapshot?: Partial<NormalizedOrderBookSnapshot>;
	context?: Partial<MarketCaptureContext>;
	metadata?: Partial<OrderbookArchiveMetadata>;
	archiveDepthLimit: number;
	measurementBandsBps: number[];
	expectedAdmission?: "accepted" | "duplicate-collapsed";
};

type RejectedDefinition = AcceptedDefinition & {
	expectedError: string;
};

function snapshotFor(
	definition: AcceptedDefinition,
): NormalizedOrderBookSnapshot {
	return {
		...baseSnapshot,
		...definition.snapshot,
		bids: definition.snapshot?.bids ?? baseSnapshot.bids,
		asks: definition.snapshot?.asks ?? baseSnapshot.asks,
	};
}

function metadataFor(
	snapshot: NormalizedOrderBookSnapshot,
	definition: AcceptedDefinition,
): OrderbookArchiveMetadata {
	return {
		captureProfileId: `fixture-profile:${definition.id}`,
		effectiveCadenceMs: 250,
		requestedUpstreamDepth: 100,
		observedBidCount: snapshot.bids.length,
		observedAskCount: snapshot.asks.length,
		observedFarthestBid: snapshot.bids.at(-1)?.[0] ?? Number.NaN,
		observedFarthestAsk: snapshot.asks.at(-1)?.[0] ?? Number.NaN,
		bidExhausted: false,
		askExhausted: false,
		measurementBandsBps: definition.measurementBandsBps,
		...definition.metadata,
	};
}

function contextFor(definition: AcceptedDefinition): MarketCaptureContext {
	return {
		...baseContext,
		captureBundleId: `${baseContext.captureBundleId}:${definition.id}`,
		...definition.context,
	};
}

function writerResult(definition: AcceptedDefinition) {
	const snapshot = snapshotFor(definition);
	const context = contextFor(definition);
	const archiveMetadata = metadataFor(snapshot, definition);
	const rawCapture = createRawCapture(context, {
		payload: snapshot,
		eventTimeMs: snapshot.timestamp,
		receivedTimeMs: snapshot.receivedTimestamp,
		scope: "ccxt_normalized_object",
	});
	const canonical = buildCanonicalOrderBookRows({
		context,
		snapshot,
		rawCapture,
		depthLimit: definition.archiveDepthLimit,
		archiveMetadata,
	});
	return { snapshot, context, archiveMetadata, rawCapture, canonical };
}

function inputMaterial(definition: AcceptedDefinition) {
	const snapshot = snapshotFor(definition);
	return {
		context: contextFor(definition),
		snapshot,
		archive_metadata: metadataFor(snapshot, definition),
		archive_depth_limit: definition.archiveDepthLimit,
		measurement_bands_bps: definition.measurementBandsBps,
	};
}

const acceptedDefinitions: AcceptedDefinition[] = [
	{
		id: "exact-both-sides",
		category: "exact",
		archiveDepthLimit: 4,
		measurementBandsBps: [10, 25, 100],
	},
	{
		id: "censored-short-observation",
		category: "censored",
		snapshot: { bids: [[100, 1]], asks: [[100.2, 5]], sequence: 9002 },
		archiveDepthLimit: 1,
		measurementBandsBps: [10, 25, 100],
	},
	{
		id: "explicitly-exhausted",
		category: "explicitly-exhausted",
		snapshot: { bids: [[100, 1]], asks: [[100.2, 5]], sequence: 9003 },
		metadata: { bidExhausted: true, askExhausted: true },
		archiveDepthLimit: 1,
		measurementBandsBps: [10, 25, 100],
	},
	{
		id: "asymmetric-non-empty",
		category: "asymmetric-non-empty",
		snapshot: {
			bids: [
				[100, 1],
				[99.8, 2],
				[99.4, 3],
				[98.5, 4],
			],
			asks: [[100.2, 9]],
			sequence: 9004,
		},
		metadata: { bidExhausted: false, askExhausted: true },
		archiveDepthLimit: 2,
		measurementBandsBps: [10, 50, 150],
	},
	{
		id: "truncated-top-n",
		category: "truncated",
		archiveDepthLimit: 2,
		measurementBandsBps: [10, 25, 100],
	},
	{
		id: "normalized-bands-and-null-request",
		category: "top-n",
		metadata: { requestedUpstreamDepth: null },
		archiveDepthLimit: 3,
		measurementBandsBps: [100, 10, 25, 10],
	},
];

const rejectedDefinitions: RejectedDefinition[] = [
	{
		id: "incomplete-provenance",
		category: "incomplete-provenance",
		context: { provenanceComplete: false },
		archiveDepthLimit: 2,
		measurementBandsBps: [10, 25],
		expectedError: "summary v2 requires complete live provenance",
	},
	{
		id: "malformed-duplicate-bid",
		category: "malformed",
		snapshot: {
			bids: [
				[100, 1],
				[100, 2],
			],
		},
		archiveDepthLimit: 2,
		measurementBandsBps: [10, 25],
		expectedError: "bid levels are not strictly descending",
	},
	{
		id: "malformed-conflicting-observed-count",
		category: "malformed",
		metadata: { observedBidCount: 999 },
		archiveDepthLimit: 2,
		measurementBandsBps: [10, 25],
		expectedError: "observed_bid_count does not match the complete observation",
	},
	{
		id: "empty-bid",
		category: "empty-bid",
		snapshot: { bids: [] },
		archiveDepthLimit: 2,
		measurementBandsBps: [10, 25],
		expectedError: "bid side is missing",
	},
	{
		id: "empty-ask",
		category: "empty-ask",
		snapshot: { asks: [] },
		archiveDepthLimit: 2,
		measurementBandsBps: [10, 25],
		expectedError: "ask side is missing",
	},
	{
		id: "both-empty",
		category: "both-empty",
		snapshot: { bids: [], asks: [] },
		archiveDepthLimit: 2,
		measurementBandsBps: [10, 25],
		expectedError: "bid side is missing",
	},
	{
		id: "source-rejection",
		category: "source-rejection",
		context: { source: "external_backfill" as never },
		archiveDepthLimit: 2,
		measurementBandsBps: [10, 25],
		expectedError: "Unsupported archive source: external_backfill",
	},
];

const acceptedCases = acceptedDefinitions.map((definition) => {
	const result = writerResult(definition);
	const row = result.canonical.summary.row;
	return {
		id: definition.id,
		category: definition.category,
		input: inputMaterial(definition),
		expected_writer: {
			table: TABLE,
			raw_capture_id: result.rawCapture.rawCaptureId,
			raw_checksum: result.rawCapture.rawChecksum,
			snapshot_id: result.canonical.snapshotId,
			normalized_row_checksum: row.normalized_row_checksum,
			retained_bid_rows: result.canonical.levels.filter(
				({ row: level }) => level.side === "bid",
			).length,
			retained_ask_rows: result.canonical.levels.filter(
				({ row: level }) => level.side === "ask",
			).length,
			row,
		},
		expected_supported_view: projectOrderBookSummaryV2SupportedView(row),
		expected_outcome: {
			writer: "accepted",
			forwarder: "accepted",
			supported_view: "selected",
		},
	};
});
acceptedCases.sort((left, right) => {
	const leftRow = left.expected_writer.row;
	const rightRow = right.expected_writer.row;
	for (const field of [
		"source_time_ms",
		"capture_bundle_id",
		"exchange",
		"trading_pair",
		"raw_capture_id",
		"snapshot_id",
		"schema_version",
	]) {
		const comparison = String(leftRow[field]).localeCompare(
			String(rightRow[field]),
		);
		if (comparison !== 0) return comparison;
	}
	return 0;
});

const duplicateBase = acceptedCases.find(({ id }) => id === "exact-both-sides");
if (!duplicateBase) throw new Error("Exact fixture case is missing");
const duplicateCase = {
	id: "duplicate-identical-retry",
	category: "duplicate",
	archive_depth_limit: duplicateBase.input.archive_depth_limit,
	measurement_bands_bps: duplicateBase.input.measurement_bands_bps,
	input_rows: [
		{ table: TABLE, row: duplicateBase.expected_writer.row },
		{ table: TABLE, row: duplicateBase.expected_writer.row },
	],
	expected_outcome: {
		forwarder: "accepted",
		accepted_physical_rows: 2,
		same_batch_conflict_rows: 0,
		supported_view_rows: 1,
	},
};
const conflictRow = {
	...duplicateBase.expected_writer.row,
	best_bid_amount:
		Number(duplicateBase.expected_writer.row.best_bid_amount) + 0.25,
	normalized_row_checksum: "f".repeat(64),
};
const conflictingCase = {
	id: "conflicting-same-key-retry",
	category: "conflicting",
	archive_depth_limit: duplicateBase.input.archive_depth_limit,
	measurement_bands_bps: duplicateBase.input.measurement_bands_bps,
	input_rows: [
		{ table: TABLE, row: duplicateBase.expected_writer.row },
		{ table: TABLE, row: conflictRow },
	],
	expected_outcome: {
		forwarder: "rejected",
		accepted_rows: 0,
		rejected_rows: 2,
		checksum_conflict_rows: 2,
		supported_view_rows: 0,
	},
};

const rejectedCases = rejectedDefinitions.map((definition) => ({
	id: definition.id,
	category: definition.category,
	input: inputMaterial(definition),
	expected_outcome: {
		writer: "rejected",
		error_includes: definition.expectedError,
		forwarder_rows: 0,
		supported_view_rows: 0,
	},
}));

const forwarderRejectionCases = [
	{
		id: "forwarder-incomplete-provenance",
		category: "incomplete-provenance",
		archive_depth_limit: duplicateBase.input.archive_depth_limit,
		measurement_bands_bps: duplicateBase.input.measurement_bands_bps,
		row: { ...duplicateBase.expected_writer.row, provenance_complete: 0 },
		expected_error: "summary v2 provenance must be complete",
	},
	{
		id: "forwarder-malformed-status",
		category: "malformed",
		archive_depth_limit: duplicateBase.input.archive_depth_limit,
		measurement_bands_bps: duplicateBase.input.measurement_bands_bps,
		row: {
			...duplicateBase.expected_writer.row,
			bid_status_by_band: ["unknown", "exact", "exact"],
		},
		expected_error: "bid_status_by_band contains an invalid status",
	},
	{
		id: "forwarder-misaligned-arrays",
		category: "malformed",
		archive_depth_limit: duplicateBase.input.archive_depth_limit,
		measurement_bands_bps: duplicateBase.input.measurement_bands_bps,
		row: { ...duplicateBase.expected_writer.row, ask_depth_by_band: [5] },
		expected_error: "summary band arrays must be aligned",
	},
	{
		id: "forwarder-source-rejection",
		category: "source-rejection",
		archive_depth_limit: duplicateBase.input.archive_depth_limit,
		measurement_bands_bps: duplicateBase.input.measurement_bands_bps,
		row: { ...duplicateBase.expected_writer.row, source: "external_backfill" },
		expected_error: "source must match the broker archive envelope",
	},
].map((entry) => ({
	...entry,
	expected_outcome: {
		forwarder: "rejected",
		rejected_rows: 1,
		supported_view_rows: 0,
	},
}));

const fixture = {
	fixture_schema: "cex-order-book-depth-summary-v2-conformance/v1",
	summary_schema_version: "2.0.0",
	capture_schema_version: "1.0.0",
	checksum_algorithm: "sha256-canonical-json-v1",
	supported_view: "market_data.cex_order_book_depth_summary_canonical",
	table: TABLE,
	canonical_ordering: [
		"source_time_ms",
		"capture_bundle_id",
		"exchange",
		"trading_pair",
		"raw_capture_id",
		"snapshot_id",
		"schema_version",
	],
	supported_view_fields: ORDERBOOK_SUMMARY_V2_SUPPORTED_VIEW_FIELDS.map(
		([name, clickhouseType, nullable]) => ({
			name,
			clickhouse_type: clickhouseType,
			nullable,
		}),
	),
	accepted_cases: acceptedCases,
	batch_cases: [duplicateCase, conflictingCase],
	rejected_writer_cases: rejectedCases,
	rejected_forwarder_cases: forwarderRejectionCases,
};

const bytes = `${JSON.stringify(fixture, null, 2)}\n`;
const digest = createHash("sha256").update(bytes).digest("hex");
await mkdir(dirname(FIXTURE_PATH), { recursive: true });
await Bun.write(FIXTURE_PATH, bytes);
await Bun.write(MANIFEST_PATH, `${digest}  fixture.json\n`);

if (process.argv.includes("--print-canonical")) {
	process.stdout.write(`${canonicalSerialize(fixture)}\n`);
} else {
	console.log(`wrote ${FIXTURE_PATH}`);
	console.log(`wrote ${MANIFEST_PATH}`);
}
