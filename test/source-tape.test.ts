import { describe, expect, test } from "bun:test";
import { validateExternalBackfillBatch } from "../services/archive-forwarder/market-data-backfill-contract";
import { compileExactOrderBookExport } from "../src/helpers/canonical-orderbook-export/exact-selection";
import {
	CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
	canonicalOrderBookExportRequestCodec,
} from "../src/helpers/market-data-preparation/contracts";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import { promotionReceiptCodec } from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	type CryptoHftDataOrderBookRow,
	reconstructCryptoHftDataOrderBooks,
	reconstructCryptoHftDataPolicyNeutralTape,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import {
	finalizePromotionReceipt,
	promotionReceiptMatchesCurrentPolicies,
} from "../src/helpers/market-data-vendor-backfill/promotion";
import {
	assertSourceTapeSandboxAuthorization,
	createSourceTapeArchiveSink,
	evaluateSourceTapeEligibility,
	normalizeSourceTapeStates,
	SOURCE_TAPE_CAPABILITY,
	SOURCE_TAPE_CAPABILITY_ID,
	SOURCE_TAPE_CONSTRUCTION_MODE,
	SOURCE_TAPE_MAX_BATCH_BYTES,
	SOURCE_TAPE_MAX_BATCH_ROWS,
	SOURCE_TAPE_MAX_IN_FLIGHT,
	SOURCE_TAPE_MAX_STATES_PER_YIELD,
	SOURCE_TAPE_PROJECTION_PINS,
	SOURCE_TAPE_SANDBOX_TARGET,
} from "../src/helpers/source-tape";
import { validBackfillRequest } from "./market-data-vendor-backfill-contract.test";

const start = Date.UTC(2026, 7, 18, 9, 0, 0);
const objectIdentity = "okx_spot/2026-08-18/09/ARB-USDT_orderbook.parquet.zst";
const checksum = "a".repeat(64);

function group(
	eventTimeMs: number,
	eventType: "snapshot" | "update",
	sequence: string,
	previous: string,
	prices: { bid: string; ask: string },
): CryptoHftDataOrderBookRow[] {
	return (["bid", "ask"] as const).map((side) => ({
		received_time: String(BigInt(eventTimeMs + 1) * 1_000_000n),
		event_time: String(eventTimeMs),
		symbol: "ARB-USDT",
		event_type: eventType,
		first_update_id: null,
		final_update_id: sequence,
		prev_final_update_id: null,
		last_update_id: previous,
		side,
		price: prices[side],
		quantity: "1",
		dataset_object_identity: objectIdentity,
		dataset_object_checksum: checksum,
	}));
}

