import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import type {
	LowercaseUuid,
	Sha256Hex,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	assertDocumentSha256,
	documentSha256,
	jcsSha256,
} from "../src/helpers/market-data-vendor-backfill/identity";
import descriptorSchema from "./qualification-schemas/reference-depth-clock-derivation-descriptor-v1.schema.json" with {
	type: "json",
};

export const REFERENCE_DEPTH_CLOCK_DERIVATION_DESCRIPTOR_SCHEMA_ID =
	descriptorSchema.$id;
export const REFERENCE_DEPTH_CLOCK_DERIVATION_DESCRIPTOR_SCHEMA_SHA256 =
	jcsSha256(descriptorSchema);
export const CANDIDATE_C_REQUIRED_CLOCK_MAX_TARGETS = 100_000;

type Artifact = { identity: string; sha256: Sha256Hex };
type ClockBinding = {
	clock_id: LowercaseUuid;
	clock_sha256: Sha256Hex;
	clock_bytes_sha256: Sha256Hex;
	projection_sha256: Sha256Hex;
	event_count: number;
};
type TargetMapping = {
	original_target_id: LowercaseUuid;
	admitted_target_id: LowercaseUuid | null;
	disposition: "admitted" | "reference_depth_stale";
	maker_event_ids: string[];
};
type DescriptorContent = {
	stage: "candidate_a_bootstrap" | "candidate_c_final";
	materializer: { identity: string; version: string };
	maker_policy_configuration_sha256: Sha256Hex;
	scheduler_contract_id: "native_chronological_scheduler_v2";
	inputs: {
		dex: Artifact[];
		bootstrap_okx_tape: null | {
			manifest_sha256: Sha256Hex;
			selection_sha256: Sha256Hex;
			receipt_sha256s: Sha256Hex[];
			export_result_sha256: Sha256Hex;
			artifact_sha256s: Sha256Hex[];
			projection_schema_sha256s: Sha256Hex[];
		};
	};
	source_evidence: {
		nominal_ledger_sha256: Sha256Hex;
		source_qualification_record_sha256: Sha256Hex;
	};
	original_clock: ClockBinding;
	admitted_clock: ClockBinding;
	target_mappings: TargetMapping[];
	blocked_dispositions_sha256: Sha256Hex;
	counts: {
		cex_target_count: number;
		maker_invocation_count: number;
		admitted_target_count: number;
		admitted_invocation_count: number;
		blocked_target_count: number;
		blocked_invocation_count: number;
	};
	scope: {
		trading_pair: "ARB-USDC" | "ARB-USDT";
		window_start: string;
		window_end: string;
		capability_policy: { policy_id: string; policy_sha256: Sha256Hex };
		resource_policy: { policy_id: string; policy_sha256: Sha256Hex };
		depth: 100;
		source_policy: "fill_gaps";
		max_prior_asof_lag_ms: 5000;
	};
	freshness_expiry: {
		threshold_ms: 5000;
		comparison: "strict_greater_than";
		trigger: "first_actual_policy_opportunity";
		scheduler_contract_id: "native_chronological_scheduler_v2";
		source_update_precedes_controller_evaluation: true;
	};
};

