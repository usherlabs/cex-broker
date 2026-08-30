import { buildCanonicalOrderBookRows } from "./market-data-archive/canonical-orderbook";
import {
	CHECKSUM_ALGORITHM,
	MARKET_CAPTURE_SCHEMA_VERSION,
	sha256Canonical,
} from "./market-data-archive/capture-contract";
import candidateCInputTapeCapability from "./market-data-preparation/policies/candidate-c-input-tape-capability-v1.json" with {
	type: "json",
};
import depthSummaryProjection from "./market-data-preparation/schemas/order-book-depth-summary-parquet-projection.schema.json" with {
	type: "json",
};
import levelsProjection from "./market-data-preparation/schemas/order-book-levels-parquet-projection.schema.json" with {
	type: "json",
};
import {
	BACKFILL_MAX_BATCH_BYTES,
	BACKFILL_MAX_BATCH_ROWS,
	buildForwarderBatches,
} from "./market-data-vendor-backfill/batching";
import type {
	BackfillArchiveRow,
	ForwarderBatch,
	ProviderObjectEvidence,
} from "./market-data-vendor-backfill/contracts";
import {
	CANDIDATE_C_TAPE_MAX_BATCH_BYTES,
	CANDIDATE_C_TAPE_MAX_IN_FLIGHT,
	CANDIDATE_C_TAPE_MAX_STATES_PER_YIELD,
	type PolicyNeutralCryptoHftBookState,
	type PolicyNeutralTapeSink,
} from "./market-data-vendor-backfill/cryptohftdata";
import {
	assertDocumentSha256,
	jcsSha256,
} from "./market-data-vendor-backfill/identity";

assertDocumentSha256(candidateCInputTapeCapability, "policy_sha256");

export const CANDIDATE_C_INPUT_TAPE_CAPABILITY = Object.freeze(
	candidateCInputTapeCapability,
);
export const CANDIDATE_C_INPUT_TAPE_CAPABILITY_ID =
	CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_id;
export const CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE =
	"policy_neutral_top_n_state_change_tape/v1" as const;
export const CANDIDATE_C_INPUT_TAPE_DEPTH = 100 as const;
export const CANDIDATE_C_INPUT_TAPE_MAX_STATES_PER_YIELD =
	CANDIDATE_C_TAPE_MAX_STATES_PER_YIELD;
export const CANDIDATE_C_INPUT_TAPE_MAX_BATCH_ROWS = BACKFILL_MAX_BATCH_ROWS;
export const CANDIDATE_C_INPUT_TAPE_MAX_BATCH_BYTES = BACKFILL_MAX_BATCH_BYTES;
export const CANDIDATE_C_INPUT_TAPE_MAX_IN_FLIGHT =
	CANDIDATE_C_TAPE_MAX_IN_FLIGHT;
if (CANDIDATE_C_TAPE_MAX_BATCH_BYTES !== BACKFILL_MAX_BATCH_BYTES) {
	throw new Error("Candidate C tape and forwarder byte bounds differ");
}
export const CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET = Object.freeze({
	environment: "sandbox",
	cluster: "cex-archive-local",
});
export const CANDIDATE_C_INPUT_TAPE_PROJECTION_PINS = Object.freeze([
	Object.freeze({
		schema_id: levelsProjection.$id,
		schema_sha256: jcsSha256(levelsProjection),
	}),
	Object.freeze({
		schema_id: depthSummaryProjection.$id,
		schema_sha256: jcsSha256(depthSummaryProjection),
	}),
]);

export type CandidateCProviderObjectInventory = {
	expected_identities: string[];
	observed_identities: string[];
	complete: boolean;
};

export function candidateCInputTapeCaptureBundleId(input: {
	idempotencyKey: string;
	tradingPair: "ARB-USDC" | "ARB-USDT";
	window: { startTimeMs: number; endTimeMs: number };
	expectedObjectIdentities: readonly string[];
}): string {
	if (!/^[a-f0-9]{64}$/u.test(input.idempotencyKey)) {
		throw new Error("candidate_c_input_tape_idempotency_key_invalid");
	}
	const identities = [...input.expectedObjectIdentities];
	if (
		identities.length === 0 ||
		new Set(identities).size !== identities.length ||
		JSON.stringify(identities) !== JSON.stringify([...identities].sort())
	) {
		throw new Error("candidate_c_input_tape_expected_inventory_invalid");
	}
	return sha256Canonical({
		identity: "candidate-c-input-tape-capture-bundle/v1",
		capability_policy_sha256: CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_sha256,
		idempotency_key: input.idempotencyKey,
		trading_pair: input.tradingPair,
		window: input.window,
		expected_object_identities: identities,
		construction_mode: CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
		depth: CANDIDATE_C_INPUT_TAPE_DEPTH,
	});
}