describe("role-neutral policy-neutral source tape", () => {
	test("pins bounded sandbox submission and preserves authorization-class semantics", () => {
		expect(SOURCE_TAPE_MAX_STATES_PER_YIELD).toBe(4);
		expect(SOURCE_TAPE_MAX_BATCH_ROWS).toBe(1_000);
		expect(SOURCE_TAPE_MAX_BATCH_BYTES).toBe(5_242_880);
		expect(SOURCE_TAPE_MAX_IN_FLIGHT).toBe(1);
		expect(SOURCE_TAPE_SANDBOX_TARGET).toEqual({
			environment: "sandbox",
			cluster: "cex-archive-local",
		});
		expect(() =>
			assertSourceTapeSandboxAuthorization({
				requestAuthorizationId: "246b2dbd-8594-4da1-9cc7-6060f2f5d0be",
				requestTarget: SOURCE_TAPE_SANDBOX_TARGET,
				preflight: {
					authorizationId: "246b2dbd-8594-4da1-9cc7-6060f2f5d0be",
					scope: "production",
					environment: "sandbox",
					cluster: "cex-archive-local",
					credentialValidated: true,
				},
			}),
		).not.toThrow();
		expect(() =>
			assertSourceTapeSandboxAuthorization({
				requestAuthorizationId: "246b2dbd-8594-4da1-9cc7-6060f2f5d0be",
				requestTarget: { environment: "production", cluster: "primary" },
				preflight: {
					authorizationId: "246b2dbd-8594-4da1-9cc7-6060f2f5d0be",
					scope: "production",
					environment: "production",
					cluster: "primary",
					credentialValidated: true,
				},
			}),
		).toThrow("source_tape_sandbox_target_mismatch");
	});

	test("submits bounded canonical rows through the normal archive forwarder", async () => {
		const request = validBackfillRequest({
			providerPolicy: {
				provider: "cryptohftdata",
				allowedAdapterVersions: ["cryptohftdata-orderbook/v2"],
			},
			scope: {
				exchange: "okx",
				tradingPair: "ARB-USDT",
				sourceSymbol: "ARB-USDT",
				marketType: "spot",
				feed: "ORDERBOOK",
			},
			window: { startTimeMs: start, endTimeMs: start + 60_000 },
			requiredClockTargetsMs: [start + 10_000],
			depth: 100,
		});
		const tape = reconstructCryptoHftDataPolicyNeutralTape(
			request,
			[
				...group(start, "snapshot", "200", "-1", {
					bid: "100",
					ask: "101",
				}),
				...group(start + 20_000, "update", "201", "200", {
					bid: "100.5",
					ask: "101",
				}),
			],
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
		);
		const batches: Array<{ rows: unknown[] }> = [];
		let inFlight = 0;
		let maximumInFlight = 0;
		const sink = createSourceTapeArchiveSink({
			captureBundleId: "b".repeat(64),
			tradingPair: "ARB-USDT",
			window: request.window,
			forwarder: {
				async submit(batch) {
					expect(validateExternalBackfillBatch(batch)).toEqual({ ok: true });
					inFlight += 1;
					maximumInFlight = Math.max(maximumInFlight, inFlight);
					batches.push(batch);
					await Bun.sleep(1);
					inFlight -= 1;
					return { ok: true, inserted: batch.rows.length };
				},
			},
		});
		await sink.writeBatch(tape);
		await sink.complete({
			expectedObjectIdentities: [objectIdentity],
			observedObjects: [
				{ identity: objectIdentity, checksum, bytes: 10, rows: 4 },
			],
			stateCount: tape.length,
		});
		const result = sink.result();
		const initializerSummary = batches
			.flatMap(({ rows }) => rows)
			.find(
				(entry) =>
					(entry as { table: string }).table ===
					"market_data.cex_order_book_depth_summary",
			) as { row: { snapshot_id: string } };
		expect(maximumInFlight).toBe(1);
		expect(batches.every(({ rows }) => rows.length <= 1_000)).toBe(true);
		expect(
			batches
				.flatMap(({ rows }) => rows)
				.every((entry) =>
					[
						"market_data.cex_order_book_levels",
						"market_data.cex_order_book_depth_summary",
					].includes((entry as { table: string }).table),
				),
		).toBe(true);
		expect(result).toMatchObject({
			capture_bundle_id: "b".repeat(64),
			state_count: 2,
			provider_object_inventory_complete: true,
			max_in_flight_submissions: 1,
			initializer: {
				canonical_snapshot_id: initializerSummary.row.snapshot_id,
				source_time_ms: start,
				sequence: "200",
				semantic_stream_position: 0,
			},
		});
	});

	test("normal receipt and exporter codecs identify the qualification tape mode", () => {
		const base = CONFORMANCE_FIXTURES.documents.promotion_receipt;
		const receipt = finalizePromotionReceipt({
			...base,
			receipt_id: undefined,
			promotion_identity_sha256: undefined,
			construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
			effective_policies: {
				...base.effective_policies,
				capability_policy: {
					policy_id: SOURCE_TAPE_CAPABILITY.policy_id,
					policy_sha256: SOURCE_TAPE_CAPABILITY.policy_sha256,
				},
			},
		});
		expect(promotionReceiptCodec.decode(receipt)).toEqual(receipt);
		expect(promotionReceiptMatchesCurrentPolicies(receipt)).toBe(true);
		expect(
			canonicalOrderBookExportRequestCodec.decode({
				schema_id: CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
				request_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f199",
				target: SOURCE_TAPE_SANDBOX_TARGET,
				selection: CONFORMANCE_FIXTURES.documents.archive_selection,
				depth: 100,
				construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
				canonical_schema_version: "1.0.0",
				checksum_algorithm: "sha256-canonical-json-v1",
			}),
		).toMatchObject({
			construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
		});
		const compiled = compileExactOrderBookExport({
			schema_id: CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
			request_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f199",
			target: SOURCE_TAPE_SANDBOX_TARGET,
			selection: CONFORMANCE_FIXTURES.documents.archive_selection,
			depth: 100,
			construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
			canonical_schema_version: "1.0.0",
			checksum_algorithm: "sha256-canonical-json-v1",
		});
		expect(compiled.parameters.current_capability_policy_id).toBe(
			SOURCE_TAPE_CAPABILITY.policy_id,
		);
		expect(compiled.parameters.current_capability_policy_sha256).toBe(
			SOURCE_TAPE_CAPABILITY.policy_sha256,
		);
	});

	test("retains every intervening OKX state change independently of a required clock", () => {
		const request = validBackfillRequest({
			providerPolicy: {
				provider: "cryptohftdata",
				allowedAdapterVersions: ["cryptohftdata-orderbook/v2"],
			},
			scope: {
				exchange: "okx",
				tradingPair: "ARB-USDT",
				sourceSymbol: "ARB-USDT",
				marketType: "spot",
				feed: "ORDERBOOK",
			},
			window: { startTimeMs: start, endTimeMs: start + 60_000 },
			requiredClockTargetsMs: [start + 10_000],
			depth: 100,
		});
		const rows = [
			...group(start, "snapshot", "200", "-1", {
				bid: "100",
				ask: "101",
			}),
			...group(start + 20_000, "update", "201", "200", {
				bid: "100.5",
				ask: "101",
			}),
		];

		expect(
			reconstructCryptoHftDataOrderBooks(
				request,
				rows,
				CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
			),
		).toHaveLength(1);
		const tape = reconstructCryptoHftDataPolicyNeutralTape(
			request,
			rows,
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
		);
		expect(tape.map(({ sourceTimeMs }) => sourceTimeMs)).toEqual([
			start,
			start + 20_000,
		]);
		expect(tape.map(({ tapeState }) => tapeState)).toEqual([
			"initialization",
			"change",
		]);
		const canonicalRows = normalizeSourceTapeStates({
			tape,
			capture_bundle_id: "b".repeat(64),
			trading_pair: "ARB-USDT",
		});
		expect(canonicalRows).toHaveLength(7);
		expect(
			new Set(canonicalRows.map(({ row }) => row.construction_mode)),
		).toEqual(new Set([SOURCE_TAPE_CONSTRUCTION_MODE]));
	});

	test("emits one support state and excludes the exclusive end boundary", () => {
		const request = validBackfillRequest({
			providerPolicy: {
				provider: "cryptohftdata",
				allowedAdapterVersions: ["cryptohftdata-orderbook/v2"],
			},
			scope: {
				exchange: "okx",
				tradingPair: "ARB-USDT",
				sourceSymbol: "ARB-USDT",
				marketType: "spot",
				feed: "ORDERBOOK",
			},
			window: { startTimeMs: start, endTimeMs: start + 20_000 },
			requiredClockTargetsMs: [start + 10_000],
			depth: 100,
		});
		const rows = [
			...group(start - 1_000, "snapshot", "199", "-1", {
				bid: "100",
				ask: "101",
			}),
			...group(start + 5_000, "update", "200", "199", {
				bid: "100.1",
				ask: "101",
			}),
			...group(start + 20_000, "update", "201", "200", {
				bid: "100.2",
				ask: "101",
			}),
		];
		const tape = reconstructCryptoHftDataPolicyNeutralTape(
			request,
			rows,
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
		);
		expect(tape.map(({ tapeState }) => tapeState)).toEqual([
			"initialization",
			"change",
		]);
		expect(tape.map(({ sourceTimeMs }) => sourceTimeMs)).toEqual([
			start - 1_000,
			start + 5_000,
		]);
	});

	test("requires positive complete inventory and role-neutral enumeration eligibility", () => {
		const inventory = {
			expected_identities: [objectIdentity],
			observed_identities: [objectIdentity],
			complete: true,
		};
		expect(
			evaluateSourceTapeEligibility({
				source_enumeration_eligible: true,
				provider_object_inventory: inventory,
				tape_complete: true,
				capability_id: SOURCE_TAPE_CAPABILITY_ID,
				capability_sha256: SOURCE_TAPE_CAPABILITY.policy_sha256,
				construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
				projection_schema_pins: SOURCE_TAPE_PROJECTION_PINS,
				artifact_sha256s: ["b".repeat(64), "c".repeat(64)],
				tape_manifest_sha256: "d".repeat(64),
			}),
		).toBe(true);
		expect(
			evaluateSourceTapeEligibility({
				source_enumeration_eligible: true,
				provider_object_inventory: {
					...inventory,
					observed_identities: [],
					complete: false,
				},
				tape_complete: true,
				capability_id: SOURCE_TAPE_CAPABILITY_ID,
				capability_sha256: SOURCE_TAPE_CAPABILITY.policy_sha256,
				construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
				projection_schema_pins: SOURCE_TAPE_PROJECTION_PINS,
				artifact_sha256s: ["b".repeat(64), "c".repeat(64)],
				tape_manifest_sha256: "d".repeat(64),
			}),
		).toBe(false);
	});
});