export type ReferenceDepthClockDerivationDescriptorWire = DescriptorContent & {
	schema_id: typeof REFERENCE_DEPTH_CLOCK_DERIVATION_DESCRIPTOR_SCHEMA_ID;
	schema_sha256: Sha256Hex;
	descriptor_sha256: Sha256Hex;
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(descriptorSchema);

function describeAjvErrors(errors: ErrorObject[] | null | undefined): string {
	return (errors ?? [])
		.map((error) => `${error.instancePath || "/"} ${error.message}`)
		.join("; ");
}

function assertDescriptorSemantics(
	descriptor: ReferenceDepthClockDerivationDescriptorWire,
): void {
	if (
		descriptor.schema_sha256 !==
		REFERENCE_DEPTH_CLOCK_DERIVATION_DESCRIPTOR_SCHEMA_SHA256
	) {
		throw new Error("reference-depth derivation schema hash is not pinned");
	}
	if (
		Date.parse(descriptor.scope.window_start) >=
		Date.parse(descriptor.scope.window_end)
	) {
		throw new Error("reference-depth derivation window is invalid");
	}
	if (
		descriptor.stage === "candidate_c_final" &&
		(descriptor.inputs.dex.length === 0 ||
			descriptor.inputs.bootstrap_okx_tape === null)
	) {
		throw new Error("Candidate C derivation inputs are incomplete");
	}
	if (
		descriptor.target_mappings.length !== descriptor.original_clock.event_count
	) {
		throw new Error("original clock mapping is incomplete");
	}
	const originalIds = new Set<string>();
	const admittedIds = new Set<string>();
	const makerEventIds = new Set<string>();
	let admittedTargets = 0;
	let blockedTargets = 0;
	let admittedInvocations = 0;
	let blockedInvocations = 0;
	for (const mapping of descriptor.target_mappings) {
		if (originalIds.has(mapping.original_target_id)) {
			throw new Error("original target mapping is duplicated");
		}
		originalIds.add(mapping.original_target_id);
		for (const makerEventId of mapping.maker_event_ids) {
			if (makerEventIds.has(makerEventId)) {
				throw new Error("Maker policy invocation is duplicated");
			}
			makerEventIds.add(makerEventId);
		}
		if (mapping.disposition === "admitted") {
			if (mapping.admitted_target_id === null) {
				throw new Error("admitted mapping lacks a target identity");
			}
			if (admittedIds.has(mapping.admitted_target_id)) {
				throw new Error("admitted target mapping is duplicated");
			}
			admittedIds.add(mapping.admitted_target_id);
			admittedTargets += 1;
			admittedInvocations += mapping.maker_event_ids.length;
		} else {
			if (mapping.admitted_target_id !== null) {
				throw new Error("blocked mapping cannot carry an admitted target");
			}
			blockedTargets += 1;
			blockedInvocations += mapping.maker_event_ids.length;
		}
	}
	const exactCounts = {
		cex_target_count: descriptor.target_mappings.length,
		maker_invocation_count: makerEventIds.size,
		admitted_target_count: admittedTargets,
		admitted_invocation_count: admittedInvocations,
		blocked_target_count: blockedTargets,
		blocked_invocation_count: blockedInvocations,
	};
	if (JSON.stringify(exactCounts) !== JSON.stringify(descriptor.counts)) {
		throw new Error("reference-depth derivation counts are inconsistent");
	}
	if (descriptor.admitted_clock.event_count !== admittedTargets) {
		throw new Error("admitted clock count does not match mappings");
	}
	const removed = blockedTargets > 0;
	if (!removed) {
		if (
			JSON.stringify(descriptor.original_clock) !==
				JSON.stringify(descriptor.admitted_clock) ||
			descriptor.target_mappings.some(
				(mapping) => mapping.admitted_target_id !== mapping.original_target_id,
			)
		) {
			throw new Error(
				"unchanged admitted clock must reuse exact original bytes",
			);
		}
	} else if (
		descriptor.original_clock.clock_id === descriptor.admitted_clock.clock_id ||
		descriptor.original_clock.clock_sha256 ===
			descriptor.admitted_clock.clock_sha256 ||
		descriptor.original_clock.clock_bytes_sha256 ===
			descriptor.admitted_clock.clock_bytes_sha256 ||
		descriptor.original_clock.projection_sha256 ===
			descriptor.admitted_clock.projection_sha256
	) {
		throw new Error("filtered admitted clock must receive new identities");
	}
	preflightCandidateCCapacity({
		cex_target_count: descriptor.counts.cex_target_count,
		maker_invocation_count: descriptor.counts.maker_invocation_count,
		target_mappings: descriptor.target_mappings.map((mapping) => ({
			target_key: mapping.original_target_id,
			maker_event_ids: mapping.maker_event_ids,
		})),
	});
}

export const referenceDepthClockDerivationDescriptorCodec = {
	decode(value: unknown): ReferenceDepthClockDerivationDescriptorWire {
		if (!validate(value)) {
			throw new Error(
				`reference-depth derivation descriptor validation failed: ${describeAjvErrors(validate.errors)}`,
			);
		}
		const descriptor = value as ReferenceDepthClockDerivationDescriptorWire;
		assertDocumentSha256(descriptor, "descriptor_sha256");
		assertDescriptorSemantics(descriptor);
		return descriptor;
	},
};

export function finalizeReferenceDepthClockDerivationDescriptor(
	content: DescriptorContent,
): ReferenceDepthClockDerivationDescriptorWire {
	const withSchema = {
		...content,
		schema_id: REFERENCE_DEPTH_CLOCK_DERIVATION_DESCRIPTOR_SCHEMA_ID,
		schema_sha256: REFERENCE_DEPTH_CLOCK_DERIVATION_DESCRIPTOR_SCHEMA_SHA256,
	};
	return referenceDepthClockDerivationDescriptorCodec.decode({
		...withSchema,
		descriptor_sha256: documentSha256(withSchema, "descriptor_sha256"),
	});
}

export function preflightCandidateCCapacity(input: {
	cex_target_count: number;
	maker_invocation_count: number;
	target_mappings: readonly {
		target_key: string;
		maker_event_ids: readonly string[];
	}[];
}): {
	within_current_ceiling: true;
	cex_target_count: number;
	maker_invocation_count: number;
} {
	if (
		!Number.isSafeInteger(input.cex_target_count) ||
		!Number.isSafeInteger(input.maker_invocation_count) ||
		input.cex_target_count < 0 ||
		input.maker_invocation_count < 0 ||
		input.target_mappings.length !== input.cex_target_count
	) {
		throw new Error("candidate_c_capacity_projection_inconsistent");
	}
	const targetKeys = new Set<string>();
	const makerEventIds = new Set<string>();
	let invocationCount = 0;
	for (const mapping of input.target_mappings) {
		if (!mapping.target_key || targetKeys.has(mapping.target_key)) {
			throw new Error("candidate_c_target_projection_invalid");
		}
		targetKeys.add(mapping.target_key);
		if (mapping.maker_event_ids.length === 0) {
			throw new Error("candidate_c_target_has_no_policy_invocation");
		}
		for (const makerEventId of mapping.maker_event_ids) {
			if (!makerEventId || makerEventIds.has(makerEventId)) {
				throw new Error("candidate_c_policy_invocation_projection_invalid");
			}
			makerEventIds.add(makerEventId);
			invocationCount += 1;
		}
	}
	if (invocationCount !== input.maker_invocation_count) {
		throw new Error("candidate_c_capacity_projection_inconsistent");
	}
	if (input.cex_target_count > CANDIDATE_C_REQUIRED_CLOCK_MAX_TARGETS) {
		throw new Error("candidate_c_required_clock_ceiling_exceeded");
	}
	return {
		within_current_ceiling: true,
		cex_target_count: input.cex_target_count,
		maker_invocation_count: invocationCount,
	};
}