/**
 * `production` is the stable forwarder mutation-authorization class. It is not
 * an environment assertion: Candidate C qualification remains sandbox-local.
 */
export function assertCandidateCInputTapeSandboxAuthorization(input: {
	requestAuthorizationId: string;
	requestTarget: { environment: string; cluster: string };
	preflight: {
		authorizationId: string;
		scope: "production";
		environment: string;
		cluster: string;
		credentialValidated: boolean;
	};
}): void {
	if (
		input.requestTarget.environment !==
			CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET.environment ||
		input.requestTarget.cluster !==
			CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET.cluster
	) {
		throw new Error("candidate_c_input_tape_sandbox_target_mismatch");
	}
	if (
		input.preflight.authorizationId !== input.requestAuthorizationId ||
		input.preflight.scope !== "production" ||
		input.preflight.environment !== input.requestTarget.environment ||
		input.preflight.cluster !== input.requestTarget.cluster ||
		input.preflight.credentialValidated !== true
	) {
		throw new Error("candidate_c_input_tape_authorization_mismatch");
	}
}

export type CandidateCInputTapeArchiveSinkResult = {
	capture_bundle_id: string;
	state_count: number;
	level_row_count: number;
	summary_row_count: number;
	forwarder_batch_count: number;
	forwarder_batch_identity_sha256: string;
	provider_object_inventory_complete: true;
	max_states_per_yield: typeof CANDIDATE_C_INPUT_TAPE_MAX_STATES_PER_YIELD;
	max_batch_rows: typeof CANDIDATE_C_INPUT_TAPE_MAX_BATCH_ROWS;
	max_batch_bytes: typeof CANDIDATE_C_INPUT_TAPE_MAX_BATCH_BYTES;
	max_in_flight_submissions: typeof CANDIDATE_C_INPUT_TAPE_MAX_IN_FLIGHT;
};

export type CandidateCInputTapeArchiveSink = PolicyNeutralTapeSink & {
	result(): CandidateCInputTapeArchiveSinkResult;
};

/**
 * Streams canonical tape rows to the existing archive-forwarder candidate
 * tables. Promotion, selection and exporter-v2 finalization remain later
 * gates; this sink never creates a receipt or a success manifest by itself.
 */
