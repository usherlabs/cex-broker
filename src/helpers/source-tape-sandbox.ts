import type { ArchiveQueryClient } from "./market-data-vendor-backfill/archive-reader";
import { buildForwarderBatches } from "./market-data-vendor-backfill/batching";
import {
	type ArchiveSelectionWire,
	EXTERNAL_BACKFILL_DEPLOYMENT_ID,
	type ForwarderBatch,
	type MarketDataVendorBackfillRequest,
	type PromotionReceiptWire,
	type ProviderObjectEvidence,
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
import {
	SOURCE_TAPE_CAPABILITY,
	SOURCE_TAPE_CONSTRUCTION_MODE,
	SOURCE_TAPE_PROJECTION_PINS,
	SOURCE_TAPE_SANDBOX_TARGET,
	type SourceTapeArchiveSinkResult,
	SourceTapeSemanticDigestAccumulator,
	sourceTapeSemanticStateDescriptor,
} from "./source-tape";

function unsigned(value: unknown, reason: string): number {
	const number = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(number) || number < 0) throw new Error(reason);
	return number;
}

export async function verifySourceTapeArchive(input: {
	request: MarketDataVendorBackfillRequest;
	sinkResult: SourceTapeArchiveSinkResult;
	client: ArchiveQueryClient;
}): Promise<CandidateVerification> {
	if (
		input.request.constructionMode !== SOURCE_TAPE_CONSTRUCTION_MODE ||
		input.request.depth !== 100
	) {
		throw new Error("source_tape_verification_scope_invalid");
	}
	const parameters = {
		capture_bundle_id: input.sinkResult.capture_bundle_id,
		exchange: input.request.scope.exchange,
		trading_pair: input.request.scope.tradingPair,
		construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
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
		throw new Error("source_tape_verification_result_invalid");
	}
	const countsMatch =
		unsigned(countRows[0]?.level_rows, "source_tape_level_count_invalid") ===
			input.sinkResult.level_row_count &&
		unsigned(
			countRows[0]?.summary_rows,
			"source_tape_summary_count_invalid",
		) === input.sinkResult.summary_row_count &&
		unsigned(countRows[0]?.state_count, "source_tape_state_count_invalid") ===
			input.sinkResult.state_count;
	const conflictFree =
		unsigned(
			conflictRows[0]?.conflicts,
			"source_tape_conflict_count_invalid",
		) === 0;
	const notAlreadyQualified =
		unsigned(
			qualifiedRows[0]?.qualified_rows,
			"source_tape_qualified_count_invalid",
		) === 0;
	const semantic = new SourceTapeSemanticDigestAccumulator();
	let position = 0;
	let observedLevelRows = 0;
	let firstDescriptorSha256: string | undefined;
	let lastDescriptorSha256: string | undefined;
	let cursor:
		| { source_time_ms: number; sequence: string; snapshot_id: string }
		| undefined;
	let streamValid = true;
	const pageSize = 4;
	while (streamValid) {
		const summaries = await input.client.query(
			`SELECT capture_bundle_id, exchange, trading_pair, raw_capture_id,
			        snapshot_id, schema_version, source_time_ms, sequence,
			        normalized_row_checksum
			 FROM market_data.cex_order_book_depth_summary_canonical
			 WHERE capture_bundle_id = {capture_bundle_id:String}
			   AND exchange = {exchange:String}
			   AND trading_pair = {trading_pair:String}
			   AND construction_mode = {construction_mode:String}
			   AND source_time_ms >= {initializer_source_time_ms:UInt64}
			   AND source_time_ms < {end_time_ms:UInt64}
			   AND ({has_cursor:UInt8} = 0 OR
			        (source_time_ms, sequence, snapshot_id) >
			        ({after_source_time_ms:UInt64}, {after_sequence:UInt64}, {after_snapshot_id:String}))
			 ORDER BY source_time_ms, sequence, snapshot_id
			 LIMIT {page_size:UInt64}`,
			{
				...parameters,
				initializer_source_time_ms: input.sinkResult.initializer.source_time_ms,
				end_time_ms: input.request.window.endTimeMs,
				has_cursor: cursor ? 1 : 0,
				after_source_time_ms: cursor?.source_time_ms ?? 0,
				after_sequence: cursor?.sequence ?? "0",
				after_snapshot_id: cursor?.snapshot_id ?? "",
				page_size: pageSize,
			},
		);
		if (summaries.length === 0) break;
		if (
			summaries.length > pageSize ||
			position + summaries.length > input.sinkResult.state_count
		) {
			streamValid = false;
			break;
		}
		const snapshotIds = summaries.map((row) => String(row.snapshot_id));
		if (
			snapshotIds.some((snapshotId) => !/^[a-f0-9]{64}$/u.test(snapshotId)) ||
			new Set(snapshotIds).size !== snapshotIds.length
		) {
			streamValid = false;
			break;
		}
		const levels = await input.client.query(
			`SELECT capture_bundle_id, exchange, trading_pair, raw_capture_id,
			        snapshot_id, schema_version, side, level_index,
			        source_time_ms, sequence, normalized_row_checksum
			 FROM market_data.cex_order_book_levels_canonical
			 WHERE capture_bundle_id = {capture_bundle_id:String}
			   AND exchange = {exchange:String}
			   AND trading_pair = {trading_pair:String}
			   AND construction_mode = {construction_mode:String}
			   AND snapshot_id IN {snapshot_ids:Array(String)}
			 ORDER BY source_time_ms, sequence, snapshot_id, side, level_index`,
			{ ...parameters, snapshot_ids: snapshotIds },
		);
		if (levels.length > pageSize * input.request.depth * 2) {
			streamValid = false;
			break;
		}
		for (const summary of summaries) {
			const snapshotId = String(summary.snapshot_id);
			const sourceTimeMs = unsigned(
				summary.source_time_ms,
				"source_tape_source_time_invalid",
			);
			const sequence = String(summary.sequence ?? "");
			const nextCursor = {
				source_time_ms: sourceTimeMs,
				sequence,
				snapshot_id: snapshotId,
			};
			if (
				!/^\d+$/u.test(sequence) ||
				(cursor &&
					(sourceTimeMs < cursor.source_time_ms ||
						(sourceTimeMs === cursor.source_time_ms &&
							(BigInt(sequence) < BigInt(cursor.sequence) ||
								(BigInt(sequence) === BigInt(cursor.sequence) &&
									snapshotId <= cursor.snapshot_id)))))
			) {
				streamValid = false;
				break;
			}
			const stateLevels = levels.filter(
				(row) => String(row.snapshot_id) === snapshotId,
			);
			observedLevelRows += stateLevels.length;
			const descriptor = sourceTapeSemanticStateDescriptor({
				stateKind: position === 0 ? "initialization" : "change",
				semanticStreamPosition: position,
				rows: [
					...stateLevels.map((row) => ({
						table: "market_data.cex_order_book_levels" as const,
						row,
					})),
					{
						table: "market_data.cex_order_book_depth_summary" as const,
						row: summary,
					},
				],
			});
			if (
				(position === 0 &&
					(descriptor.canonical_snapshot_id !==
						input.sinkResult.initializer.canonical_snapshot_id ||
						descriptor.source_time_ms !==
							input.sinkResult.initializer.source_time_ms ||
						descriptor.sequence !== input.sinkResult.initializer.sequence)) ||
				(position > 0 &&
					(descriptor.source_time_ms < input.request.window.startTimeMs ||
						descriptor.source_time_ms >= input.request.window.endTimeMs))
			) {
				streamValid = false;
				break;
			}
			semantic.append(descriptor);
			const descriptorSha256 = jcsSha256(descriptor);
			firstDescriptorSha256 ??= descriptorSha256;
			lastDescriptorSha256 = descriptorSha256;
			position += 1;
			cursor = nextCursor;
		}
		if (!streamValid || summaries.length < pageSize) break;
	}
	const canonicalSemanticDigest = semantic.digest();
	const semanticMatch =
		streamValid &&
		position === input.sinkResult.state_count &&
		observedLevelRows === input.sinkResult.level_row_count &&
		position === input.sinkResult.summary_row_count &&
		canonicalSemanticDigest === input.sinkResult.expected_semantic_digest &&
		firstDescriptorSha256 === input.sinkResult.first_state_descriptor_sha256 &&
		lastDescriptorSha256 === input.sinkResult.last_state_descriptor_sha256;
	const passed =
		countsMatch &&
		conflictFree &&
		notAlreadyQualified &&
		input.sinkResult.provider_object_inventory_complete &&
		semanticMatch;
	return {
		passed,
		captureBundleId: input.sinkResult.capture_bundle_id,
		canonicalSemanticDigest,
		prefixDigest: firstDescriptorSha256 ?? jcsSha256({ missing: "prefix" }),
		suffixDigest: lastDescriptorSha256 ?? jcsSha256({ missing: "suffix" }),
		seamVerified: streamValid && semanticMatch,
		coverageVerified: countsMatch && semanticMatch,
		...(passed ? {} : { reasonCode: "source_tape_verification_failed" }),
	};
}

