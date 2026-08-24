import {
	ARCHIVE_SELECTION_SCHEMA_ID,
	BACKFILL_REQUEST_SCHEMA_ID,
	BACKFILL_RESULT_SCHEMA_ID,
	createBackfillIdempotencyKey,
	finalizeArchiveSelection,
	finalizeBackfillResult,
	finalizeRequiredClock,
	PROMOTION_RECEIPT_SCHEMA_ID,
	REQUIRED_CLOCK_SCHEMA_ID,
} from "./contracts";
import { jcsSha256 } from "./identity";
import {
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	LEGACY_CAPABILITY_POLICY,
	LEGACY_RESOURCE_POLICY,
	SCHEMA_MANIFEST,
} from "./manifests";
import { finalizePromotionReceipt } from "./promotion";

const requestId = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f100";
const attemptId = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f101";
const clockId = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f102";
const authorizationId = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103";
const qualificationEventId = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f104";
const targetId = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f105";
const captureBundleId = "d".repeat(64);
const scope = {
	exchange: "okx",
	trading_pair: "ARB-USDT",
	market_type: "spot" as const,
	feed: "ORDERBOOK" as const,
};
const window = {
	start_at: "2026-08-18T09:27:15.000Z",
	end_at: "2026-08-18T09:27:17.000Z",
};
const coveragePolicy = {
	policy_id: "prior-asof-strict/v1" as const,
	max_asof_lag_ms: 5_000,
	future_rows: "reject" as const,
	missing_required_event: "fail" as const,
};

const requiredClock = finalizeRequiredClock({
	schema_id: REQUIRED_CLOCK_SCHEMA_ID,
	clock_id: clockId,
	created_at: "2026-08-20T12:00:00.000Z",
	targets: [{ target_id: targetId, target_at: "2026-08-18T09:27:16.000Z" }],
});

const initialSelection = finalizeArchiveSelection({
	schema_id: ARCHIVE_SELECTION_SCHEMA_ID,
	scope,
	required_clock: {
		clock_id: requiredClock.clock_id,
		clock_sha256: requiredClock.clock_sha256,
		event_count: requiredClock.targets.length,
	},
	coverage_policy: coveragePolicy,
	source_policy: "authoritative_window",
	coverage_class: "missing",
	requested_intervals: [window],
	selected_intervals: [],
	precedence: ["vendor"],
	bundles: [],
	support_anchors: [],
	receipt_ids: [],
	qualification_event_ids: [],
	resolved_at: "2026-08-20T12:00:00.000Z",
});

const requestContent = {
	schema_id: BACKFILL_REQUEST_SCHEMA_ID,
	request_id: requestId,
	attempt_id: attemptId,
	scope,
	window,
	depth: 20,
	construction_mode: "sampled_top_n_snapshot" as const,
	source_policy: "authoritative_window" as const,
	target: { environment: "production", cluster: "cex-archive-primary" },
	coverage_policy: coveragePolicy,
	required_clock: {
		schema_id: REQUIRED_CLOCK_SCHEMA_ID,
		clock_id: requiredClock.clock_id,
		file_name: "required-clock.json",
		clock_sha256: requiredClock.clock_sha256,
		event_count: requiredClock.targets.length,
	},
	initial_selection: initialSelection,
	expected_canonical_schema: {
		schema_id: "cex-order-book-canonical/v1",
		schema_sha256: "a".repeat(64),
	},
	product_pins: {
		capability_policy: {
			policy_id: LEGACY_CAPABILITY_POLICY.policy_id,
			policy_sha256: LEGACY_CAPABILITY_POLICY.policy_sha256,
		},
		resource_policy: {
			policy_id: LEGACY_RESOURCE_POLICY.policy_id,
			policy_sha256: LEGACY_RESOURCE_POLICY.policy_sha256,
		},
	},
	production_authorization_id: authorizationId,
};

const request = {
	...requestContent,
	idempotency_key: createBackfillIdempotencyKey(requestContent),
};

const promotionReceipt = finalizePromotionReceipt({
	schema_id: PROMOTION_RECEIPT_SCHEMA_ID,
	verified_at: "2026-08-20T12:00:02.000Z",
	request_id: request.request_id,
	idempotency_key: request.idempotency_key,
	source: "external_backfill",
	capture_origin: "vendor_historical_backfill",
	source_mode: "vendor_historical_backfill_v1",
	provider: "cryptohftdata",
	adapter_version: "cryptohftdata-orderbook/v2",
	effective_policies: {
		capability_policy: request.product_pins.capability_policy,
		resource_policy: request.product_pins.resource_policy,
		adapter_policy: EFFECTIVE_ADAPTER_POLICY_PIN,
		acquisition_policy: EFFECTIVE_ACQUISITION_POLICY_PIN,
	},
	capture_bundle_id: captureBundleId,
	scope,
	window,
	depth: request.depth,
	construction_mode: request.construction_mode,
	canonical_schema: request.expected_canonical_schema,
	coverage_policy: coveragePolicy,
	selection_sha256: initialSelection.selection_sha256,
	vendor_semantic_digest: "e".repeat(64),
	canonical_semantic_digest: "f".repeat(64),
	prefix_digest: "1".repeat(64),
	suffix_digest: "2".repeat(64),
	seam_verified: true,
	coverage_verified: true,
	dataset_objects: [
		{
			identity: "okx/spot/orderbook/hour/arb-usdt/2026-08-18t09",
			checksum: "3".repeat(64),
			bytes: 1_000,
			rows: 50,
		},
	],
});

