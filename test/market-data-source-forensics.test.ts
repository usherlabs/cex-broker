import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	BoundedSourceForensicsSink,
	classifyImplicatedSourceObjects,
	classifySourceForensicsRecordsDeduplicated,
	classifySourceObjectEvidence,
	commitSourceQualificationEvidence,
	evaluateSourceQualificationGates,
	sourceForensicsLedgerCodec,
	sourceQualificationRecordCodec,
} from "../src/helpers/market-data-source-forensics";
import {
	finalizeRequiredClock,
	REQUIRED_CLOCK_SCHEMA_ID,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	type CryptoHftDataOrderBookRow,
	reconstructCryptoHftDataOrderBooks,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import {
	documentSha256,
	jcsCanonicalize,
} from "../src/helpers/market-data-vendor-backfill/identity";
import {
	CAPABILITY_POLICY,
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";
import { validBackfillRequest } from "./market-data-vendor-backfill-contract.test";

const start = Date.UTC(2026, 7, 18, 9, 27, 15, 308);
const targets = [start + 10_000, start + 30_000];
const object = {
	identity: "okx_spot/2026-08-18/09/ARB-USDT_orderbook.parquet.zst",
	checksums: ["a".repeat(64)],
	attempt_count: 1,
	quarantined: false,
};

function context(targetTimes = targets) {
	const targetIds = targetTimes.map(
		(_, index) =>
			`018f0f4d-7b32-7a30-8f4d-${String(200 + index).padStart(12, "0")}`,
	);
	return {
		schema_id:
			"https://schemas.usher.so/market-data-source-forensics-ledger/v1" as const,
		request_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f100" as const,
		idempotency_key: "b".repeat(64),
		scope: {
			exchange: "okx",
			trading_pair: "ARB-USDT",
			market_type: "spot" as const,
			feed: "ORDERBOOK" as const,
		},
		required_clock: {
			clock_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f102" as const,
			clock_sha256: "c".repeat(64),
			event_count: targetTimes.length,
		},
		effective_policies: {
			capability_policy: {
				policy_id: CAPABILITY_POLICY.policy_id,
				policy_sha256: CAPABILITY_POLICY.policy_sha256,
			},
			resource_policy: {
				policy_id: RESOURCE_POLICY.policy_id,
				policy_sha256: RESOURCE_POLICY.policy_sha256,
			},
			adapter_policy: EFFECTIVE_ADAPTER_POLICY_PIN,
			acquisition_policy: EFFECTIVE_ACQUISITION_POLICY_PIN,
		},
		adapter_version: "cryptohftdata-orderbook/v2",
		required_clock_targets: targetTimes.map((target_time_ms, index) => ({
			target_id: targetIds[
				index
			] as `${string}-${string}-${string}-${string}-${string}`,
			target_time_ms,
		})),
		expected_provider_object_identities: [object.identity],
	};
}

function authoritativeClock(targetTimes = targets) {
	return finalizeRequiredClock({
		schema_id: REQUIRED_CLOCK_SCHEMA_ID,
		clock_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f102",
		created_at: "2026-08-25T12:00:00.000Z",
		targets: targetTimes.map((targetTime, index) => ({
			target_id: `018f0f4d-7b32-7a30-8f4d-${String(200 + index).padStart(12, "0")}`,
			target_at: new Date(targetTime).toISOString(),
		})),
	});
}

function rehashLedger<T extends { ledger_sha256: string }>(ledger: T): T {
	const { ledger_sha256: _ledgerSha256, ...content } = ledger;
	return {
		...content,
		ledger_sha256: documentSha256(content, "ledger_sha256"),
	} as T;
}

function anchor(sequence: string, eventTimeMs = start) {
	return {
		event_time_ms: eventTimeMs,
		sequence,
		object_identity: object.identity,
		object_checksum: object.checksums[0] as string,
	};
}

describe("market-data source forensics", () => {
	test("rejects a disposition target that is absent from the authoritative required clock", () => {
		const clock = authoritativeClock([targets[0] as number]);
		const sink = new BoundedSourceForensicsSink({
			...context([targets[0] as number]),
			required_clock: {
				clock_id: clock.clock_id,
				clock_sha256: clock.clock_sha256,
				event_count: clock.targets.length,
			},
		});
		sink.observe({ type: "provider_object_boundary", object });
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[0] as number,
			source_time_ms: targets[0] as number,
			lag_ms: 0,
			status: "covered",
			object,
		});
		const ledger = sink.finish();
		const tampered = rehashLedger({
			...ledger,
			target_dispositions: ledger.target_dispositions.map((disposition) => ({
				...disposition,
				target_id: "018f0f4d-7b32-7a30-8f4d-999999999999",
			})),
		});
		expect(() => sourceForensicsLedgerCodec.decode(ledger)).toThrow(
			"authoritative required clock",
		);

		expect(() =>
			sourceForensicsLedgerCodec.decode(tampered, {
				requiredClock: clock,
			}),
		).toThrow("authoritative required clock");
	});

	test("rejects disposition evidence whose retained interval does not contain the target", () => {
		const clock = authoritativeClock();
		const sink = new BoundedSourceForensicsSink({
			...context(),
			required_clock: {
				clock_id: clock.clock_id,
				clock_sha256: clock.clock_sha256,
				event_count: clock.targets.length,
			},
		});
		sink.observe({ type: "provider_object_boundary", object });
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[0] as number,
			source_time_ms: null,
			lag_ms: null,
			status: "unanchored",
			object,
		});
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[1] as number,
			source_time_ms: targets[1] as number,
			lag_ms: 0,
			status: "covered",
			object,
		});
		const ledger = sink.finish();
		const originalRecord = ledger.records[0] as (typeof ledger.records)[number];
		const { record_sha256: _recordSha256, ...recordContent } = originalRecord;
		const alteredRecordContent = {
			...recordContent,
			target_interval: {
				start_target_time_ms: targets[1] as number,
				end_target_time_ms_exclusive: (targets[1] as number) + 1,
				target_count: 1,
			},
		};
		const alteredRecord = {
			...alteredRecordContent,
			record_sha256: documentSha256(alteredRecordContent, "record_sha256"),
		};
		const tampered = rehashLedger({
			...ledger,
			records: [alteredRecord],
			target_dispositions: ledger.target_dispositions.map((disposition) =>
				disposition.target_time_ms === targets[0]
					? { ...disposition, record_sha256s: [alteredRecord.record_sha256] }
					: disposition,
			),
		});

		expect(() =>
			sourceForensicsLedgerCodec.decode(tampered, {
				requiredClock: clock,
			}),
		).toThrow("record interval");
	});

	test("rejects omitted, duplicated, changed, and misordered authoritative dispositions", () => {
		const clock = authoritativeClock();
		const sink = new BoundedSourceForensicsSink({
			...context(),
			required_clock: {
				clock_id: clock.clock_id,
				clock_sha256: clock.clock_sha256,
				event_count: clock.targets.length,
			},
		});
		sink.observe({ type: "provider_object_boundary", object });
		for (const targetTime of targets) {
			sink.observe({
				type: "required_clock_sample",
				target_time_ms: targetTime,
				source_time_ms: targetTime,
				lag_ms: 0,
				status: "covered",
				object,
			});
		}
		const ledger = sink.finish();
		const mutations = [
			{
				...ledger,
				target_dispositions: ledger.target_dispositions.slice(0, 1),
			},
			{
				...ledger,
				target_dispositions: [
					ledger.target_dispositions[0],
					ledger.target_dispositions[0],
				],
			},
			{
				...ledger,
				target_dispositions: ledger.target_dispositions.map((value, index) =>
					index === 0
						? { ...value, target_time_ms: value.target_time_ms + 1 }
						: value,
				),
			},
			{
				...ledger,
				target_dispositions: [...ledger.target_dispositions].reverse(),
			},
		];

		for (const mutation of mutations) {
			expect(() =>
				sourceForensicsLedgerCodec.decode(rehashLedger(mutation), {
					requiredClock: clock,
				}),
			).toThrow();
		}
	});

	test("rejects non-canonical or checksum-unbound positive provider inventory", () => {
		const clock = authoritativeClock();
		const sink = new BoundedSourceForensicsSink({
			...context(),
			required_clock: {
				clock_id: clock.clock_id,
				clock_sha256: clock.clock_sha256,
				event_count: clock.targets.length,
			},
		});
		sink.observe({ type: "provider_object_boundary", object });
		for (const targetTime of targets) {
			sink.observe({
				type: "required_clock_sample",
				target_time_ms: targetTime,
				source_time_ms: targetTime,
				lag_ms: 0,
				status: "covered",
				object,
			});
		}
		const ledger = sink.finish();
		const missingObjectEvidence = rehashLedger({
			...ledger,
			provider_objects: [],
		});
		expect(() =>
			sourceForensicsLedgerCodec.decode(missingObjectEvidence, {
				requiredClock: clock,
			}),
		).toThrow("provider inventory");

		const duplicateInterval =
			ledger.provider_object_inventory.expected_selected_intervals[0];
		const duplicateIntervals = rehashLedger({
			...ledger,
			provider_object_inventory: {
				...ledger.provider_object_inventory,
				expected_selected_intervals: [
					...ledger.provider_object_inventory.expected_selected_intervals,
					duplicateInterval,
				],
			},
		});
		expect(() =>
			sourceForensicsLedgerCodec.decode(duplicateIntervals, {
				requiredClock: clock,
			}),
		).toThrow();
	});
	test("partitions every submitted target and keeps qualification gates distinct", () => {
		const sink = new BoundedSourceForensicsSink(context());
		sink.observe({ type: "provider_object_boundary", object });
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[0] as number,
			source_time_ms: (targets[0] as number) - 5_000,
			lag_ms: 5_000,
			status: "covered",
			object,
		});
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[1] as number,
			source_time_ms: start,
			lag_ms: (targets[1] as number) - start,
			status: "stale",
			object,
		});
		sink.classifyRecord(
			{
				kind: "stale_target_interval",
				target_time_ms: targets[1] as number,
				object_identity: object.identity,
			},
			"valid_inactive_market_state",
		);

		const ledger = sink.finish();
		expect(ledger.summary).toMatchObject({
			disposition_complete: true,
			fresh_target_count: 1,
			inactive_target_count: 1,
			disqualifying_target_count: 0,
			omitted_target_disposition_count: 0,
		});
		expect(
			ledger.target_dispositions.map(({ disposition }) => disposition),
		).toEqual(["fresh_within_bound", "valid_inactive_market_state"]);
		expect(evaluateSourceQualificationGates(ledger, true)).toEqual({
			operation_kind: "required_clock_qualification",
			qualified: false,
			source_partition_complete: true,
			source_event_enumeration_eligible: true,
		});
	});

	test("a zero-affected unresolved gap does not fail submitted-clock qualification but blocks source-event enumeration", () => {
		const sink = new BoundedSourceForensicsSink(
			context([targets[0] as number]),
		);
		sink.observe({ type: "provider_object_boundary", object });
		sink.observe({
			type: "sequence_discontinuity",
			sequence: {
				expected_previous: "200",
				observed_previous: "199",
				observed_final: "201",
				event_time_ms: start + 1_000,
			},
			object,
		});
		sink.observe({ type: "reanchor", anchor: anchor("300", start + 2_000) });
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[0] as number,
			source_time_ms: (targets[0] as number) - 1_000,
			lag_ms: 1_000,
			status: "covered",
			object,
		});
		expect(evaluateSourceQualificationGates(sink.finish(), true)).toEqual({
			operation_kind: "required_clock_qualification",
			qualified: true,
			source_partition_complete: true,
			source_event_enumeration_eligible: false,
		});
	});

	test("source reconstruction acceptance is required for strict qualification", () => {
		const sink = new BoundedSourceForensicsSink(
			context([targets[0] as number]),
		);
		sink.observe({ type: "provider_object_boundary", object });
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[0] as number,
			source_time_ms: targets[0] as number,
			lag_ms: 0,
			status: "covered",
			object,
		});
		expect(
			evaluateSourceQualificationGates(sink.finish(), false).qualified,
		).toBe(false);
	});

	test("keeps the worst-case 100,000-target all-fresh ledger within the whole-document byte limit", () => {
		const targetTimes = Array.from(
			{ length: 100_000 },
			(_, index) => start + index,
		);
		const sink = new BoundedSourceForensicsSink(context(targetTimes));
		sink.observe({ type: "provider_object_boundary", object });
		for (const targetTime of targetTimes) {
			sink.observe({
				type: "required_clock_sample",
				target_time_ms: targetTime,
				source_time_ms: targetTime,
				lag_ms: 0,
				status: "covered",
				object,
			});
		}
		const ledger = sink.finish();
		expect(ledger.summary).toMatchObject({
			disposition_complete: true,
			fresh_target_count: 100_000,
			omitted_target_disposition_count: 0,
		});
		expect(
			new TextEncoder().encode(jcsCanonicalize(ledger)).byteLength,
		).toBeLessThanOrEqual(67_108_864);
	}, 120_000);

	test("records a gap, affected interval, later anchor, and closed classification", () => {
		const plantedSecret = "planted-ledger-secret";
		const clock = authoritativeClock();
		const sink = new BoundedSourceForensicsSink({
			...context(),
			required_clock: {
				clock_id: clock.clock_id,
				clock_sha256: clock.clock_sha256,
				event_count: clock.targets.length,
			},
			redact_values: new Set([plantedSecret]),
		});
		sink.observe({
			type: "snapshot_anchor",
			anchor: {
				...anchor("200"),
				object_identity: `${object.identity}/${plantedSecret}`,
			},
		});
		sink.observe({
			type: "sequence_discontinuity",
			sequence: {
				expected_previous: "200",
				observed_previous: "199",
				observed_final: "201",
				event_time_ms: start + 5_000,
			},
			object: { ...object, identity: `${object.identity}/${plantedSecret}` },
		});
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[0] as number,
			source_time_ms: null,
			lag_ms: null,
			status: "unanchored",
			object: null,
		});
		sink.observe({
			type: "reanchor",
			anchor: anchor("300", start + 20_000),
		});
		sink.classifyRecord(
			{
				kind: "sequence_discontinuity",
				target_time_ms: targets[0] as number,
				object_identity: `${object.identity}/${plantedSecret}`,
			},
			"object_boundary_order_defect",
		);

		const ledger = sink.finish();
		expect(
			sourceForensicsLedgerCodec.decode(ledger, { requiredClock: clock }),
		).toEqual(ledger);
		expect(JSON.stringify(ledger)).not.toContain(plantedSecret);
		expect(ledger.summary.affected_target_count).toBe(1);
		expect(ledger.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "sequence_discontinuity",
					classification: "object_boundary_order_defect",
					next_anchor: expect.objectContaining({ sequence: "300" }),
					target_interval: expect.objectContaining({ target_count: 1 }),
				}),
			]),
		);
	});

	test("overflow remains non-throwing and finishes an incomplete bounded ledger", () => {
		const sink = new BoundedSourceForensicsSink(context(), {
			maxRetainedRecords: 1,
		});
		for (const [index, targetTime] of targets.entries()) {
			sink.observe({
				type: "required_clock_sample",
				target_time_ms: targetTime,
				source_time_ms: start,
				lag_ms: targetTime - start,
				status: index === 0 ? "stale" : "future",
				object,
			});
		}
		const ledger = sink.finish();
		expect(ledger).toMatchObject({
			complete: false,
			incomplete_reason: "forensics_evidence_bound_exceeded",
			summary: {
				retained_record_count: 1,
				total_record_count: 2,
				omitted_record_count: 1,
			},
		});
	});

	test("canonical byte overflow omits records without changing published limits", () => {
		const sink = new BoundedSourceForensicsSink(context(), {
			maxCanonicalJsonBytes: 1_500,
		});
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[0] as number,
			source_time_ms: start,
			lag_ms: 10_000,
			status: "stale",
			object,
		});
		const ledger = sink.finish();
		expect(ledger.complete).toBe(false);
		expect(ledger.summary.omitted_record_count).toBeGreaterThan(0);
		expect(ledger.limits).toEqual({
			max_records: 100_000,
			max_canonical_json_bytes: 67_108_864,
		});
	});

	test("observer collection and observer failure cannot change reconstruction", () => {
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
			requiredClockTargetsMs: [targets[1] as number],
			maxPriorAsOfLagMs: 60_000,
		});
		const rows = (["bid", "ask"] as const).map(
			(side): CryptoHftDataOrderBookRow => ({
				received_time: String(BigInt(start + 1_000) * 1_000_000n),
				event_time: String(start),
				symbol: "ARB-USDT",
				event_type: "snapshot",
				first_update_id: null,
				final_update_id: "200",
				prev_final_update_id: null,
				last_update_id: "-1",
				side,
				price: side === "bid" ? "100" : "101",
				quantity: "1",
				dataset_object_identity: object.identity,
				dataset_object_checksum: object.checksums[0] as string,
			}),
		);
		const baseline = reconstructCryptoHftDataOrderBooks(
			request,
			rows,
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
		);
		const observed = reconstructCryptoHftDataOrderBooks(
			request,
			rows,
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
			new BoundedSourceForensicsSink(context([targets[1] as number])),
		);
		const throwing = reconstructCryptoHftDataOrderBooks(
			request,
			rows,
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
			{
				observe: () => {
					throw new Error("observer failure");
				},
			},
		);
		expect(observed).toEqual(baseline);
		expect(throwing).toEqual(baseline);
	});

	test("durably commits the ledger before its atomic qualification record", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-forensics-"));
		let cleaned = false;
		try {
			const clock = authoritativeClock([targets[0] as number]);
			const sink = new BoundedSourceForensicsSink({
				...context([targets[0] as number]),
				required_clock: {
					clock_id: clock.clock_id,
					clock_sha256: clock.clock_sha256,
					event_count: 1,
				},
			});
			sink.observe({ type: "provider_object_boundary", object });
			sink.observe({
				type: "required_clock_sample",
				target_time_ms: targets[0] as number,
				source_time_ms: targets[0] as number,
				lag_ms: 0,
				status: "covered",
				object,
			});
			const ledger = sink.finish();
			const qualification = await commitSourceQualificationEvidence({
				outputDirectory: root,
				ledgerFileName: "arb-usdt-forensics.json",
				qualificationFileName: "arb-usdt-qualification.json",
				ledger,
				createdAt: "2026-08-25T12:00:00.000Z",
				sourceAccepted: true,
				requiredClock: clock,
				cleanupLicensedPayloads: () => {
					cleaned = true;
				},
			});
			expect(qualification).toMatchObject({
				outcome: {
					status: "success",
					reason: "required_clock_qualification_completed",
					exporter_result: null,
				},
			});
			const ledgerBytes = await readFile(
				path.join(root, qualification.ledger.file_name),
			);
			expect(qualification.ledger.sha256).toBe(
				createHash("sha256").update(ledgerBytes).digest("hex"),
			);
			expect(
				sourceQualificationRecordCodec.decode(
					JSON.parse(
						await readFile(
							path.join(root, "arb-usdt-qualification.json"),
							"utf8",
						),
					),
				),
			).toEqual(qualification);
			expect(cleaned).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a failed source run cannot qualify an otherwise clean ledger", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-forensics-"));
		try {
			const clock = authoritativeClock([targets[0] as number]);
			const sink = new BoundedSourceForensicsSink({
				...context([targets[0] as number]),
				required_clock: {
					clock_id: clock.clock_id,
					clock_sha256: clock.clock_sha256,
					event_count: 1,
				},
			});
			sink.observe({ type: "provider_object_boundary", object });
			sink.observe({
				type: "required_clock_sample",
				target_time_ms: targets[0] as number,
				source_time_ms: targets[0] as number,
				lag_ms: 0,
				status: "covered",
				object,
			});
			const qualification = await commitSourceQualificationEvidence({
				outputDirectory: root,
				ledgerFileName: "failed-forensics.json",
				qualificationFileName: "failed-qualification.json",
				ledger: sink.finish(),
				createdAt: "2026-08-25T12:00:00.000Z",
				sourceAccepted: false,
				requiredClock: clock,
			});
			expect(qualification.ledger.complete).toBe(true);
			expect(qualification.qualified).toBe(false);
			expect(qualification).toMatchObject({
				outcome: {
					status: "failure",
					reason: "required_clock_reconstruction_failed",
					exporter_result: null,
				},
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("source-tape terminal evidence binds a consumer-visible initializer", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-forensics-"));
		try {
			const sink = new BoundedSourceForensicsSink({
				...context([]),
				operation_kind: "source_tape",
				window: {
					start_time_ms: Date.UTC(2026, 7, 18, 9),
					end_time_ms_exclusive: Date.UTC(2026, 7, 18, 10),
				},
				source_tape: {
					product_id: "market-data-source-tape",
					product_version: "market-data-source-tape/v1",
					state_count: 2,
				},
			});
			sink.observe({ type: "provider_object_boundary", object });
			sink.setSourceTapeStateCount(2);
			const qualification = await commitSourceQualificationEvidence({
				outputDirectory: root,
				ledgerFileName: "source-tape-ledger.json",
				qualificationFileName: "source-tape-qualification.json",
				ledger: sink.finish(),
				createdAt: "2026-08-25T12:00:00.000Z",
				sourceAccepted: true,
				sourceTapeInitializer: {
					canonical_snapshot_id: "d".repeat(64),
					source_time_ms: start,
					sequence: "200",
					semantic_stream_position: 0,
				},
				sourceTapeOutcome: {
					status: "success",
					reason: "source_tape_prepared",
					partial_evidence: [],
					exporter_result: {
						schema_id:
							"https://schemas.usher.so/cex-canonical-orderbook-export-result/v2",
						file_name: "source-tape-export-result.json",
						sha256: "e".repeat(64),
						bytes: 1,
						result_sha256: "f".repeat(64),
					},
				},
			});
			expect(qualification).toMatchObject({
				operation_kind: "source_tape",
				source_tape_eligible: true,
				initializer: {
					canonical_snapshot_id: "d".repeat(64),
					source_time_ms: start,
					sequence: "200",
					semantic_stream_position: 0,
				},
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("classifies bounded re-fetch evidence without creating an acceptance replay", () => {
		expect(
			classifySourceObjectEvidence({
				checksums: ["a", "b"],
				schemaValid: true,
				sequenceValid: true,
				missingRows: false,
				completeSnapshotDefect: false,
				alternateOrderingClosesGap: true,
				staleWithValidPriorState: false,
			}),
		).toBe("mutable_provider_bytes");
		expect(
			classifySourceObjectEvidence({
				checksums: ["a"],
				schemaValid: true,
				sequenceValid: true,
				missingRows: false,
				completeSnapshotDefect: false,
				alternateOrderingClosesGap: false,
				staleWithValidPriorState: true,
			}),
		).toBe("valid_inactive_market_state");
	});

	test("re-fetches only an implicated object and its adjacent objects under the retry cap", async () => {
		const calls: Array<{ identity: string; attempt: number }> = [];
		const result = await classifyImplicatedSourceObjects({
			originalIdentity: "hour-10",
			adjacentIdentities: ["hour-09", "hour-11"],
			maxAttempts: 3,
			inspect: async (identity, attempt) => {
				calls.push({ identity, attempt });
				return {
					checksum:
						identity === "hour-10" && attempt === 3
							? "d".repeat(64)
							: "a".repeat(64),
					schemaValid: true,
					sequenceValid: true,
					missingRows: false,
					completeSnapshotDefect: false,
					alternateOrderingClosesGap: false,
					staleWithValidPriorState: false,
				};
			},
		});

		expect(result.classification).toBe("mutable_provider_bytes");
		expect(
			result.objects.find(({ identity }) => identity === "hour-10"),
		).toEqual(
			expect.objectContaining({
				attempt_count: 3,
				checksums: ["a".repeat(64), "d".repeat(64)],
				quarantined: true,
			}),
		);
		expect(new Set(calls.map(({ identity }) => identity))).toEqual(
			new Set(["hour-09", "hour-10", "hour-11"]),
		);
		expect(calls).toHaveLength(9);
	});

	test("deduplicates bounded provider-object inspection across overlapping records", async () => {
		const calls: string[] = [];
		const results = await classifySourceForensicsRecordsDeduplicated({
			requests: [
				{
					record_key: "record-1",
					object_identities: ["hour-09", "hour-10", "hour-11"],
				},
				{
					record_key: "record-2",
					object_identities: ["hour-10", "hour-11", "hour-12"],
				},
			],
			maxAttempts: 3,
			inspect: async (identity) => {
				calls.push(identity);
				return {
					checksum: "a".repeat(64),
					schemaValid: true,
					sequenceValid: true,
					missingRows: false,
					completeSnapshotDefect: false,
					alternateOrderingClosesGap: false,
					staleWithValidPriorState: true,
				};
			},
		});
		expect(calls).toHaveLength(12);
		expect(results.map(({ classification }) => classification)).toEqual([
			"valid_inactive_market_state",
			"valid_inactive_market_state",
		]);
	});

	test("stable re-fetch evidence distinguishes corruption, row loss, boundary order, and inactivity", async () => {
		for (const [overrides, expected] of [
			[{ schemaValid: false }, "stable_object_corruption"],
			[{ missingRows: true }, "provider_row_loss"],
			[{ alternateOrderingClosesGap: true }, "object_boundary_order_defect"],
			[{ staleWithValidPriorState: true }, "valid_inactive_market_state"],
		] as const) {
			const result = await classifyImplicatedSourceObjects({
				originalIdentity: "hour-10",
				adjacentIdentities: ["hour-09", "hour-11"],
				maxAttempts: 3,
				inspect: async () => ({
					checksum: "a".repeat(64),
					schemaValid: true,
					sequenceValid: true,
					missingRows: false,
					completeSnapshotDefect: false,
					alternateOrderingClosesGap: false,
					staleWithValidPriorState: false,
					...overrides,
				}),
			});
			expect(result.classification).toBe(expected);
		}
	});

	test("checksum conflict records bind affected required targets", () => {
		const sink = new BoundedSourceForensicsSink(context());
		sink.observe({
			type: "provider_object_checksum_conflict",
			object: {
				...object,
				checksums: ["a".repeat(64), "d".repeat(64)],
				attempt_count: 2,
				quarantined: true,
			},
			affected_target_times_ms: targets,
		});
		const ledger = sink.finish();
		expect(ledger.summary.affected_target_count).toBe(2);
		expect(ledger.records[0]).toMatchObject({
			kind: "provider_object_checksum_conflict",
			classification: "mutable_provider_bytes",
			target_interval: { target_count: 2 },
		});
	});

	test("contradictory overlapping evidence is disqualifying without precedence", () => {
		const sink = new BoundedSourceForensicsSink(
			context([targets[0] as number]),
		);
		sink.observe({ type: "provider_object_boundary", object });
		sink.observe({
			type: "required_clock_sample",
			target_time_ms: targets[0] as number,
			source_time_ms: (targets[0] as number) - 1_000,
			lag_ms: 1_000,
			status: "covered",
			object,
		});
		sink.observe({
			type: "provider_object_checksum_conflict",
			object: {
				...object,
				checksums: ["a".repeat(64), "d".repeat(64)],
				attempt_count: 2,
				quarantined: true,
			},
			affected_target_times_ms: [targets[0] as number],
		});
		const ledger = sink.finish();
		expect(ledger.target_dispositions[0]?.disposition).toBe("disqualifying");
		expect(evaluateSourceQualificationGates(ledger, true)).toMatchObject({
			qualified: false,
			source_partition_complete: false,
			source_event_enumeration_eligible: false,
		});
	});

	test("streaming replay produces a deterministic ledger identity", () => {
		const replay = () => {
			const sink = new BoundedSourceForensicsSink(context());
			sink.observe({ type: "snapshot_anchor", anchor: anchor("200") });
			for (const targetTime of targets) {
				sink.observe({
					type: "required_clock_sample",
					target_time_ms: targetTime,
					source_time_ms: start,
					lag_ms: targetTime - start,
					status: "stale",
					object,
				});
			}
			return sink.finish();
		};
		expect(replay()).toEqual(replay());
	});
});
