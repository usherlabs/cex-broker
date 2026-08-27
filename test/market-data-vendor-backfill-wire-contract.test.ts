import { describe, expect, test } from "bun:test";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import {
	ARCHIVE_SELECTION_SCHEMA_ID,
	archiveSelectionCodec,
	BACKFILL_REQUEST_SCHEMA_ID,
	backfillRequestCodec,
	createBackfillIdempotencyKey,
	decodeBackfillRunDocuments,
	finalizeArchiveSelection,
	finalizeRequiredClock,
	PROMOTION_RECEIPT_SCHEMA_ID,
	promotionReceiptCodec,
	REQUIRED_CLOCK_SCHEMA_ID,
	requiredClockCodec,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	documentSha256,
	jcsCanonicalize,
	jcsSha256,
} from "../src/helpers/market-data-vendor-backfill/identity";
import {
	BACKFILL_RESULT_SCHEMA_ID,
	backfillResultCodec,
	finalizeBackfillResult,
} from "../src/helpers/market-data-vendor-backfill/legacy-contracts";
import {
	SCHEMA_ARTIFACTS,
	SCHEMA_MANIFEST,
} from "../src/helpers/market-data-vendor-backfill/legacy-manifests";
import {
	assertPolicyDocumentIdentity,
	CAPABILITY_POLICY,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";
import { finalizePromotionReceipt } from "../src/helpers/market-data-vendor-backfill/promotion";

const REQUEST_ID = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f100";
const ATTEMPT_ID = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f101";
const CLOCK_ID = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f102";
const AUTHORIZATION_ID = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103";

export function validRequiredClockWire() {
	return finalizeRequiredClock({
		schema_id: REQUIRED_CLOCK_SCHEMA_ID,
		clock_id: CLOCK_ID,
		created_at: "2026-08-20T12:00:00.000Z",
		targets: [
			{
				target_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f104",
				target_at: "2026-08-18T09:27:16.000Z",
			},
		],
	});
}

export function validInitialSelectionWire() {
	const clock = validRequiredClockWire();
	return finalizeArchiveSelection({
		schema_id: ARCHIVE_SELECTION_SCHEMA_ID,
		scope: {
			exchange: "okx",
			trading_pair: "ARB-USDT",
			market_type: "spot",
			feed: "ORDERBOOK",
		},
		required_clock: {
			clock_id: clock.clock_id,
			clock_sha256: clock.clock_sha256,
			event_count: clock.targets.length,
		},
		coverage_policy: {
			policy_id: "prior-asof-strict/v1",
			max_asof_lag_ms: 5_000,
			future_rows: "reject",
			missing_required_event: "fail",
		},
		source_policy: "authoritative_window",
		coverage_class: "missing",
		requested_intervals: [
			{
				start_at: "2026-08-18T09:27:15.000Z",
				end_at: "2026-08-18T09:27:17.000Z",
			},
		],
		selected_intervals: [],
		precedence: ["vendor"],
		bundles: [],
		support_anchors: [],
		receipt_ids: [],
		qualification_event_ids: [],
		resolved_at: "2026-08-20T12:00:00.000Z",
	});
}

export function validBackfillWireRequest(
	overrides: Record<string, unknown> = {},
) {
	const clock = validRequiredClockWire();
	const requestWithoutIdentity = {
		schema_id: BACKFILL_REQUEST_SCHEMA_ID,
		request_id: REQUEST_ID,
		attempt_id: ATTEMPT_ID,
		scope: {
			exchange: "okx",
			trading_pair: "ARB-USDT",
			market_type: "spot",
			feed: "ORDERBOOK",
		},
		window: {
			start_at: "2026-08-18T09:27:15.000Z",
			end_at: "2026-08-18T09:27:17.000Z",
		},
		depth: 20,
		construction_mode: "sampled_top_n_snapshot",
		source_policy: "authoritative_window",
		target: { environment: "production", cluster: "cex-archive-primary" },
		coverage_policy: {
			policy_id: "prior-asof-strict/v1",
			max_asof_lag_ms: 5_000,
			future_rows: "reject",
			missing_required_event: "fail",
		},
		required_clock: {
			schema_id: REQUIRED_CLOCK_SCHEMA_ID,
			clock_id: clock.clock_id,
			file_name: "required-clock.json",
			clock_sha256: clock.clock_sha256,
			event_count: clock.targets.length,
		},
		initial_selection: validInitialSelectionWire(),
		expected_canonical_schema: {
			schema_id: "cex-order-book-canonical/v1",
			schema_sha256: "a".repeat(64),
		},
		product_pins: {
			capability_policy: {
				policy_id: CAPABILITY_POLICY.policy_id,
				policy_sha256: CAPABILITY_POLICY.policy_sha256,
			},
			resource_policy: {
				policy_id: RESOURCE_POLICY.policy_id,
				policy_sha256: RESOURCE_POLICY.policy_sha256,
			},
		},
		production_authorization_id: AUTHORIZATION_ID,
		...overrides,
	};
	return {
		...requestWithoutIdentity,
		idempotency_key: createBackfillIdempotencyKey(requestWithoutIdentity),
	};
}

export function validPromotionReceiptWire() {
	const request = validBackfillWireRequest();
	return finalizePromotionReceipt({
		schema_id: PROMOTION_RECEIPT_SCHEMA_ID,
		verified_at: "2026-08-20T12:00:02.000Z",
		request_id: request.request_id,
		idempotency_key: request.idempotency_key,
		source: "external_backfill",
		capture_origin: "vendor_historical_backfill",
		source_mode: "vendor_historical_backfill_v1",
		provider: "cryptohftdata",
		adapter_version: "cryptohftdata-orderbook/v1",
		effective_policies: {
			capability_policy: request.product_pins.capability_policy,
			resource_policy: request.product_pins.resource_policy,
			adapter_policy: {
				policy_id: "cryptohftdata-orderbook-adapter/v1",
				policy_sha256: "b".repeat(64),
			},
			acquisition_policy: {
				policy_id: "cryptohftdata-hourly-acquisition/v1",
				policy_sha256: "c".repeat(64),
			},
		},
		capture_bundle_id: "d".repeat(64),
		scope: request.scope,
		window: request.window,
		depth: request.depth,
		construction_mode: request.construction_mode,
		canonical_schema: request.expected_canonical_schema,
		coverage_policy: request.coverage_policy,
		selection_sha256: request.initial_selection.selection_sha256,
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
				bytes: 1000,
				rows: 50,
			},
		],
	});
}

