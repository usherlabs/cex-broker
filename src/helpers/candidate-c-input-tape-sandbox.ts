import {
	CANDIDATE_C_INPUT_TAPE_CAPABILITY,
	CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
	CANDIDATE_C_INPUT_TAPE_PROJECTION_PINS,
	CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET,
	type CandidateCInputTapeArchiveSinkResult,
} from "./candidate-c-input-tape";
import type { ArchiveQueryClient } from "./market-data-vendor-backfill/archive-reader";
import { buildForwarderBatches } from "./market-data-vendor-backfill/batching";
import type {
	ArchiveSelectionWire,
	ForwarderBatch,
	MarketDataVendorBackfillRequest,
	PromotionReceiptWire,
	ProviderObjectEvidence,
} from "./market-data-vendor-backfill/contracts";
import type { CandidateVerification } from "./market-data-vendor-backfill/core";
import { jcsSha256 } from "./market-data-vendor-backfill/identity";
import {
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	RESOURCE_POLICY,
} from "./market-data-vendor-backfill/manifests";
import {
	finalizePromotionReceipt,
	promotionReceiptMatchesCurrentPolicies,
	promotionReceiptToArchiveRow,
} from "./market-data-vendor-backfill/promotion";
import {
	finalizeQualificationEvent,
	qualificationEventToArchiveRow,
} from "./market-data-vendor-backfill/qualification";

function unsigned(value: unknown, reason: string): number {
	const number = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(number) || number < 0) throw new Error(reason);
	return number;
}

export async function verifyCandidateCInputTapeArchive(input: {
	request: MarketDataVendorBackfillRequest;
	sinkResult: CandidateCInputTapeArchiveSinkResult;
	client: ArchiveQueryClient;
}): Promise<CandidateVerification> {
	if (
		input.request.constructionMode !==
			CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE ||
		input.request.depth !== 100
	) {
		throw new Error("candidate_c_input_tape_verification_scope_invalid");
	}
	const parameters = {
		capture_bundle_id: input.sinkResult.capture_bundle_id,
		exchange: input.request.scope.exchange,
		trading_pair: input.request.scope.tradingPair,
		construction_mode: CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
	};
	const [countRows, conflictRows, qualifiedRows] = await Promise.all([
		input.client.query(
			`SELECT
			   (SELECT count() FROM market_data.cex_order_book_levels_canonical
			    WHERE capture_bundle_id = {capture_bundle_id:String}
			      AND exchange = {exchange:String}
			      AND trading_pair = {trading_pair:String}
			      AND construction_mode = {construction_mode:String}) AS level_rows,
			   (SELECT count() FROM market_data.cex_order_book_depth_summary_canonical
			    WHERE capture_bundle_id = {capture_bundle_id:String}
			      AND exchange = {exchange:String}
			      AND trading_pair = {trading_pair:String}
			      AND construction_mode = {construction_mode:String}) AS summary_rows,
			   (SELECT uniqExact(snapshot_id) FROM market_data.cex_order_book_depth_summary_canonical
			    WHERE capture_bundle_id = {capture_bundle_id:String}
			      AND exchange = {exchange:String}
			      AND trading_pair = {trading_pair:String}
			      AND construction_mode = {construction_mode:String}) AS state_count`,
			parameters,
		),
		input.client.query(
			`SELECT count() AS conflicts FROM
			 (
			   SELECT snapshot_id FROM market_data.cex_order_book_levels_conflicts
			   WHERE capture_bundle_id = {capture_bundle_id:String}
			   UNION ALL
			   SELECT snapshot_id FROM market_data.cex_order_book_depth_summary_conflicts
			   WHERE capture_bundle_id = {capture_bundle_id:String}
			 )`,
			parameters,
		),
		input.client.query(
			`SELECT
			   (SELECT count() FROM market_data.cex_order_book_levels_replay_qualified
			    WHERE capture_bundle_id = {capture_bundle_id:String}) +
			   (SELECT count() FROM market_data.cex_order_book_depth_summary_replay_qualified
			    WHERE capture_bundle_id = {capture_bundle_id:String}) AS qualified_rows`,
			parameters,
		),
	]);
	if (
		countRows.length !== 1 ||
		conflictRows.length !== 1 ||
		qualifiedRows.length !== 1
	) {
		throw new Error("candidate_c_input_tape_verification_result_invalid");
	}
	const countsMatch =
		unsigned(countRows[0]?.level_rows, "candidate_c_level_count_invalid") ===
			input.sinkResult.level_row_count &&
		unsigned(
			countRows[0]?.summary_rows,
			"candidate_c_summary_count_invalid",
		) === input.sinkResult.summary_row_count &&
		unsigned(countRows[0]?.state_count, "candidate_c_state_count_invalid") ===
			input.sinkResult.state_count;
	const conflictFree =
		unsigned(
			conflictRows[0]?.conflicts,
			"candidate_c_conflict_count_invalid",
		) === 0;
	const notAlreadyQualified =
		unsigned(
			qualifiedRows[0]?.qualified_rows,
			"candidate_c_qualified_count_invalid",
		) === 0;
	const passed =
		countsMatch &&
		conflictFree &&
		notAlreadyQualified &&
		input.sinkResult.provider_object_inventory_complete;
	const canonicalSemanticDigest = jcsSha256({
		algorithm: "candidate-c-input-tape-canonical-evidence/v1",
		capture_bundle_id: input.sinkResult.capture_bundle_id,
		state_count: input.sinkResult.state_count,
		level_row_count: input.sinkResult.level_row_count,
		summary_row_count: input.sinkResult.summary_row_count,
		forwarder_batch_identity_sha256:
			input.sinkResult.forwarder_batch_identity_sha256,
	});
	const emptyTimelineDigest = jcsSha256([]);
	return {
		passed,
		captureBundleId: input.sinkResult.capture_bundle_id,
		canonicalSemanticDigest,
		prefixDigest: emptyTimelineDigest,
		suffixDigest: emptyTimelineDigest,
		seamVerified: passed,
		coverageVerified: passed,
		...(passed ? {} : { reasonCode: "candidate_tape_verification_failed" }),
	};
}