export function createCandidateCInputTapeArchiveSink(input: {
	captureBundleId: string;
	tradingPair: "ARB-USDC" | "ARB-USDT";
	window: { startTimeMs: number; endTimeMs: number };
	forwarder: {
		submit(batch: ForwarderBatch): Promise<{ ok: boolean; inserted: number }>;
	};
}): CandidateCInputTapeArchiveSink {
	if (!/^[a-f0-9]{64}$/u.test(input.captureBundleId)) {
		throw new Error("candidate_c_input_tape_capture_bundle_invalid");
	}
	if (
		!Number.isSafeInteger(input.window.startTimeMs) ||
		!Number.isSafeInteger(input.window.endTimeMs) ||
		input.window.endTimeMs <= input.window.startTimeMs
	) {
		throw new Error("candidate_c_input_tape_window_invalid");
	}
	let stateCount = 0;
	let initializationCount = 0;
	let levelRowCount = 0;
	let summaryRowCount = 0;
	let lastSourceTimeMs = Number.NEGATIVE_INFINITY;
	let completed = false;
	let aborted = false;
	const batchIds: string[] = [];
	let resultValue: CandidateCInputTapeArchiveSinkResult | undefined;

	return {
		async writeBatch(states) {
			if (completed || aborted) {
				throw new Error("candidate_c_input_tape_sink_closed");
			}
			if (
				states.length === 0 ||
				states.length > CANDIDATE_C_INPUT_TAPE_MAX_STATES_PER_YIELD
			) {
				throw new Error("candidate_c_input_tape_state_batch_invalid");
			}
			for (const state of states) {
				if (state.sourceTimeMs < lastSourceTimeMs) {
					throw new Error("candidate_c_input_tape_state_order_invalid");
				}
				if (state.sourceTimeMs >= input.window.endTimeMs) {
					throw new Error("candidate_c_input_tape_end_boundary_invalid");
				}
				if (state.tapeState === "initialization") {
					initializationCount += 1;
					if (stateCount !== 0 || initializationCount !== 1) {
						throw new Error("candidate_c_input_tape_initialization_invalid");
					}
				} else if (
					initializationCount !== 1 ||
					state.sourceTimeMs < input.window.startTimeMs
				) {
					throw new Error("candidate_c_input_tape_change_boundary_invalid");
				}
				lastSourceTimeMs = state.sourceTimeMs;
				stateCount += 1;
			}
			const rows = normalizeCandidateCInputTapeStates({
				tape: states,
				capture_bundle_id: input.captureBundleId,
				trading_pair: input.tradingPair,
			});
			for (const row of rows) {
				if (row.table === "market_data.cex_order_book_levels") {
					levelRowCount += 1;
				} else if (row.table === "market_data.cex_order_book_depth_summary") {
					summaryRowCount += 1;
				}
			}
			const batches = buildForwarderBatches({
				captureBundleId: input.captureBundleId,
				deploymentId: "candidate-c-okx-input-tape",
				rows,
				maxRows: CANDIDATE_C_INPUT_TAPE_MAX_BATCH_ROWS,
				maxBytes: CANDIDATE_C_INPUT_TAPE_MAX_BATCH_BYTES,
			});
			for (const batch of batches) {
				const response = await input.forwarder.submit(batch);
				if (!response.ok || response.inserted !== batch.rows.length) {
					throw new Error("candidate_c_input_tape_forwarder_rejected");
				}
				batchIds.push(batch.batch_id);
			}
		},
		async complete(completion) {
			if (completed || aborted || initializationCount !== 1) {
				throw new Error("candidate_c_input_tape_completion_invalid");
			}
			if (completion.stateCount !== stateCount) {
				throw new Error("candidate_c_input_tape_state_count_mismatch");
			}
			const inventory = {
				expected_identities: [...completion.expectedObjectIdentities],
				observed_identities: completion.observedObjects.map(
					({ identity }: ProviderObjectEvidence) => identity,
				),
				complete: true,
			};
			if (!providerObjectInventoryIsComplete(inventory)) {
				throw new Error("candidate_c_input_tape_inventory_incomplete");
			}
			completed = true;
			resultValue = {
				capture_bundle_id: input.captureBundleId,
				state_count: stateCount,
				level_row_count: levelRowCount,
				summary_row_count: summaryRowCount,
				forwarder_batch_count: batchIds.length,
				forwarder_batch_identity_sha256: sha256Canonical(batchIds),
				provider_object_inventory_complete: true,
				max_states_per_yield: CANDIDATE_C_INPUT_TAPE_MAX_STATES_PER_YIELD,
				max_batch_rows: CANDIDATE_C_INPUT_TAPE_MAX_BATCH_ROWS,
				max_batch_bytes: CANDIDATE_C_INPUT_TAPE_MAX_BATCH_BYTES,
				max_in_flight_submissions: CANDIDATE_C_INPUT_TAPE_MAX_IN_FLIGHT,
			};
		},
		async abort() {
			aborted = true;
			resultValue = undefined;
		},
		result() {
			if (!completed || !resultValue || aborted) {
				throw new Error("candidate_c_input_tape_result_unavailable");
			}
			return resultValue;
		},
	};
}

export function providerObjectInventoryIsComplete(
	inventory: CandidateCProviderObjectInventory,
): boolean {
	const expected = [...inventory.expected_identities].sort();
	const observed = [...inventory.observed_identities].sort();
	return (
		inventory.complete &&
		new Set(expected).size === expected.length &&
		new Set(observed).size === observed.length &&
		JSON.stringify(expected) === JSON.stringify(observed)
	);
}