const resolvedSelection = finalizeArchiveSelection({
	schema_id: ARCHIVE_SELECTION_SCHEMA_ID,
	scope,
	required_clock: initialSelection.required_clock,
	coverage_policy: coveragePolicy,
	source_policy: "authoritative_window",
	coverage_class: "complete",
	requested_intervals: [window],
	selected_intervals: [
		{
			...window,
			capture_bundle_id: captureBundleId,
			capture_origin: "vendor_historical_backfill",
		},
	],
	precedence: ["vendor"],
	bundles: [
		{
			capture_bundle_id: captureBundleId,
			capture_origin: "vendor_historical_backfill",
			interval: window,
			qualification: {
				qualification_event_id: qualificationEventId,
				state: "qualified",
				receipt_id: promotionReceipt.receipt_id,
				promotion_identity_sha256: promotionReceipt.promotion_identity_sha256,
			},
		},
	],
	support_anchors: [
		{
			capture_bundle_id: captureBundleId,
			raw_capture_id: "4".repeat(64),
			snapshot_id: "5".repeat(64),
			source_time: "2026-08-18T09:27:15.308Z",
			normalized_summary_checksum: "6".repeat(64),
			metadata_ref: {
				capture_origin: "vendor_historical_backfill",
				qualification_event_id: qualificationEventId,
				receipt_id: promotionReceipt.receipt_id,
			},
		},
	],
	receipt_ids: [promotionReceipt.receipt_id],
	qualification_event_ids: [qualificationEventId],
	resolved_at: "2026-08-20T12:00:02.000Z",
});

const result = finalizeBackfillResult({
	schema_id: BACKFILL_RESULT_SCHEMA_ID,
	job_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f120",
	request_file_sha256: "7".repeat(64),
	executable_sha256: "8".repeat(64),
	schema_manifest_sha256: SCHEMA_MANIFEST.manifest_sha256,
	cex_package: {
		name: "@usherlabs/cex-broker",
		version: "0.2.46",
		package_sha256: "9".repeat(64),
	},
	capability_policy: request.product_pins.capability_policy,
	resource_policy: request.product_pins.resource_policy,
	build: {
		fiet_tee_commit: "a".repeat(40),
		created_at: "2026-08-20T12:00:00.000Z",
	},
	started_at: "2026-08-20T12:00:01.000Z",
	completed_at: "2026-08-20T12:00:03.000Z",
	outcome: {
		status: "promoted",
		reason_code: "promotion_qualified",
		reason_subcode: null,
		request_id: request.request_id,
		idempotency_key: request.idempotency_key,
		target: request.target,
		selection: resolvedSelection,
		receipt: promotionReceipt,
		diagnostics: { promoted_rows: 50 },
	},
});

const jcsEdgeVector = {
	literals: [null, true, false],
	numbers: [Number("333333333.33333329"), 1e30, 4.5, 0.002],
	string: '€$\u000f\nA\'B"\\"/',
};

export const CONFORMANCE_FIXTURES = Object.freeze({
	fixture_id: "market-data-vendor-backfill-conformance/v1",
	documents: {
		required_clock: requiredClock,
		archive_selection: resolvedSelection,
		request,
		promotion_receipt: promotionReceipt,
		result,
	},
	identities: {
		idempotency_key: request.idempotency_key,
		clock_sha256: requiredClock.clock_sha256,
		initial_selection_sha256: initialSelection.selection_sha256,
		selection_sha256: resolvedSelection.selection_sha256,
		promotion_identity_sha256: promotionReceipt.promotion_identity_sha256,
		receipt_id: promotionReceipt.receipt_id,
		result_sha256: result.result_sha256,
		capability_policy_sha256: LEGACY_CAPABILITY_POLICY.policy_sha256,
		resource_policy_sha256: LEGACY_RESOURCE_POLICY.policy_sha256,
	},
	jcs_edge_vector: jcsEdgeVector,
	hashes: { jcs_edge_vector_sha256: jcsSha256(jcsEdgeVector) },
});