type TapeExportArtifact = {
	file_name: string;
	rows: number;
	bytes: number;
	sha256: string;
	projection_schema_id: string;
	projection_schema_sha256: string;
};

type TapeExportResult = {
	promotionReceiptIds: string[];
	levels: TapeExportArtifact;
	summary: TapeExportArtifact;
};

async function submitSingleRow(
	forwarder: {
		submit(batch: ForwarderBatch): Promise<{ ok: boolean; inserted: number }>;
	},
	captureBundleId: string,
	row: ForwarderBatch["rows"][number],
): Promise<void> {
	const batches = buildForwarderBatches({
		captureBundleId,
		deploymentId: "candidate-c-okx-input-tape",
		rows: [row],
	});
	if (batches.length !== 1) {
		throw new Error("candidate_c_input_tape_evidence_batch_invalid");
	}
	const batch = batches[0] as ForwarderBatch;
	const response = await forwarder.submit(batch);
	if (!response.ok || response.inserted !== 1) {
		throw new Error("candidate_c_input_tape_evidence_rejected");
	}
}

export type CandidateCInputTapeSandboxManifest = {
	schema_id: "https://schemas.usher.so/candidate-c-input-tape-sandbox-manifest/v1";
	archive_target: typeof CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET;
	construction_mode: typeof CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE;
	normal_archive_path: true;
	tape_capability: { policy_id: string; policy_sha256: string };
	state_count: number;
	promotion: {
		receipt_id: string;
		promotion_identity_sha256: string;
		qualification_event_id: string;
	};
	selection: { selection_sha256: string; receipt_ids: string[] };
	export: { levels: TapeExportArtifact; summary: TapeExportArtifact };
	projection_schema_pins: readonly {
		schema_id: string;
		schema_sha256: string;
	}[];
};