export function evaluateCandidateCInputTapeEligibility(input: {
	bootstrap_qualified: boolean;
	source_enumeration_eligible: boolean;
	provider_object_inventory: CandidateCProviderObjectInventory;
	tape_complete: boolean;
	capability_id: string;
	capability_sha256: string;
	construction_mode: string;
	projection_schema_pins: readonly {
		schema_id: string;
		schema_sha256: string;
	}[];
	artifact_sha256s: readonly string[];
	tape_manifest_sha256: string;
}): boolean {
	const expectedProjectionPins = [...CANDIDATE_C_INPUT_TAPE_PROJECTION_PINS]
		.map(({ schema_id, schema_sha256 }) => `${schema_id}:${schema_sha256}`)
		.sort();
	const actualProjectionPins = input.projection_schema_pins
		.map(({ schema_id, schema_sha256 }) => `${schema_id}:${schema_sha256}`)
		.sort();
	return (
		input.bootstrap_qualified &&
		input.source_enumeration_eligible &&
		providerObjectInventoryIsComplete(input.provider_object_inventory) &&
		input.tape_complete &&
		input.capability_id === CANDIDATE_C_INPUT_TAPE_CAPABILITY_ID &&
		input.capability_sha256 ===
			CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_sha256 &&
		input.construction_mode === CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE &&
		JSON.stringify(actualProjectionPins) ===
			JSON.stringify(expectedProjectionPins) &&
		input.artifact_sha256s.length === 2 &&
		new Set(input.artifact_sha256s).size === 2 &&
		input.artifact_sha256s.every((sha) => /^[a-f0-9]{64}$/u.test(sha)) &&
		/^[a-f0-9]{64}$/u.test(input.tape_manifest_sha256)
	);
}

export function normalizeCandidateCInputTapeStates(input: {
	tape: readonly PolicyNeutralCryptoHftBookState[];
	capture_bundle_id: string;
	trading_pair: "ARB-USDC" | "ARB-USDT";
}): BackfillArchiveRow[] {
	if (!/^[a-f0-9]{64}$/u.test(input.capture_bundle_id)) {
		throw new Error(
			"Candidate C input-tape capture bundle identity is invalid",
		);
	}
	return input.tape.flatMap((state) => {
		const rawCaptureId = sha256Canonical({
			capability_policy_sha256: CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_sha256,
			capture_bundle_id: input.capture_bundle_id,
			dataset_object_identity: state.datasetObjectIdentity,
			dataset_object_checksum: state.datasetObjectChecksum,
			source_time_ms: state.sourceTimeMs,
			sequence: state.sequence,
			tape_state: state.tapeState,
		});
		const canonical = buildCanonicalOrderBookRows({
			context: {
				source: "external_backfill",
				deploymentId: "candidate-c-okx-input-tape",
				captureBundleId: input.capture_bundle_id,
				exchange: "okx",
				symbol: input.trading_pair,
				tradingPair: input.trading_pair,
				sourceSymbol: input.trading_pair,
				assetType: "spot",
				feed: "ORDERBOOK",
				provider: "cryptohftdata",
				sourceMode: "vendor_historical_backfill_v1",
				schemaVersion: MARKET_CAPTURE_SCHEMA_VERSION,
				checksumAlgorithm: CHECKSUM_ALGORITHM,
				provenanceComplete: true,
			},
			rawCapture: {
				rawCaptureId,
				rawCaptureScope: "vendor_normalized_dataset_file",
				rawChecksum: state.datasetObjectChecksum,
				redactedPayload: {
					dataset_object_identity: state.datasetObjectIdentity,
					dataset_object_checksum: state.datasetObjectChecksum,
				},
				eventTimeMs: state.sourceTimeMs,
				receivedTimeMs: state.receivedTimeMs,
				checksumAlgorithm: CHECKSUM_ALGORITHM,
			},
			depthLimit: CANDIDATE_C_INPUT_TAPE_DEPTH,
			constructionMode: CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
			snapshot: {
				bids: state.bids,
				asks: state.asks,
				timestamp: state.sourceTimeMs,
				receivedTimestamp: state.receivedTimeMs,
				exchange: "okx",
				symbol: input.trading_pair,
				depthLimit: CANDIDATE_C_INPUT_TAPE_DEPTH,
				sequence: state.sequence,
			},
		});
		return [...canonical.levels, canonical.summary].map((entry) => {
			if (
				entry.table !== "market_data.cex_order_book_levels" &&
				entry.table !== "market_data.cex_order_book_depth_summary"
			) {
				throw new Error("Candidate C input-tape archive table is invalid");
			}
			return { table: entry.table, row: entry.row };
		});
	});
}
