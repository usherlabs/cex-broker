import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCryptoHftDataConformanceDocuments } from "../scripts/market-data-vendor-backfill-conformance";
import {
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID,
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
} from "../src/helpers/market-data-preparation/contracts";
import {
	ARCHIVE_SELECTION_SCHEMA_ID,
	finalizeArchiveSelection,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import {
	enumerateCryptoHftDataObjects,
	enumerateCryptoHftDataWindowObjects,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import {
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";
import { SOURCE_TAPE_CAPABILITY } from "../src/helpers/source-tape";
import {
	CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
	finalizeCanonicalOrderBookExportResult,
	MARKET_DATA_REQUIRED_CLOCK_QUALIFICATION_OPERATION_ID,
	MARKET_DATA_SOURCE_TAPE_OPERATION_ID,
	type RequiredClockQualificationAdapterFactory,
	runMarketDataRequiredClockQualification,
	runMarketDataSourceTape,
} from "../src/market-data-preparation";

const startedAt = Date.UTC(2026, 7, 18, 9, 27, 15, 308);

const acceptedAdapter: RequiredClockQualificationAdapterFactory = (
	observer,
) => ({
	capabilityFor(request) {
		return {
			provider: "cryptohftdata",
			adapterVersion: "cryptohftdata-orderbook/v2",
			providerExchangeId: "okx_spot",
			resolvedSymbol: request.scope.tradingPair,
		};
	},
	async acquire(request) {
		const identities = enumerateCryptoHftDataObjects(
			request,
			"okx_spot",
			request.scope.tradingPair,
		);
		for (const identity of identities) {
			observer.observe({
				type: "provider_object_boundary",
				object: {
					identity,
					checksums: ["a".repeat(64)],
					attempt_count: 1,
					quarantined: false,
				},
			});
		}
		for (const targetTime of request.requiredClockTargetsMs) {
			observer.observe({
				type: "required_clock_sample",
				target_time_ms: targetTime,
				source_time_ms: targetTime - 1_000,
				lag_ms: 1_000,
				status: "covered",
				object: {
					identity: identities.at(-1) as string,
					checksums: ["a".repeat(64)],
					attempt_count: 1,
					quarantined: false,
				},
			});
		}
		return {
			objects: identities.map((identity) => ({
				identity,
				checksum: "a".repeat(64),
				bytes: 1,
				rows: 1,
			})),
			vendorSemanticDigest: "b".repeat(64),
		};
	},
});

function invocation() {
	const documents = buildCryptoHftDataConformanceDocuments(startedAt);
	return {
		operation_id: MARKET_DATA_REQUIRED_CLOCK_QUALIFICATION_OPERATION_ID,
		attempt_id: "arb-usdt-required-clock-1",
		request: documents.request,
		required_clock: documents.requiredClock,
		artifacts: {
			ledger_file_name: "arb-usdt-source-ledger.json",
			qualification_record_file_name: "arb-usdt-source-qualification.json",
		},
	};
}

function sourceTapeInvocation() {
	return {
		operation_id: MARKET_DATA_SOURCE_TAPE_OPERATION_ID,
		attempt_id: "arb-usdt-source-tape-1",
		request_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f100",
		scope: {
			exchange: "okx" as const,
			trading_pair: "ARB-USDT" as const,
			market_type: "spot" as const,
			feed: "ORDERBOOK" as const,
		},
		window: {
			start_at: "2026-08-18T09:27:15.000Z",
			end_at: "2026-08-18T09:27:17.000Z",
		},
		depth: 100 as const,
		target: {
			environment: "sandbox" as const,
			cluster: "cex-archive-local" as const,
		},
		production_authorization_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f103",
		expected_canonical_schema: {
			schema_id: "cex-order-book-canonical/v1",
			schema_sha256: "a".repeat(64),
		},
		product_pins: {
			source_tape_capability: {
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
		artifacts: {
			ledger_file_name: "arb-usdt-tape-ledger.json",
			qualification_record_file_name: "arb-usdt-tape-qualification.json",
			exporter_result_file_name: "arb-usdt-tape-export-result.json",
		},
	};
}

const unusedTapeDependencies = {
	forwarder: {
		async submit(batch: { rows: unknown[] }) {
			return { ok: true, inserted: batch.rows.length };
		},
	},
	archive_query: {
		async query() {
			return [];
		},
	},
	archive: {
		async resolveSelection() {
			throw new Error("unused");
		},
	},
	exporter: {
		async export() {
			throw new Error("unused");
		},
	},
};

describe("market-data preparation library operations", () => {
	test("qualifies an authoritative clock with a host-neutral invocation identity", async () => {
		const first = await mkdtemp(path.join(os.tmpdir(), "cex-operation-a-"));
		const second = await mkdtemp(path.join(os.tmpdir(), "cex-operation-b-"));
		try {
			const run = (attemptRoot: string) =>
				runMarketDataRequiredClockQualification({
					invocation: invocation(),
					attempt_root: attemptRoot,
					created_at: "2026-08-26T15:00:00.000Z",
					credential: { api_key: "provider-secret" },
					dependencies: { adapter_factory: acceptedAdapter },
				});
			const [left, right] = await Promise.all([run(first), run(second)]);
			expect(left.normalized_invocation_sha256).toBe(
				right.normalized_invocation_sha256,
			);
			expect(JSON.stringify(left)).not.toContain(first);
			expect(JSON.stringify(right)).not.toContain(second);
			expect(left.qualification).toMatchObject({
				operation_kind: "required_clock_qualification",
				qualified: true,
				outcome: {
					status: "success",
					reason: "required_clock_qualification_completed",
				},
			});
			expect(
				JSON.parse(
					await readFile(
						path.join(
							first,
							invocation().artifacts.qualification_record_file_name,
						),
						"utf8",
					),
				),
			).toEqual(left.qualification);
		} finally {
			await Promise.all([
				rm(first, { recursive: true, force: true }),
				rm(second, { recursive: true, force: true }),
			]);
		}
	});

	test("rejects Maker-owned and unknown canonical invocation fields", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-operation-"));
		try {
			await expect(
				runMarketDataRequiredClockQualification({
					invocation: {
						...invocation(),
						candidate_role: "nominal",
					} as never,
					attempt_root: root,
					created_at: "2026-08-26T15:00:00.000Z",
					credential: { api_key: "provider-secret" },
				}),
			).rejects.toThrow("invocation_invalid");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("commits a closed pair-local failure instead of throwing after handling begins", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-operation-"));
		try {
			const result = await runMarketDataRequiredClockQualification({
				invocation: invocation(),
				attempt_root: root,
				created_at: "2026-08-26T15:00:00.000Z",
				credential: { api_key: "" },
			});
			expect(result.qualification).toMatchObject({
				qualified: false,
				outcome: {
					status: "failure",
					reason: "required_clock_credentials_missing",
					exporter_result: null,
				},
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("commits a source-tape failure with no initializer or exporter when credentials are absent", async () => {
		const first = await mkdtemp(
			path.join(os.tmpdir(), "cex-tape-operation-a-"),
		);
		const second = await mkdtemp(
			path.join(os.tmpdir(), "cex-tape-operation-b-"),
		);
		try {
			const run = (attemptRoot: string) =>
				runMarketDataSourceTape({
					invocation: sourceTapeInvocation(),
					attempt_root: attemptRoot,
					created_at: "2026-08-26T15:00:00.000Z",
					credential: { api_key: "" },
					dependencies: unusedTapeDependencies as never,
				});
			const [left, right] = await Promise.all([run(first), run(second)]);
			expect(left.normalized_invocation_sha256).toBe(
				right.normalized_invocation_sha256,
			);
			expect(JSON.stringify(left)).not.toContain(first);
			expect(left.qualification).toMatchObject({
				operation_kind: "source_tape",
				initializer: null,
				source_tape_eligible: false,
				outcome: {
					status: "failure",
					reason: "source_tape_credentials_missing",
					exporter_result: null,
				},
			});
			expect(
				JSON.parse(
					await readFile(
						path.join(
							first,
							sourceTapeInvocation().artifacts.qualification_record_file_name,
						),
						"utf8",
					),
				),
			).toEqual(left.qualification);
		} finally {
			await Promise.all([
				rm(first, { recursive: true, force: true }),
				rm(second, { recursive: true, force: true }),
			]);
		}
	});

	test("rejects required-clock and Maker-role fields on the source-tape invocation", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-tape-operation-"));
		try {
			for (const rejected of [
				{ required_clock: { targets: [] } },
				{ candidate_role: "bootstrap" },
			]) {
				await expect(
					runMarketDataSourceTape({
						invocation: { ...sourceTapeInvocation(), ...rejected } as never,
						attempt_root: root,
						created_at: "2026-08-26T15:00:00.000Z",
						credential: { api_key: "" },
						dependencies: unusedTapeDependencies as never,
					}),
				).rejects.toThrow("source_tape_invocation_invalid");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("prepares a source-complete tape through semantic verification, promotion, selection, and exporter v2", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cex-tape-operation-"));
		const forwardedRows: Array<{
			table: string;
			row: Record<string, unknown>;
		}> = [];
		try {
			const invocation = sourceTapeInvocation();
			let receiptId = "";
			let promotionIdentity = "";
			let qualificationEventId = "";
			const result = await runMarketDataSourceTape({
				invocation,
				attempt_root: root,
				created_at: "2026-08-26T15:00:00.000Z",
				credential: { api_key: "provider-secret" },
				dependencies: {
					forwarder: {
						async submit(batch) {
							forwardedRows.push(...batch.rows);
							for (const entry of batch.rows) {
								if (entry.table.endsWith("capture_promotions")) {
									receiptId = String(entry.row.receipt_id);
									promotionIdentity = String(
										entry.row.promotion_identity_sha256,
									);
								}
								if (entry.table.endsWith("capture_qualifications")) {
									qualificationEventId = String(
										entry.row.qualification_event_id,
									);
								}
							}
							return { ok: true, inserted: batch.rows.length };
						},
					},
					archive_query: {
						async query(sql) {
							const levels = forwardedRows
								.filter(({ table }) => table.endsWith("order_book_levels"))
								.map(({ row }) => row);
							const summaries = forwardedRows
								.filter(({ table }) => table.endsWith("depth_summary"))
								.map(({ row }) => row);
							if (sql.includes("cex_order_book_levels_conflicts")) {
								return [{ conflicts: "0" }];
							}
							if (sql.includes("replay_qualified")) {
								return [{ qualified_rows: "0" }];
							}
							if (
								sql.includes(
									"FROM market_data.cex_order_book_depth_summary_canonical",
								) &&
								!sql.includes("AS summary_rows")
							) {
								return summaries;
							}
							if (
								sql.includes(
									"FROM market_data.cex_order_book_levels_canonical",
								) &&
								!sql.includes("AS level_rows")
							) {
								return levels;
							}
							return [
								{
									level_rows: String(levels.length),
									summary_rows: String(summaries.length),
									state_count: String(summaries.length),
								},
							];
						},
					},
					archive: {
						async resolveSelection(request) {
							return finalizeArchiveSelection({
								schema_id: ARCHIVE_SELECTION_SCHEMA_ID,
								scope: invocation.scope,
								required_clock: request.initialSelection
									?.required_clock as never,
								coverage_policy: request.coveragePolicy as never,
								source_policy: "authoritative_window",
								coverage_class: "complete",
								requested_intervals: [invocation.window],
								selected_intervals: [
									{
										...invocation.window,
										capture_bundle_id: forwardedRows[0]?.row
											.capture_bundle_id as string,
										capture_origin: "vendor_historical_backfill",
									},
								],
								precedence: ["vendor"],
								bundles: [
									{
										capture_bundle_id: forwardedRows[0]?.row
											.capture_bundle_id as string,
										capture_origin: "vendor_historical_backfill",
										interval: invocation.window,
										qualification: {
											qualification_event_id: qualificationEventId,
											state: "qualified",
											receipt_id: receiptId,
											promotion_identity_sha256: promotionIdentity,
										},
									},
								],
								support_anchors: [],
								receipt_ids: [receiptId],
								qualification_event_ids: [qualificationEventId],
								resolved_at: "2026-08-26T15:00:00.000Z",
							});
						},
					},
					exporter: {
						async export(request) {
							const levels = forwardedRows.filter(({ table }) =>
								table.endsWith("order_book_levels"),
							).length;
							const summaries = forwardedRows.filter(({ table }) =>
								table.endsWith("depth_summary"),
							).length;
							const artifacts = {
								levels: {
									file_name: "order_book_levels.parquet",
									rows: levels,
									bytes: 2_000,
									sha256: "f".repeat(64),
									projection_schema_id:
										ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID,
									projection_schema_sha256:
										ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
								},
								summary: {
									file_name: "order_book_depth_summary.parquet",
									rows: summaries,
									bytes: 1_000,
									sha256: "1".repeat(64),
									projection_schema_id:
										ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID,
									projection_schema_sha256:
										ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
								},
							};
							return {
								promotionReceiptIds: request.selection.receipt_ids,
								...artifacts,
								result: finalizeCanonicalOrderBookExportResult({
									schema_id: CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
									job_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f122",
									request_file_sha256: "d".repeat(64),
									producer: {
										product_id: "cex-canonical-orderbook-export",
										product_version: "cex-canonical-orderbook-export/v2",
										package: {
											name: "@usherlabs/cex-broker",
											version: "0.2.50",
											git_head: "a".repeat(40),
										},
										executable_sha256: "b".repeat(64),
										runtime: { name: "node", version: "22.22.2" },
									},
									started_at: "2026-08-26T14:59:59.000Z",
									completed_at: "2026-08-26T15:00:00.000Z",
									outcome: {
										status: "exported",
										reason_code: "qualified_selection_exported",
										reason_subcode: null,
										request_id: request.request_id,
										target: request.target,
										selection_sha256: request.selection.selection_sha256,
										query_sha256: "e".repeat(64),
										query_segments: request.selection.selected_intervals,
										promotion_receipt_ids: request.selection.receipt_ids,
										artifacts,
										diagnostics: {},
									},
								}),
							};
						},
					},
					adapter_factory(observer, sink) {
						return {
							capabilityFor(request) {
								return {
									provider: "cryptohftdata",
									adapterVersion: SOURCE_TAPE_CAPABILITY.adapter_version,
									providerExchangeId: "okx_spot",
									resolvedSymbol: request.scope.tradingPair,
								};
							},
							async acquire(request) {
								const identities = enumerateCryptoHftDataWindowObjects(
									request,
									"okx_spot",
									request.scope.tradingPair,
								);
								const objects = identities.map((identity) => ({
									identity,
									checksum: "a".repeat(64),
									bytes: 1,
									rows: 1,
								}));
								for (const object of objects) {
									observer.observe({
										type: "provider_object_boundary",
										object: {
											identity: object.identity,
											checksums: [object.checksum],
											attempt_count: 1,
											quarantined: false,
										},
									});
								}
								await sink.writeBatch([
									{
										tapeState: "initialization",
										targetTimeMs: request.window.startTimeMs - 1,
										sourceTimeMs: request.window.startTimeMs - 1,
										receivedTimeMs: request.window.startTimeMs - 1,
										sequence: "1",
										bids: [[1, 2]],
										asks: [[2, 3]],
										datasetObjectIdentity: identities[0] as string,
										datasetObjectChecksum: "a".repeat(64),
									},
								]);
								await sink.complete({
									expectedObjectIdentities: identities,
									observedObjects: objects,
									stateCount: 1,
								});
								return {
									objects,
									vendorSemanticDigest: "b".repeat(64),
								};
							},
						};
					},
				},
			});
			expect(result.qualification).toMatchObject({
				initializer: { semantic_stream_position: 0 },
				source_tape_eligible: true,
				outcome: {
					status: "success",
					reason: "source_tape_prepared",
					exporter_result: {
						result_sha256: result.exporter_result?.result_sha256,
					},
				},
			});
			expect(result.sandbox_evidence).toMatchObject({
				normal_archive_path: true,
				selection: { receipt_ids: [receiptId] },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
