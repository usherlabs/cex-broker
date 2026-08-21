import { CONFORMANCE_FIXTURES as V1_CONFORMANCE_FIXTURES } from "../market-data-vendor-backfill/conformance-fixtures";
import {
	BACKFILL_RESULT_V2_SCHEMA_ID,
	CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
	CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
	canonicalOrderBookExportRequestCodec,
	finalizeBackfillResultV2,
	finalizeCanonicalOrderBookExportResult,
	PREPARATION_PRODUCT_PIN_SCHEMA_ID,
	PREPARATION_SCHEMA_ARTIFACTS,
	PREPARATION_SCHEMA_MANIFEST_V2,
	preparationProductPinCodec,
} from "./contracts";

const backfillProducer = {
	product_id: "market-data-vendor-backfill" as const,
	product_version: "market-data-vendor-backfill/v1" as const,
	package: {
		name: "@usherlabs/cex-broker" as const,
		version: "0.2.47",
		git_head: "a".repeat(40),
	},
	executable_sha256: "b".repeat(64),
	runtime: { name: "node" as const, version: "22.22.2" },
};

const exportProducer = {
	...backfillProducer,
	product_id: "cex-canonical-orderbook-export" as const,
	product_version: "cex-canonical-orderbook-export/v1" as const,
	executable_sha256: "c".repeat(64),
};

const canonicalOrderBookExportRequest =
	canonicalOrderBookExportRequestCodec.decode({
		schema_id: CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
		request_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f121",
		target: { environment: "production", cluster: "cex-archive-primary" },
		selection: V1_CONFORMANCE_FIXTURES.documents.archive_selection,
		depth: 20,
		construction_mode: "sampled_top_n_snapshot",
		canonical_schema_version: "1.0.0",
		checksum_algorithm: "sha256-canonical-json-v1",
	});

const canonicalOrderBookExportResult = finalizeCanonicalOrderBookExportResult({
	schema_id: CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
	job_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f122",
	request_file_sha256: "d".repeat(64),
	producer: exportProducer,
	started_at: "2026-08-20T12:00:01.000Z",
	completed_at: "2026-08-20T12:00:03.000Z",
	outcome: {
		status: "exported",
		reason_code: "qualified_selection_exported",
		reason_subcode: null,
		request_id: canonicalOrderBookExportRequest.request_id,
		target: canonicalOrderBookExportRequest.target,
		selection_sha256:
			canonicalOrderBookExportRequest.selection.selection_sha256,
		query_sha256: "e".repeat(64),
		query_segments:
			canonicalOrderBookExportRequest.selection.selected_intervals,
		promotion_receipt_ids:
			canonicalOrderBookExportRequest.selection.receipt_ids,
		artifacts: {
			levels: {
				file_name: "order_book_levels.parquet",
				rows: 40,
				bytes: 4_096,
				sha256: "f".repeat(64),
			},
			summary: {
				file_name: "order_book_depth_summary.parquet",
				rows: 1,
				bytes: 2_048,
				sha256: "1".repeat(64),
			},
		},
		diagnostics: {},
	},
});

const legacyResult = V1_CONFORMANCE_FIXTURES.documents.result;
const backfillResult = finalizeBackfillResultV2({
	schema_id: BACKFILL_RESULT_V2_SCHEMA_ID,
	job_id: legacyResult.job_id,
	request_file_sha256: legacyResult.request_file_sha256,
	schema_manifest_sha256: PREPARATION_SCHEMA_MANIFEST_V2.manifest_sha256,
	producer: backfillProducer,
	capability_policy: legacyResult.capability_policy,
	resource_policy: legacyResult.resource_policy,
	started_at: legacyResult.started_at,
	completed_at: legacyResult.completed_at,
	outcome: legacyResult.outcome,
});

const productPin = preparationProductPinCodec.decode({
	schema_id: PREPARATION_PRODUCT_PIN_SCHEMA_ID,
	package: {
		name: "@usherlabs/cex-broker",
		version: "0.2.47",
		registry_tarball_url:
			"https://registry.npmjs.org/@usherlabs/cex-broker/-/cex-broker-0.2.47.tgz",
		integrity: "sha512-YQ==",
		tarball_sha256: "2".repeat(64),
		npm_git_head: "a".repeat(40),
	},
	executables: [
		{
			product_id: "market-data-vendor-backfill",
			product_version: "market-data-vendor-backfill/v1",
			relative_path: "dist/commands/market-data-vendor-backfill.js",
			executable_sha256: backfillProducer.executable_sha256,
		},
		{
			product_id: "cex-canonical-orderbook-export",
			product_version: "cex-canonical-orderbook-export/v1",
			relative_path: "dist/commands/cex-canonical-orderbook-export.js",
			executable_sha256: exportProducer.executable_sha256,
		},
	],
	schema_manifest: {
		schema_id: PREPARATION_SCHEMA_MANIFEST_V2.schema_id,
		manifest_sha256: PREPARATION_SCHEMA_MANIFEST_V2.manifest_sha256,
		relative_path: "dist/market-data-preparation/schema-manifest.json",
	},
	schema_pins: PREPARATION_SCHEMA_ARTIFACTS.map(
		({ schema_id, schema_sha256 }) => ({ schema_id, schema_sha256 }),
	),
	capability_policy: legacyResult.capability_policy,
	resource_policy: legacyResult.resource_policy,
});

export const PREPARATION_CONFORMANCE_FIXTURES = Object.freeze({
	fixture_id: "cex-market-data-preparation-conformance/v2",
	legacy_fixture_id: V1_CONFORMANCE_FIXTURES.fixture_id,
	documents: Object.freeze({
		backfill_result: backfillResult,
		canonical_orderbook_export_request: canonicalOrderBookExportRequest,
		canonical_orderbook_export_result: canonicalOrderBookExportResult,
		preparation_product_pin: productPin,
	}),
	identities: Object.freeze({
		manifest_sha256: PREPARATION_SCHEMA_MANIFEST_V2.manifest_sha256,
		backfill_result_sha256: backfillResult.result_sha256,
		selection_sha256:
			canonicalOrderBookExportRequest.selection.selection_sha256,
		export_result_sha256: canonicalOrderBookExportResult.result_sha256,
	}),
});
