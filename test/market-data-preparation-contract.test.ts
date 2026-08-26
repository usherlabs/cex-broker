import { describe, expect, test } from "bun:test";
import { CANDIDATE_C_INPUT_TAPE_CAPABILITY } from "../src/helpers/candidate-c-input-tape";
import { PREPARATION_CONFORMANCE_FIXTURES } from "../src/helpers/market-data-preparation/conformance-fixtures";
import {
	BACKFILL_RESULT_V2_SCHEMA_ID,
	backfillResultV2Codec,
	CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
	CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
	canonicalOrderBookExportRequestCodec,
	canonicalOrderBookExportResultCodec,
	finalizeBackfillResultV2,
	finalizeCanonicalOrderBookExportResult,
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID,
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
	PREPARATION_PRODUCT_PIN_SCHEMA_ID,
	PREPARATION_SCHEMA_ARTIFACTS,
	PREPARATION_SCHEMA_MANIFEST_V3,
	preparationProductPinCodec,
	SOURCE_FORENSICS_LEDGER_SCHEMA_ID,
	SOURCE_QUALIFICATION_RECORD_SCHEMA_ID,
} from "../src/helpers/market-data-preparation/contracts";
import staticPreparationManifest from "../src/helpers/market-data-preparation/schema-manifest.json" with {
	type: "json",
};
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import { documentSha256 } from "../src/helpers/market-data-vendor-backfill/identity";

const producer = {
	product_id: "market-data-vendor-backfill",
	product_version: "market-data-vendor-backfill/v1",
	package: {
		name: "@usherlabs/cex-broker" as const,
		version: "0.2.47",
		git_head: "a".repeat(40),
	},
	executable_sha256: "b".repeat(64),
	runtime: { name: "node" as const, version: "22.22.2" },
};