export async function promoteAndExportCandidateCInputTapeSandbox(input: {
	request: MarketDataVendorBackfillRequest;
	sinkResult: CandidateCInputTapeArchiveSinkResult;
	verification: CandidateVerification;
	datasetObjects: ProviderObjectEvidence[];
	vendorSemanticDigest: string;
	verifiedAt: string;
	forwarder: {
		submit(batch: ForwarderBatch): Promise<{ ok: boolean; inserted: number }>;
	};
	archive: {
		resolveSelection(
			request: MarketDataVendorBackfillRequest,
		): Promise<ArchiveSelectionWire>;
	};
	exporter: {
		export(request: {
			schema_id: "https://schemas.usher.so/cex-canonical-orderbook-export-request/v1";
			request_id: string;
			target: { environment: string; cluster: string };
			selection: ArchiveSelectionWire;
			depth: 100;
			construction_mode: typeof CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE;
			canonical_schema_version: string;
			checksum_algorithm: "sha256-canonical-json-v1";
		}): Promise<TapeExportResult>;
	};
}): Promise<CandidateCInputTapeSandboxManifest> {
	const request = input.request;
	if (
		request.target?.environment !==
			CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET.environment ||
		request.target.cluster !== CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET.cluster ||
		request.constructionMode !== CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE ||
		request.depth !== 100 ||
		!request.initialSelection ||
		!request.coveragePolicy ||
		!request.expectedCanonicalSchema ||
		!input.verification.passed ||
		input.verification.captureBundleId !== input.sinkResult.capture_bundle_id ||
		!input.verification.seamVerified ||
		!input.verification.coverageVerified
	) {
		throw new Error("candidate_c_input_tape_promotion_precondition_failed");
	}
	const receipt = finalizePromotionReceipt({
		schema_id:
			"https://schemas.usher.so/market-data-vendor-backfill-promotion-receipt/v1",
		verified_at: input.verifiedAt as PromotionReceiptWire["verified_at"],
		request_id: request.requestId as PromotionReceiptWire["request_id"],
		idempotency_key:
			request.idempotencyKey as PromotionReceiptWire["idempotency_key"],
		source: "external_backfill",
		capture_origin: "vendor_historical_backfill",
		source_mode: "vendor_historical_backfill_v1",
		provider: "cryptohftdata",
		adapter_version: CANDIDATE_C_INPUT_TAPE_CAPABILITY.adapter_version,
		effective_policies: {
			capability_policy: {
				policy_id: CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_id,
				policy_sha256: CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_sha256,
			},
			resource_policy: {
				policy_id: RESOURCE_POLICY.policy_id,
				policy_sha256: RESOURCE_POLICY.policy_sha256,
			},
			adapter_policy: EFFECTIVE_ADAPTER_POLICY_PIN,
			acquisition_policy: EFFECTIVE_ACQUISITION_POLICY_PIN,
		},
		capture_bundle_id: input.sinkResult.capture_bundle_id,
		scope: {
			exchange: request.scope.exchange,
			trading_pair: request.scope.tradingPair,
			market_type: request.scope.marketType,
			feed: request.scope.feed,
		},
		window: {
			start_at: new Date(
				request.window.startTimeMs,
			).toISOString() as PromotionReceiptWire["window"]["start_at"],
			end_at: new Date(
				request.window.endTimeMs,
			).toISOString() as PromotionReceiptWire["window"]["end_at"],
		},
		depth: 100,
		construction_mode: CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
		canonical_schema: request.expectedCanonicalSchema,
		coverage_policy: request.coveragePolicy,
		selection_sha256: request.initialSelection.selection_sha256,
		vendor_semantic_digest:
			input.vendorSemanticDigest as PromotionReceiptWire["vendor_semantic_digest"],
		canonical_semantic_digest: input.verification
			.canonicalSemanticDigest as PromotionReceiptWire["canonical_semantic_digest"],
		prefix_digest: input.verification
			.prefixDigest as PromotionReceiptWire["prefix_digest"],
		suffix_digest: input.verification
			.suffixDigest as PromotionReceiptWire["suffix_digest"],
		seam_verified: true,
		coverage_verified: true,
		dataset_objects: input.datasetObjects,
	});
	if (!promotionReceiptMatchesCurrentPolicies(receipt)) {
		throw new Error("candidate_c_input_tape_receipt_policy_mismatch");
	}
	await submitSingleRow(
		input.forwarder,
		input.sinkResult.capture_bundle_id,
		promotionReceiptToArchiveRow(receipt),
	);
	const qualification = finalizeQualificationEvent({
		capture_bundle_id: receipt.capture_bundle_id,
		state: "qualified",
		receipt_id: receipt.receipt_id,
		promotion_identity_sha256: receipt.promotion_identity_sha256,
		window: receipt.window,
		event_at: receipt.verified_at,
		reason_code: "candidate_c_input_tape_verified",
	});
	await submitSingleRow(
		input.forwarder,
		input.sinkResult.capture_bundle_id,
		qualificationEventToArchiveRow(qualification),
	);
	const selection = await input.archive.resolveSelection(request);
	if (
		selection.coverage_class !== "complete" ||
		!selection.receipt_ids.includes(receipt.receipt_id) ||
		!selection.qualification_event_ids.includes(
			qualification.qualification_event_id,
		) ||
		!selection.bundles.some(
			(bundle) =>
				bundle.capture_bundle_id === receipt.capture_bundle_id &&
				bundle.qualification?.receipt_id === receipt.receipt_id &&
				bundle.qualification.promotion_identity_sha256 ===
					receipt.promotion_identity_sha256,
		)
	) {
		throw new Error("candidate_c_input_tape_selection_invalid");
	}
	const exported = await input.exporter.export({
		schema_id:
			"https://schemas.usher.so/cex-canonical-orderbook-export-request/v1",
		request_id: request.requestId,
		target: CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET,
		selection,
		depth: 100,
		construction_mode: CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
		canonical_schema_version: request.expectedProduct.canonicalSchemaVersion,
		checksum_algorithm: "sha256-canonical-json-v1",
	});
	if (
		exported.promotionReceiptIds.length !== 1 ||
		exported.promotionReceiptIds[0] !== receipt.receipt_id ||
		exported.levels.rows !== input.sinkResult.level_row_count ||
		exported.summary.rows !== input.sinkResult.summary_row_count ||
		!CANDIDATE_C_INPUT_TAPE_PROJECTION_PINS.some(
			(pin) =>
				pin.schema_id === exported.levels.projection_schema_id &&
				pin.schema_sha256 === exported.levels.projection_schema_sha256,
		) ||
		!CANDIDATE_C_INPUT_TAPE_PROJECTION_PINS.some(
			(pin) =>
				pin.schema_id === exported.summary.projection_schema_id &&
				pin.schema_sha256 === exported.summary.projection_schema_sha256,
		)
	) {
		throw new Error("candidate_c_input_tape_export_invalid");
	}
	return {
		schema_id:
			"https://schemas.usher.so/candidate-c-input-tape-sandbox-manifest/v1",
		archive_target: CANDIDATE_C_INPUT_TAPE_SANDBOX_TARGET,
		construction_mode: CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
		normal_archive_path: true,
		tape_capability: {
			policy_id: CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_id,
			policy_sha256: CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_sha256,
		},
		state_count: input.sinkResult.state_count,
		promotion: {
			receipt_id: receipt.receipt_id,
			promotion_identity_sha256: receipt.promotion_identity_sha256,
			qualification_event_id: qualification.qualification_event_id,
		},
		selection: {
			selection_sha256: selection.selection_sha256,
			receipt_ids: selection.receipt_ids,
		},
		export: { levels: exported.levels, summary: exported.summary },
		projection_schema_pins: CANDIDATE_C_INPUT_TAPE_PROJECTION_PINS,
	};
}