describe("final-v1 market-data vendor backfill wire contracts", () => {
	test("validates strict snake_case request, required-clock, and selection documents", () => {
		const clock = validRequiredClockWire();
		const selection = validInitialSelectionWire();
		const request = validBackfillWireRequest();

		expect(requiredClockCodec.decode(clock)).toEqual(clock);
		expect(archiveSelectionCodec.decode(selection)).toEqual(selection);
		expect(backfillRequestCodec.decode(request).wire).toEqual(request);
		expect(selection.selection_sha256).toBe(
			documentSha256(selection, "selection_sha256"),
		);
	});

	test("rejects unknown, camelCase, provider, path, budget, and package fields", () => {
		for (const forbidden of [
			{ requestId: REQUEST_ID },
			{ provider: "cryptohftdata" },
			{ source_symbol: "ARB-USDT" },
			{ object_paths: ["licensed/object"] },
			{ budgets: { max_files: 1 } },
			{ package_version: "0.2.46" },
		]) {
			expect(() =>
				backfillRequestCodec.decode(validBackfillWireRequest(forbidden)),
			).toThrow();
		}
	});

	test("rejects noncanonical UUIDs, digests, timestamps, unsafe integers, and floats", () => {
		const cases = [
			{ request_id: REQUEST_ID.toUpperCase() },
			{
				expected_canonical_schema: {
					schema_id: "cex-order-book-canonical/v1",
					schema_sha256: "A".repeat(64),
				},
			},
			{
				window: {
					start_at: "2026-08-18T09:27:15Z",
					end_at: "2026-08-18T09:27:17.000Z",
				},
			},
			{ depth: Number.MAX_SAFE_INTEGER + 1 },
			{ depth: 20.5 },
		];
		for (const invalid of cases) {
			expect(() =>
				backfillRequestCodec.decode(validBackfillWireRequest(invalid)),
			).toThrow();
		}
	});

	test("idempotency binds business policy but excludes attempts, selections, and deployment resource policy", () => {
		const first = validBackfillWireRequest();
		const second = validBackfillWireRequest({
			request_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f110",
			attempt_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f111",
			initial_selection: {
				...validInitialSelectionWire(),
				resolved_at: "2026-08-20T12:00:01.000Z",
			},
			product_pins: {
				...first.product_pins,
				resource_policy: {
					policy_id: "market-data-vendor-backfill-resources/test",
					policy_sha256: "b".repeat(64),
				},
			},
		});
		expect(second.idempotency_key).toBe(first.idempotency_key);
		expect(
			validBackfillWireRequest({
				coverage_policy: {
					...first.coverage_policy,
					max_asof_lag_ms: 5_001,
				},
			}).idempotency_key,
		).not.toBe(first.idempotency_key);
	});

	test("uses RFC 8785 JCS and never strips checksum-named fields", () => {
		expect(jcsCanonicalize({ z: 1, a: "x" })).toBe('{"a":"x","z":1}');
		expect(jcsSha256({ checksum: "a", value: 1 })).not.toBe(
			jcsSha256({ checksum: "b", value: 1 }),
		);
		expect(
			jcsCanonicalize({
				numbers: [Number("333333333.33333329"), 1e30, 4.5, 0.002],
			}),
		).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002]}');
	});

	test("separates semantic promotion identity from the full timestamped receipt identity", () => {
		const first = validPromotionReceiptWire();
		const second = finalizePromotionReceipt({
			...first,
			verified_at: "2026-08-20T12:00:03.000Z",
		});
		expect(promotionReceiptCodec.decode(first)).toEqual(first);
		expect(first.promotion_identity_sha256).toBe(
			second.promotion_identity_sha256,
		);
		expect(first.receipt_id).not.toBe(second.receipt_id);
		expect(first.receipt_id).toBe(documentSha256(first, "receipt_id"));
		expect(() =>
			promotionReceiptCodec.decode({
				...first,
				verified_at: second.verified_at,
			}),
		).toThrow("receipt_id");
	});

	test("validates the TEE-owned result envelope and request-file hash invariant", () => {
		const request = validBackfillWireRequest();
		const receipt = validPromotionReceiptWire();
		const result = finalizeBackfillResult({
			schema_id: BACKFILL_RESULT_SCHEMA_ID,
			job_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f120",
			request_file_sha256: "4".repeat(64),
			executable_sha256: "5".repeat(64),
			schema_manifest_sha256: "6".repeat(64),
			cex_package: {
				name: "@usherlabs/cex-broker",
				version: "0.2.46",
				package_sha256: "7".repeat(64),
			},
			capability_policy: request.product_pins.capability_policy,
			resource_policy: request.product_pins.resource_policy,
			build: {
				fiet_tee_commit: "8".repeat(40),
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
				selection: request.initial_selection,
				receipt,
				diagnostics: { promoted_rows: 50 },
			},
		});
		expect(backfillResultCodec.decode(result)).toEqual(result);
		expect(result.result_sha256).toBe(documentSha256(result, "result_sha256"));
		expect(() =>
			backfillResultCodec.decode({ ...result, request_file_sha256: null }),
		).toThrow();

		const unreadable = finalizeBackfillResult({
			...result,
			request_file_sha256: null,
			outcome: {
				status: "request_invalid",
				reason_code: "request_invalid",
				reason_subcode: "request_file_unreadable",
				request_id: null,
				idempotency_key: null,
				target: null,
				selection: null,
				receipt: null,
				diagnostics: {},
			},
		});
		expect(backfillResultCodec.decode(unreadable)).toEqual(unreadable);
	});

	test("publishes self-consistent schema and policy manifests", () => {
		expect(SCHEMA_ARTIFACTS.map(({ schema_id }) => schema_id).sort()).toEqual(
			[
				ARCHIVE_SELECTION_SCHEMA_ID,
				BACKFILL_REQUEST_SCHEMA_ID,
				BACKFILL_RESULT_SCHEMA_ID,
				PROMOTION_RECEIPT_SCHEMA_ID,
				REQUIRED_CLOCK_SCHEMA_ID,
			].sort(),
		);
		for (const artifact of SCHEMA_ARTIFACTS) {
			expect(artifact.schema_sha256).toBe(jcsSha256(artifact.schema));
		}
		expect(SCHEMA_MANIFEST.manifest_sha256).toBe(
			documentSha256(SCHEMA_MANIFEST, "manifest_sha256"),
		);
		expect(() => assertPolicyDocumentIdentity(CAPABILITY_POLICY)).not.toThrow();
		expect(() => assertPolicyDocumentIdentity(RESOURCE_POLICY)).not.toThrow();
		expect(RESOURCE_POLICY.request_bounds.max_window_ms).toBe(
			31 * 24 * 60 * 60 * 1_000,
		);
	});

	test("builds current request, clock, selection, and receipt fixtures", () => {
		requiredClockCodec.decode(CONFORMANCE_FIXTURES.documents.required_clock);
		archiveSelectionCodec.decode(
			CONFORMANCE_FIXTURES.documents.archive_selection,
		);
		backfillRequestCodec.decode(CONFORMANCE_FIXTURES.documents.request);
		promotionReceiptCodec.decode(
			CONFORMANCE_FIXTURES.documents.promotion_receipt,
		);
		expect(CONFORMANCE_FIXTURES.hashes.jcs_edge_vector_sha256).toBe(
			jcsSha256(CONFORMANCE_FIXTURES.jcs_edge_vector),
		);
	});

	test("maps validated wire documents to internal domain fields and validates the sidecar binding", () => {
		const decoded = decodeBackfillRunDocuments({
			request: CONFORMANCE_FIXTURES.documents.request,
			requiredClock: CONFORMANCE_FIXTURES.documents.required_clock,
		});
		expect(decoded).toMatchObject({
			requestId: CONFORMANCE_FIXTURES.documents.request.request_id,
			attemptId: CONFORMANCE_FIXTURES.documents.request.attempt_id,
			idempotencyKey: CONFORMANCE_FIXTURES.identities.idempotency_key,
			scope: {
				exchange: "okx",
				tradingPair: "ARB-USDT",
				sourceSymbol: "ARB-USDT",
			},
			requiredClockTargetsMs: [Date.parse("2026-08-18T09:27:16.000Z")],
			maxPriorAsOfLagMs: 5_000,
			budgets: {
				maxFiles: RESOURCE_POLICY.limits.max_files,
				maxBytes: RESOURCE_POLICY.limits.max_bytes,
			},
			target: { environment: "production", cluster: "cex-archive-primary" },
		});
		expect(() =>
			decodeBackfillRunDocuments({
				request: CONFORMANCE_FIXTURES.documents.request,
				requiredClock: {
					...CONFORMANCE_FIXTURES.documents.required_clock,
					clock_sha256: "0".repeat(64),
				},
			}),
		).toThrow("clock_sha256");
		expect(() =>
			decodeBackfillRunDocuments({
				request: {
					...CONFORMANCE_FIXTURES.documents.request,
					required_clock: {
						...CONFORMANCE_FIXTURES.documents.request.required_clock,
						event_count: 2,
					},
				},
				requiredClock: CONFORMANCE_FIXTURES.documents.required_clock,
			}),
		).toThrow();
	});
});