export type SourceTapeExportArtifact = {
	file_name: string;
	rows: number;
	bytes: number;
	sha256: string;
	projection_schema_id: string;
	projection_schema_sha256: string;
};

export type SourceTapeExportResult = {
	promotionReceiptIds: string[];
	levels: SourceTapeExportArtifact;
	summary: SourceTapeExportArtifact;
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
		deploymentId: EXTERNAL_BACKFILL_DEPLOYMENT_ID,
		rows: [row],
	});
	if (batches.length !== 1) {
		throw new Error("source_tape_evidence_batch_invalid");
	}
	const batch = batches[0] as ForwarderBatch;
	const response = await forwarder.submit(batch);
	if (!response.ok || response.inserted !== 1) {
		throw new Error("source_tape_evidence_rejected");
	}
}

export type SourceTapeSandboxEvidence = {
	schema_id: "market-data-source-tape-sandbox-evidence/v1";
	archive_target: typeof SOURCE_TAPE_SANDBOX_TARGET;
	construction_mode: typeof SOURCE_TAPE_CONSTRUCTION_MODE;
	normal_archive_path: true;
	tape_capability: { policy_id: string; policy_sha256: string };
	state_count: number;
	promotion: {
		receipt_id: string;
		promotion_identity_sha256: string;
		qualification_event_id: string;
	};
	selection: { selection_sha256: string; receipt_ids: string[] };
	export: {
		levels: SourceTapeExportArtifact;
		summary: SourceTapeExportArtifact;
	};
	projection_schema_pins: readonly {
		schema_id: string;
		schema_sha256: string;
	}[];
};