describe("market-data preparation contracts", () => {
	test("publishes no current result-v1 or legacy-policy schema path", () => {
		const serialized = JSON.stringify(PREPARATION_SCHEMA_MANIFEST_V3);
		expect(serialized).not.toContain("backfill-result-v1");
		expect(serialized).not.toContain("export-result-v1");
		expect(serialized).not.toContain("product-pin-v1");
	});

	test("finalizes a CEX-produced backfill result v2 without Fiet provenance", () => {
		const current = PREPARATION_CONFORMANCE_FIXTURES.documents.backfill_result;
		const { result_sha256: _resultSha256, ...content } = current;
		const result = finalizeBackfillResultV2({
			...content,
			producer,
		});

		expect(backfillResultV2Codec.decode(result)).toEqual(result);
		expect(result.result_sha256).toBe(documentSha256(result, "result_sha256"));
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("fiet_tee_commit");
		expect(serialized).not.toContain("created_at");
		expect(serialized).not.toContain("package_sha256");
	});

	test("publishes manifest v3 with exactly twelve current schemas", () => {
		expect(staticPreparationManifest).toEqual(PREPARATION_SCHEMA_MANIFEST_V3);
		expect(PREPARATION_SCHEMA_MANIFEST_V3.schema_id).toBe(
			"https://schemas.usher.so/market-data-vendor-backfill-schema-manifest/v3",
		);
		expect(PREPARATION_SCHEMA_MANIFEST_V3.manifest_sha256).toBe(
			documentSha256(PREPARATION_SCHEMA_MANIFEST_V3, "manifest_sha256"),
		);
		expect(PREPARATION_SCHEMA_ARTIFACTS).toHaveLength(12);
		expect(
			PREPARATION_SCHEMA_ARTIFACTS.filter(
				({ schema }) => "parquet_metadata" in schema,
			).map(({ schema }) => schema.parquet_metadata),
		).toEqual([{ key_value_metadata: [] }, { key_value_metadata: [] }]);
		expect(
			new Set(PREPARATION_SCHEMA_ARTIFACTS.map(({ schema_id }) => schema_id)),
		).toEqual(
			new Set([
				"https://schemas.usher.so/market-data-vendor-backfill-request/v1",
				BACKFILL_RESULT_V2_SCHEMA_ID,
				"https://schemas.usher.so/market-data-vendor-backfill-required-clock/v1",
				"https://schemas.usher.so/market-data-vendor-backfill-archive-selection/v1",
				"https://schemas.usher.so/market-data-vendor-backfill-promotion-receipt/v1",
				CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
				CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
				PREPARATION_PRODUCT_PIN_SCHEMA_ID,
				ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID,
				ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID,
				SOURCE_FORENSICS_LEDGER_SCHEMA_ID,
				SOURCE_QUALIFICATION_RECORD_SCHEMA_ID,
			]),
		);
	});

	test("pins the qualification-only Candidate C input-tape capability", () => {
		expect(
			PREPARATION_CONFORMANCE_FIXTURES.documents.preparation_product_pin
				.candidate_c_input_tape_capability,
		).toEqual({
			policy_id: CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_id,
			policy_sha256: CANDIDATE_C_INPUT_TAPE_CAPABILITY.policy_sha256,
		});
		expect(PREPARATION_SCHEMA_ARTIFACTS).toHaveLength(12);
	});

	test("ships valid v2 backfill, exact export, and product-pin conformance documents", () => {
		const documents = PREPARATION_CONFORMANCE_FIXTURES.documents;
		expect(backfillResultV2Codec.decode(documents.backfill_result)).toEqual(
			documents.backfill_result,
		);
		expect(
			canonicalOrderBookExportRequestCodec.decode(
				documents.canonical_orderbook_export_request,
			),
		).toEqual(documents.canonical_orderbook_export_request);
		expect(
			canonicalOrderBookExportResultCodec.decode(
				documents.canonical_orderbook_export_result,
			),
		).toEqual(documents.canonical_orderbook_export_result);
		expect(
			preparationProductPinCodec.decode(documents.preparation_product_pin),
		).toEqual(documents.preparation_product_pin);
	});

	test("rejects product pins whose schema identities do not match the release manifest", () => {
		const productPin = structuredClone(
			PREPARATION_CONFORMANCE_FIXTURES.documents.preparation_product_pin,
		);
		const firstSchema = productPin.schema_pins[0];
		if (!firstSchema) throw new Error("product pin fixture has no schemas");
		firstSchema.schema_sha256 = "0".repeat(64);
		expect(() => preparationProductPinCodec.decode(productPin)).toThrow(
			"product pin schema identities do not match the preparation manifest",
		);
	});

	test("rejects successful result-v2 evidence whose selected receipt lineage disagrees", () => {
		const fixture = structuredClone(
			PREPARATION_CONFORMANCE_FIXTURES.documents.backfill_result,
		);
		const selection = fixture.outcome.selection;
		if (!selection) throw new Error("fixture selection missing");
		const bundle = selection.bundles.find(
			(candidate) => candidate.capture_origin === "vendor_historical_backfill",
		);
		if (!bundle?.qualification)
			throw new Error("fixture receipt lineage missing");
		bundle.qualification.receipt_id = "0".repeat(64);
		selection.receipt_ids = ["0".repeat(64)];
		selection.selection_sha256 = documentSha256(selection, "selection_sha256");
		const { result_sha256: _resultSha256, ...content } = fixture;
		expect(() => finalizeBackfillResultV2(content)).toThrow(
			"successful vendor selection and current receipt lineage disagree",
		);
	});

	test("validates exact export requests and finalized successful receipts", () => {
		const selection = CONFORMANCE_FIXTURES.documents.archive_selection;
		const request = canonicalOrderBookExportRequestCodec.decode({
			schema_id: CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID,
			request_id: CONFORMANCE_FIXTURES.documents.request.request_id,
			target: { environment: "production", cluster: "cex-archive-primary" },
			selection,
			depth: 20,
			construction_mode: "sampled_top_n_snapshot",
			canonical_schema_version: "1.0.0",
			checksum_algorithm: "sha256-canonical-json-v1",
		});
		const exportProducer = {
			...producer,
			product_id: "cex-canonical-orderbook-export",
			product_version: "cex-canonical-orderbook-export/v2",
		};
		const result = finalizeCanonicalOrderBookExportResult({
			schema_id: CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID,
			job_id: "018f0f4d-7b32-7a30-8f4d-1d2a6e40f121",
			request_file_sha256: "c".repeat(64),
			producer: exportProducer,
			started_at: "2026-08-20T12:00:01.000Z",
			completed_at: "2026-08-20T12:00:03.000Z",
			outcome: {
				status: "exported",
				reason_code: "qualified_selection_exported",
				reason_subcode: null,
				request_id: request.request_id,
				target: request.target,
				selection_sha256: selection.selection_sha256,
				query_sha256: "d".repeat(64),
				query_segments: selection.selected_intervals,
				promotion_receipt_ids: selection.receipt_ids,
				artifacts: {
					levels: {
						file_name: "order_book_levels.parquet",
						rows: 40,
						bytes: 4_096,
						sha256: "e".repeat(64),
						projection_schema_id:
							ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID,
						projection_schema_sha256:
							ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
					},
					summary: {
						file_name: "order_book_depth_summary.parquet",
						rows: 1,
						bytes: 2_048,
						sha256: "f".repeat(64),
						projection_schema_id:
							ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID,
						projection_schema_sha256:
							ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
					},
				},
				diagnostics: {},
			},
		});

		expect(canonicalOrderBookExportResultCodec.decode(result)).toEqual(result);
		expect(result.result_sha256).toBe(documentSha256(result, "result_sha256"));
	});
});
