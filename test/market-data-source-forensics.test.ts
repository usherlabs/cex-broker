import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	BoundedSourceForensicsSink,
	classifyImplicatedSourceObjects,
	classifySourceObjectEvidence,
	commitSourceQualificationEvidence,
	sourceForensicsLedgerCodec,
	sourceQualificationRecordCodec,
} from "../src/helpers/market-data-source-forensics";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	type CryptoHftDataOrderBookRow,
	reconstructCryptoHftDataOrderBooks,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
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
		required_clock_target_times_ms: targetTimes,
	};
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
	test("records a gap, affected interval, later anchor, and closed classification", () => {
		const plantedSecret = "planted-ledger-secret";
		const sink = new BoundedSourceForensicsSink({
			...context(),
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
		sink.classifyObject(
			`${object.identity}/${plantedSecret}`,
			"object_boundary_order_defect",
		);

		const ledger = sink.finish();
		expect(sourceForensicsLedgerCodec.decode(ledger)).toEqual(ledger);
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
			const ledger = new BoundedSourceForensicsSink(context([])).finish();
			const qualification = await commitSourceQualificationEvidence({
				outputDirectory: root,
				ledgerFileName: "arb-usdt-forensics.json",
				qualificationFileName: "arb-usdt-qualification.json",
				ledger,
				createdAt: "2026-08-25T12:00:00.000Z",
				sourceAccepted: true,
				cleanupLicensedPayloads: () => {
					cleaned = true;
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
			const qualification = await commitSourceQualificationEvidence({
				outputDirectory: root,
				ledgerFileName: "failed-forensics.json",
				qualificationFileName: "failed-qualification.json",
				ledger: new BoundedSourceForensicsSink(context([])).finish(),
				createdAt: "2026-08-25T12:00:00.000Z",
				sourceAccepted: false,
			});
			expect(qualification.ledger.complete).toBe(true);
			expect(qualification.qualified).toBe(false);
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
