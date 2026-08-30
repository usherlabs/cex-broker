import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
	PREPARATION_PRODUCT_PIN_SCHEMA_ID,
	PREPARATION_SCHEMA_ARTIFACTS,
	PREPARATION_SCHEMA_MANIFEST_V2,
	preparationProductPinCodec,
} from "../src/helpers/market-data-preparation/contracts";
import staticPreparationManifest from "../src/helpers/market-data-preparation/schema-manifest.json" with {
	type: "json",
};
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import { documentSha256 } from "../src/helpers/market-data-vendor-backfill/identity";
import {
	SCHEMA_ARTIFACTS,
	SCHEMA_MANIFEST,
} from "../src/helpers/market-data-vendor-backfill/manifests";

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
	test("preserves the released v1 contract bytes and canonical identities", async () => {
		expect(SCHEMA_MANIFEST.manifest_sha256).toBe(
			"48e5e91d33caafd930b45552c799a9fb0c2ccd9a676106fbab2543f231dba1b7",
		);
		expect(
			SCHEMA_ARTIFACTS.find(({ path }) => path === "schemas/result.schema.json")
				?.schema_sha256,
		).toBe("65b5b3cf3b876159e8bc5f28978f3fcf08e9e91653eade463a1136e7b71c41fa");
		const rawPins = new Map([
			[
				"schemas/result.schema.json",
				"16230047a5fce2dd88a6f9e9ac9c8ac82e3111fefac6ea7243e8e1c43f2676b1",
			],
			[
				"schemas/schema-manifest.json",
				"7ea3cca721e03df41d9c651cad69eebc3d83dd801bc214854c8c93edca2d41ae",
			],
			[
				"fixtures/conformance-v1.json",
				"54b08b52464e1be6fffa4ebb9edf50ddf65a07ee2ae43dd7ec05eb16fe27ea80",
			],
		]);
		for (const [relativePath, expected] of rawPins) {
			const bytes = await readFile(
				new URL(
					`../src/helpers/market-data-vendor-backfill/${relativePath}`,
					import.meta.url,
				),
			);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
		}
	});

	test("finalizes a CEX-produced backfill result v2 without Fiet provenance", () => {
		const legacy = CONFORMANCE_FIXTURES.documents.result;
		const result = finalizeBackfillResultV2({
			schema_id: BACKFILL_RESULT_V2_SCHEMA_ID,
			job_id: legacy.job_id,
			request_file_sha256: legacy.request_file_sha256,
			schema_manifest_sha256: PREPARATION_SCHEMA_MANIFEST_V2.manifest_sha256,
			producer,
			capability_policy: legacy.capability_policy,
			resource_policy: legacy.resource_policy,
			started_at: legacy.started_at,
			completed_at: legacy.completed_at,
			outcome: legacy.outcome,
		});

		expect(backfillResultV2Codec.decode(result)).toEqual(result);
		expect(result.result_sha256).toBe(documentSha256(result, "result_sha256"));
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("fiet_tee_commit");
		expect(serialized).not.toContain("created_at");
		expect(serialized).not.toContain("package_sha256");
	});

	test("publishes a manifest v2 for every runtime and product-pin schema", () => {
		expect(staticPreparationManifest).toEqual(PREPARATION_SCHEMA_MANIFEST_V2);
		expect(PREPARATION_SCHEMA_MANIFEST_V2.schema_id).toBe(
			"https://schemas.usher.so/market-data-vendor-backfill-schema-manifest/v2",
		);
		expect(PREPARATION_SCHEMA_MANIFEST_V2.manifest_sha256).toBe(
			documentSha256(PREPARATION_SCHEMA_MANIFEST_V2, "manifest_sha256"),
		);
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
			]),
		);
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
			product_version: "cex-canonical-orderbook-export/v1",
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
					},
					summary: {
						file_name: "order_book_depth_summary.parquet",
						rows: 1,
						bytes: 2_048,
						sha256: "f".repeat(64),
					},
				},
				diagnostics: {},
			},
		});

		expect(canonicalOrderBookExportResultCodec.decode(result)).toEqual(result);
		expect(result.result_sha256).toBe(documentSha256(result, "result_sha256"));
	});
});
