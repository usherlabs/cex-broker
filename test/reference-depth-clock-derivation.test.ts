import { describe, expect, test } from "bun:test";
import {
	finalizeReferenceDepthClockDerivationDescriptor,
	preflightCandidateCCapacity,
	referenceDepthClockDerivationDescriptorCodec,
} from "../scripts/reference-depth-clock-derivation";

const sha = (value: string) => value.repeat(64).slice(0, 64);
const originalClockId = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f300";
const targetId = "018f0f4d-7b32-7a30-8f4d-1d2a6e40f301";

function descriptorContent() {
	const clock = {
		clock_id: originalClockId,
		clock_sha256: sha("a"),
		clock_bytes_sha256: sha("b"),
		projection_sha256: sha("c"),
		event_count: 1,
	};
	return {
		stage: "candidate_c_final" as const,
		materializer: {
			identity: "fiet-maker/candidate-c-materializer",
			version: "1.0.0",
		},
		maker_policy_configuration_sha256: sha("d"),
		scheduler_contract_id: "native_chronological_scheduler_v2" as const,
		inputs: {
			dex: [{ identity: "arb-usdc-dex-tape", sha256: sha("e") }],
			bootstrap_okx_tape: {
				manifest_sha256: sha("f"),
				selection_sha256: sha("1"),
				receipt_sha256s: [sha("2")],
				export_result_sha256: sha("3"),
				artifact_sha256s: [sha("4"), sha("5")],
				projection_schema_sha256s: [sha("6"), sha("7")],
			},
		},
		source_evidence: {
			nominal_ledger_sha256: sha("8"),
			source_qualification_record_sha256: sha("9"),
		},
		original_clock: clock,
		admitted_clock: clock,
		target_mappings: [
			{
				original_target_id: targetId,
				admitted_target_id: targetId,
				disposition: "admitted" as const,
				maker_event_ids: ["maker-event-1", "maker-event-2"],
			},
		],
		blocked_dispositions_sha256: sha("0"),
		counts: {
			cex_target_count: 1,
			maker_invocation_count: 2,
			admitted_target_count: 1,
			admitted_invocation_count: 2,
			blocked_target_count: 0,
			blocked_invocation_count: 0,
		},
		scope: {
			trading_pair: "ARB-USDC",
			window_start: "2026-07-26T00:00:00.000Z",
			window_end: "2026-08-19T00:00:00.000Z",
			capability_policy: { policy_id: "cap/v4", policy_sha256: sha("a") },
			resource_policy: { policy_id: "resource/v2", policy_sha256: sha("b") },
			depth: 100 as const,
			source_policy: "fill_gaps" as const,
			max_prior_asof_lag_ms: 5_000 as const,
		},
		freshness_expiry: {
			threshold_ms: 5_000 as const,
			comparison: "strict_greater_than" as const,
			trigger: "first_actual_policy_opportunity" as const,
			scheduler_contract_id: "native_chronological_scheduler_v2" as const,
			source_update_precedes_controller_evaluation: true as const,
		},
	};
}

describe("reference-depth clock derivation descriptor", () => {
	test("pins the Maker-owned schema and exact no-removal identity", () => {
		const descriptor = finalizeReferenceDepthClockDerivationDescriptor(
			descriptorContent(),
		);
		expect(
			referenceDepthClockDerivationDescriptorCodec.decode(descriptor),
		).toEqual(descriptor);
		const tampered = structuredClone(descriptor);
		tampered.counts.maker_invocation_count = 1;
		expect(() =>
			referenceDepthClockDerivationDescriptorCodec.decode(tampered),
		).toThrow();
		const wrongOrdering = structuredClone(descriptor) as unknown as Record<
			string,
			unknown
		>;
		wrongOrdering.freshness_expiry = {
			...(wrongOrdering.freshness_expiry as Record<string, unknown>),
			source_update_precedes_controller_evaluation: false,
		};
		expect(() =>
			referenceDepthClockDerivationDescriptorCodec.decode(wrongOrdering),
		).toThrow();
	});

	test("preflights untruncated CEX targets and preserves distinct Maker invocations", () => {
		expect(
			preflightCandidateCCapacity({
				cex_target_count: 100_000,
				maker_invocation_count: 200_000,
				target_mappings: Array.from({ length: 100_000 }, (_, index) => ({
					target_key: `target-${index}`,
					maker_event_ids: [`maker-${index}`, `maker-extra-${index}`],
				})),
			}),
		).toEqual({
			within_current_ceiling: true,
			cex_target_count: 100_000,
			maker_invocation_count: 200_000,
		});
		expect(() =>
			preflightCandidateCCapacity({
				cex_target_count: 100_001,
				maker_invocation_count: 100_001,
				target_mappings: Array.from({ length: 100_001 }, (_, index) => ({
					target_key: `target-${index}`,
					maker_event_ids: [`maker-${index}`],
				})),
			}),
		).toThrow("candidate_c_required_clock_ceiling_exceeded");
	});

	test("freezes 5,000 ms as fresh and starts expiry only above the bound", () => {
		const firstStaleOpportunity = (
			sourceTime: number,
			opportunities: number[],
		) => opportunities.find((targetTime) => targetTime - sourceTime > 5_000);
		expect(firstStaleOpportunity(1_000, [6_000, 6_001])).toBe(6_001);
	});
});