export async function promoteAndExportSourceTapeSandbox(input: {
	request: MarketDataVendorBackfillRequest;
	sinkResult: SourceTapeArchiveSinkResult;
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
			construction_mode: typeof SOURCE_TAPE_CONSTRUCTION_MODE;
			canonical_schema_version: string;
			checksum_algorithm: "sha256-canonical-json-v1";
		}): Promise<SourceTapeExportResult>;
	};
}): Promise<SourceTapeSandboxEvidence> {
	const request = input.request;
	if (
		request.target?.environment !== SOURCE_TAPE_SANDBOX_TARGET.environment ||
		request.target.cluster !== SOURCE_TAPE_SANDBOX_TARGET.cluster ||
		request.constructionMode !== SOURCE_TAPE_CONSTRUCTION_MODE ||
		request.depth !== 100 ||
		!request.initialSelection ||
		!request.coveragePolicy ||
		!request.expectedCanonicalSchema ||
		!input.verification.passed ||
		input.verification.captureBundleId !== input.sinkResult.capture_bundle_id ||
		!input.verification.seamVerified ||
		!input.verification.coverageVerified
	) {
		throw new Error("source_tape_promotion_precondition_failed");
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
		adapter_version: SOURCE_TAPE_CAPABILITY.adapter_version,
		effective_policies: {
			capability_policy: {
				policy_id: SOURCE_TAPE_CAPABILITY.policy_id,
				policy_sha256: SOURCE_TAPE_CAPABILITY.policy_sha256,
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
		construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
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
		throw new Error("source_tape_receipt_policy_mismatch");
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
		reason_code: "source_tape_verified",
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
		throw new Error("source_tape_selection_invalid");
	}
	const exported = await input.exporter.export({
		schema_id:
			"https://schemas.usher.so/cex-canonical-orderbook-export-request/v1",
		request_id: request.requestId,
		target: SOURCE_TAPE_SANDBOX_TARGET,
		selection,
		depth: 100,
		construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
		canonical_schema_version: request.expectedProduct.canonicalSchemaVersion,
		checksum_algorithm: "sha256-canonical-json-v1",
	});
	if (
		exported.promotionReceiptIds.length !== 1 ||
		exported.promotionReceiptIds[0] !== receipt.receipt_id ||
		exported.levels.rows !== input.sinkResult.level_row_count ||
		exported.summary.rows !== input.sinkResult.summary_row_count ||
		!SOURCE_TAPE_PROJECTION_PINS.some(
			(pin) =>
				pin.schema_id === exported.levels.projection_schema_id &&
				pin.schema_sha256 === exported.levels.projection_schema_sha256,
		) ||
		!SOURCE_TAPE_PROJECTION_PINS.some(
			(pin) =>
				pin.schema_id === exported.summary.projection_schema_id &&
				pin.schema_sha256 === exported.summary.projection_schema_sha256,
		)
	) {
		throw new Error("source_tape_export_invalid");
	}
	return {
		schema_id: "market-data-source-tape-sandbox-evidence/v1",
		archive_target: SOURCE_TAPE_SANDBOX_TARGET,
		construction_mode: SOURCE_TAPE_CONSTRUCTION_MODE,
		normal_archive_path: true,
		tape_capability: {
			policy_id: SOURCE_TAPE_CAPABILITY.policy_id,
			policy_sha256: SOURCE_TAPE_CAPABILITY.policy_sha256,
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
		projection_schema_pins: SOURCE_TAPE_PROJECTION_PINS,
	};
}
