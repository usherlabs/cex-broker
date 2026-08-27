import Ajv2020, {
	type ErrorObject,
	type ValidateFunction,
} from "ajv/dist/2020.js";
import type {
	ArchiveSelectionWire,
	BackfillOutcomeWire,
	FixedUtcTimestamp,
	LowercaseUuid,
	Sha256Hex,
} from "../market-data-vendor-backfill/contracts";
import {
	archiveSelectionCodec,
	promotionReceiptCodec,
} from "../market-data-vendor-backfill/contracts";
import {
	assertDocumentSha256,
	documentSha256,
	jcsSha256,
} from "../market-data-vendor-backfill/identity";
import {
	CAPABILITY_POLICY,
	RESOURCE_POLICY,
} from "../market-data-vendor-backfill/manifests";
import { promotionReceiptMatchesCurrentPolicies } from "../market-data-vendor-backfill/promotion";
import archiveSelectionSchema from "../market-data-vendor-backfill/schemas/archive-selection.schema.json" with {
	type: "json",
};
import promotionReceiptSchema from "../market-data-vendor-backfill/schemas/promotion-receipt.schema.json" with {
	type: "json",
};
import requestSchema from "../market-data-vendor-backfill/schemas/request.schema.json" with {
	type: "json",
};
import requiredClockSchema from "../market-data-vendor-backfill/schemas/required-clock.schema.json" with {
	type: "json",
};
import { SOURCE_TAPE_CAPABILITY } from "../source-tape";
import backfillResultV2Schema from "./schemas/backfill-result-v2.schema.json" with {
	type: "json",
};
import exportRequestSchema from "./schemas/canonical-orderbook-export-request.schema.json" with {
	type: "json",
};
import exportResultSchema from "./schemas/canonical-orderbook-export-result.schema.json" with {
	type: "json",
};
import depthSummaryProjectionSchema from "./schemas/order-book-depth-summary-parquet-projection.schema.json" with {
	type: "json",
};
import levelsProjectionSchema from "./schemas/order-book-levels-parquet-projection.schema.json" with {
	type: "json",
};
import productPinSchema from "./schemas/preparation-product-pin.schema.json" with {
	type: "json",
};
import sourceForensicsLedgerSchema from "./schemas/source-forensics-ledger.schema.json" with {
	type: "json",
};
import sourceQualificationRecordSchema from "./schemas/source-qualification-record.schema.json" with {
	type: "json",
};

export const BACKFILL_RESULT_V2_SCHEMA_ID = backfillResultV2Schema.$id;
export const CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID =
	exportRequestSchema.$id;
export const CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID =
	exportResultSchema.$id;
export const PREPARATION_PRODUCT_PIN_SCHEMA_ID = productPinSchema.$id;
export const ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID =
	levelsProjectionSchema.$id;
export const ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID =
	depthSummaryProjectionSchema.$id;
export const SOURCE_FORENSICS_LEDGER_SCHEMA_ID =
	sourceForensicsLedgerSchema.$id;
export const SOURCE_QUALIFICATION_RECORD_SCHEMA_ID =
	sourceQualificationRecordSchema.$id;
export const PREPARATION_SCHEMA_MANIFEST_V3_ID =
	"https://schemas.usher.so/market-data-vendor-backfill-schema-manifest/v3" as const;

export type PreparationTarget = { environment: string; cluster: string };

export type PreparationProducerIdentity = {
	product_id: "market-data-vendor-backfill" | "cex-canonical-orderbook-export";
	product_version:
		| "market-data-vendor-backfill/v1"
		| "cex-canonical-orderbook-export/v2";
	package: {
		name: "@usherlabs/cex-broker";
		version: string;
		git_head: string;
	};
	executable_sha256: Sha256Hex;
	runtime: { name: "node"; version: string };
};

export type BackfillJobResultV2Wire = {
	schema_id: typeof BACKFILL_RESULT_V2_SCHEMA_ID;
	result_sha256: Sha256Hex;
	job_id: LowercaseUuid;
	request_file_sha256: Sha256Hex | null;
	schema_manifest_sha256: Sha256Hex;
	producer: PreparationProducerIdentity & {
		product_id: "market-data-vendor-backfill";
		product_version: "market-data-vendor-backfill/v1";
	};
	capability_policy: { policy_id: string; policy_sha256: Sha256Hex };
	resource_policy: { policy_id: string; policy_sha256: Sha256Hex };
	started_at: FixedUtcTimestamp;
	completed_at: FixedUtcTimestamp;
	outcome: BackfillOutcomeWire;
};

export type CanonicalOrderBookExportRequestWire = {
	schema_id: typeof CANONICAL_ORDERBOOK_EXPORT_REQUEST_SCHEMA_ID;
	request_id: LowercaseUuid;
	target: PreparationTarget;
	selection: ArchiveSelectionWire;
	depth: number;
	construction_mode:
		| "sampled_top_n_snapshot"
		| "exact_l2_reconstruction"
		| "policy_neutral_top_n_state_change_tape/v1";
	canonical_schema_version: string;
	checksum_algorithm: "sha256-canonical-json-v1";
};

export type CanonicalOrderBookExportQuerySegment =
	ArchiveSelectionWire["selected_intervals"][number];

export const CANONICAL_ORDERBOOK_EXPORT_STATUSES = [
	"exported",
	"request_invalid",
	"archive_query_failed",
	"archive_data_invalid",
	"artifact_write_failed",
] as const;

export type CanonicalOrderBookExportStatus =
	(typeof CANONICAL_ORDERBOOK_EXPORT_STATUSES)[number];

export type CanonicalOrderBookExportArtifact = {
	file_name: string;
	rows: number;
	bytes: number;
	sha256: Sha256Hex;
	projection_schema_id:
		| typeof ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID
		| typeof ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID;
	projection_schema_sha256: Sha256Hex;
};

export type CanonicalOrderBookExportResultWire = {
	schema_id: typeof CANONICAL_ORDERBOOK_EXPORT_RESULT_SCHEMA_ID;
	result_sha256: Sha256Hex;
	job_id: LowercaseUuid;
	request_file_sha256: Sha256Hex | null;
	producer: PreparationProducerIdentity & {
		product_id: "cex-canonical-orderbook-export";
		product_version: "cex-canonical-orderbook-export/v2";
	};
	started_at: FixedUtcTimestamp;
	completed_at: FixedUtcTimestamp;
	outcome: {
		status: CanonicalOrderBookExportStatus;
		reason_code: string;
		reason_subcode: string | null;
		request_id: LowercaseUuid | null;
		target: PreparationTarget | null;
		selection_sha256: Sha256Hex | null;
		query_sha256: Sha256Hex | null;
		query_segments: CanonicalOrderBookExportQuerySegment[];
		promotion_receipt_ids: Sha256Hex[];
		artifacts: null | {
			levels: CanonicalOrderBookExportArtifact;
			summary: CanonicalOrderBookExportArtifact;
		};
		diagnostics: Record<string, string | number | boolean>;
	};
};

export type PreparationProductPinWire = {
	schema_id: typeof PREPARATION_PRODUCT_PIN_SCHEMA_ID;
	package: {
		name: "@usherlabs/cex-broker";
		version: string;
		registry_tarball_url: string;
		integrity: string;
		tarball_sha256: Sha256Hex;
		npm_git_head: string;
	};
	executables: Array<{
		product_id: PreparationProducerIdentity["product_id"];
		product_version: PreparationProducerIdentity["product_version"];
		relative_path: string;
		executable_sha256: Sha256Hex;
	}>;
	schema_manifest: {
		schema_id: typeof PREPARATION_SCHEMA_MANIFEST_V3_ID;
		manifest_sha256: Sha256Hex;
		relative_path: "dist/market-data-preparation/schema-manifest.json";
	};
	schema_pins: Array<{ schema_id: string; schema_sha256: Sha256Hex }>;
	capability_policy: { policy_id: string; policy_sha256: Sha256Hex };
	source_tape_capability: {
		policy_id: string;
		policy_sha256: Sha256Hex;
	};
	resource_policy: { policy_id: string; policy_sha256: Sha256Hex };
	preparation_library: {
		exported_subpath: "@usherlabs/cex-broker/market-data-preparation";
		runtime_entry_sha256: Sha256Hex;
		declaration_sha256: Sha256Hex;
		operations: [
			{
				symbol: "runMarketDataSourceTape";
				operation_id: "market-data-source-tape/v1";
			},
			{
				symbol: "runMarketDataRequiredClockQualification";
				operation_id: "market-data-required-clock-qualification/v1";
			},
		];
	};
};

type Codec<T> = {
	decode(value: unknown): T;
	is(value: unknown): value is T;
};

function describeAjvErrors(errors: ErrorObject[] | null | undefined): string {
	return (errors ?? [])
		.map(
			(error) =>
				`${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
		)
		.join("; ");
}

function codec<T>(
	validate: ValidateFunction,
	semantic?: (document: T) => void,
): Codec<T> {
	return {
		decode(value: unknown): T {
			if (!validate(value)) {
				throw new Error(
					`JSON Schema validation failed: ${describeAjvErrors(validate.errors)}`,
				);
			}
			semantic?.(value as T);
			return value as T;
		},
		is(value: unknown): value is T {
			if (!validate(value)) return false;
			try {
				semantic?.(value as T);
				return true;
			} catch {
				return false;
			}
		},
	};
}

function fixedTimestampMs(value: string, field: string): number {
	const parsed = Date.parse(value);
	if (
		!Number.isSafeInteger(parsed) ||
		new Date(parsed).toISOString() !== value
	) {
		throw new Error(`${field} is not a fixed UTC RFC3339 timestamp`);
	}
	return parsed;
}

function assertResultTiming(input: {
	started_at: string;
	completed_at: string;
}): void {
	if (
		fixedTimestampMs(input.completed_at, "completed_at") <
		fixedTimestampMs(input.started_at, "started_at")
	) {
		throw new Error("completed_at precedes started_at");
	}
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(archiveSelectionSchema);
ajv.addSchema(promotionReceiptSchema);

const validateBackfillResultV2 = ajv.compile(backfillResultV2Schema);
const validateExportRequest = ajv.compile(exportRequestSchema);
const validateExportResult = ajv.compile(exportResultSchema);
const validateProductPin = ajv.compile(productPinSchema);

export const backfillResultV2Codec = codec<BackfillJobResultV2Wire>(
	validateBackfillResultV2,
	(result) => {
		assertDocumentSha256(result, "result_sha256");
		assertResultTiming(result);
		if (
			result.capability_policy.policy_id !== CAPABILITY_POLICY.policy_id ||
			result.capability_policy.policy_sha256 !==
				CAPABILITY_POLICY.policy_sha256 ||
			result.resource_policy.policy_id !== RESOURCE_POLICY.policy_id ||
			result.resource_policy.policy_sha256 !== RESOURCE_POLICY.policy_sha256
		) {
			throw new Error("backfill result requires the current policy tuple");
		}
		if (
			result.schema_manifest_sha256 !==
			PREPARATION_SCHEMA_MANIFEST_V3.manifest_sha256
		) {
			throw new Error(
				"backfill result schema manifest identity is not current",
			);
		}
		if (result.outcome.selection) {
			archiveSelectionCodec.decode(result.outcome.selection);
		}
		if (result.outcome.receipt) {
			const receipt = promotionReceiptCodec.decode(result.outcome.receipt);
			if (!promotionReceiptMatchesCurrentPolicies(receipt)) {
				throw new Error("backfill result receipt is not current-qualified");
			}
			if (
				receipt.effective_policies.capability_policy.policy_id !==
					result.capability_policy.policy_id ||
				receipt.effective_policies.capability_policy.policy_sha256 !==
					result.capability_policy.policy_sha256 ||
				receipt.effective_policies.resource_policy.policy_id !==
					result.resource_policy.policy_id ||
				receipt.effective_policies.resource_policy.policy_sha256 !==
					result.resource_policy.policy_sha256
			) {
				throw new Error(
					"backfill result and receipt policy identities disagree",
				);
			}
		}
		if (
			result.outcome.status === "promoted" &&
			(!result.outcome.selection || !result.outcome.receipt)
		) {
			throw new Error("promoted outcome requires selection and receipt");
		}
		if (
			result.outcome.status === "already_covered" &&
			!result.outcome.selection
		) {
			throw new Error("already_covered outcome requires selection");
		}
		if (
			(result.outcome.status === "already_covered" ||
				result.outcome.status === "promoted") &&
			result.outcome.selection?.bundles.some(
				(bundle) => bundle.capture_origin === "vendor_historical_backfill",
			) &&
			!result.outcome.receipt
		) {
			throw new Error("successful vendor evidence requires a current receipt");
		}
		if (
			(result.outcome.status === "already_covered" ||
				result.outcome.status === "promoted") &&
			result.outcome.selection &&
			result.outcome.receipt
		) {
			const selectedVendorReceiptIds = new Set(
				result.outcome.selection.bundles
					.filter(
						(bundle) => bundle.capture_origin === "vendor_historical_backfill",
					)
					.map((bundle) => bundle.qualification?.receipt_id),
			);
			if (
				selectedVendorReceiptIds.size !== 1 ||
				!selectedVendorReceiptIds.has(result.outcome.receipt.receipt_id) ||
				result.outcome.selection.receipt_ids.length !== 1 ||
				result.outcome.selection.receipt_ids[0] !==
					result.outcome.receipt.receipt_id
			) {
				throw new Error(
					"successful vendor selection and current receipt lineage disagree",
				);
			}
		}
	},
);

export const canonicalOrderBookExportRequestCodec =
	codec<CanonicalOrderBookExportRequestWire>(
		validateExportRequest,
		(request) => {
			const selection = archiveSelectionCodec.decode(request.selection);
			if (
				selection.coverage_class !== "complete" ||
				selection.selected_intervals.length === 0
			) {
				throw new Error(
					"export requires a complete non-empty archive selection",
				);
			}
		},
	);

export const canonicalOrderBookExportResultCodec =
	codec<CanonicalOrderBookExportResultWire>(validateExportResult, (result) => {
		assertDocumentSha256(result, "result_sha256");
		assertResultTiming(result);
		const artifacts = result.outcome.artifacts;
		if (
			artifacts &&
			(artifacts.levels.projection_schema_id !==
				ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_ID ||
				artifacts.levels.projection_schema_sha256 !==
					ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256 ||
				artifacts.summary.projection_schema_id !==
					ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_ID ||
				artifacts.summary.projection_schema_sha256 !==
					ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256)
		) {
			throw new Error("export artifact projection identity is inconsistent");
		}
	});

export const preparationProductPinCodec = codec<PreparationProductPinWire>(
	validateProductPin,
	(pin) => {
		const expectedExecutables = new Map([
			[
				"market-data-vendor-backfill",
				{
					productVersion: "market-data-vendor-backfill/v1",
					relativePath: "dist/commands/market-data-vendor-backfill.js",
				},
			],
			[
				"cex-canonical-orderbook-export",
				{
					productVersion: "cex-canonical-orderbook-export/v2",
					relativePath: "dist/commands/cex-canonical-orderbook-export.js",
				},
			],
		] as const);
		if (pin.executables.length !== expectedExecutables.size) {
			throw new Error("product pin must identify both preparation executables");
		}
		for (const executable of pin.executables) {
			const expected = expectedExecutables.get(executable.product_id);
			if (
				!expected ||
				executable.product_version !== expected.productVersion ||
				executable.relative_path !== expected.relativePath
			) {
				throw new Error("product pin executable identity is inconsistent");
			}
			if (
				executable.relative_path.split(/[\\/]+/u).includes("..") ||
				executable.relative_path.startsWith("/")
			) {
				throw new Error("product pin executable path is unsafe");
			}
		}
		if (
			pin.schema_manifest.schema_id !==
				PREPARATION_SCHEMA_MANIFEST_V3.schema_id ||
			pin.schema_manifest.manifest_sha256 !==
				PREPARATION_SCHEMA_MANIFEST_V3.manifest_sha256
		) {
			throw new Error(
				"product pin schema manifest identity does not match the preparation manifest",
			);
		}
		const actualSchemas = pin.schema_pins
			.map(({ schema_id, schema_sha256 }) => `${schema_id}:${schema_sha256}`)
			.sort();
		const expectedSchemas = PREPARATION_SCHEMA_ARTIFACTS.map(
			({ schema_id, schema_sha256 }) => `${schema_id}:${schema_sha256}`,
		).sort();
		if (JSON.stringify(actualSchemas) !== JSON.stringify(expectedSchemas)) {
			throw new Error(
				"product pin schema identities do not match the preparation manifest",
			);
		}
		if (
			pin.capability_policy.policy_id !== CAPABILITY_POLICY.policy_id ||
			pin.capability_policy.policy_sha256 !== CAPABILITY_POLICY.policy_sha256 ||
			pin.source_tape_capability.policy_id !==
				SOURCE_TAPE_CAPABILITY.policy_id ||
			pin.source_tape_capability.policy_sha256 !==
				SOURCE_TAPE_CAPABILITY.policy_sha256 ||
			pin.resource_policy.policy_id !== RESOURCE_POLICY.policy_id ||
			pin.resource_policy.policy_sha256 !== RESOURCE_POLICY.policy_sha256
		) {
			throw new Error("product pin policy identities are inconsistent");
		}
		const expectedOperations = [
			{
				symbol: "runMarketDataSourceTape",
				operation_id: "market-data-source-tape/v1",
			},
			{
				symbol: "runMarketDataRequiredClockQualification",
				operation_id: "market-data-required-clock-qualification/v1",
			},
		];
		if (
			pin.preparation_library.exported_subpath !==
				"@usherlabs/cex-broker/market-data-preparation" ||
			JSON.stringify(pin.preparation_library.operations) !==
				JSON.stringify(expectedOperations)
		) {
			throw new Error("product pin preparation-library ABI is inconsistent");
		}
	},
);

export function finalizeBackfillResultV2(
	content: Omit<BackfillJobResultV2Wire, "result_sha256">,
): BackfillJobResultV2Wire {
	return backfillResultV2Codec.decode({
		...content,
		result_sha256: documentSha256(content, "result_sha256"),
	});
}

export function finalizeCanonicalOrderBookExportResult(
	content: Omit<CanonicalOrderBookExportResultWire, "result_sha256">,
): CanonicalOrderBookExportResultWire {
	return canonicalOrderBookExportResultCodec.decode({
		...content,
		result_sha256: documentSha256(content, "result_sha256"),
	});
}

const preparationSchemaArtifacts = [
	["schemas/backfill-request-v1.schema.json", requestSchema],
	["schemas/backfill-result-v2.schema.json", backfillResultV2Schema],
	["schemas/required-clock-v1.schema.json", requiredClockSchema],
	["schemas/archive-selection-v1.schema.json", archiveSelectionSchema],
	["schemas/promotion-receipt-v1.schema.json", promotionReceiptSchema],
	[
		"schemas/canonical-orderbook-export-request-v1.schema.json",
		exportRequestSchema,
	],
	[
		"schemas/canonical-orderbook-export-result-v2.schema.json",
		exportResultSchema,
	],
	["schemas/preparation-product-pin-v2.schema.json", productPinSchema],
	[
		"schemas/order-book-levels-parquet-projection-v1.schema.json",
		levelsProjectionSchema,
	],
	[
		"schemas/order-book-depth-summary-parquet-projection-v1.schema.json",
		depthSummaryProjectionSchema,
	],
	[
		"schemas/source-forensics-ledger-v1.schema.json",
		sourceForensicsLedgerSchema,
	],
	[
		"schemas/source-qualification-record-v1.schema.json",
		sourceQualificationRecordSchema,
	],
] as const;

export const PREPARATION_SCHEMA_ARTIFACTS = Object.freeze(
	preparationSchemaArtifacts.map(([path, schema]) =>
		Object.freeze({
			schema_id: schema.$id,
			path,
			schema_sha256: jcsSha256(schema),
			schema,
		}),
	),
);

const preparationSchemaManifestContent = {
	schema_id: PREPARATION_SCHEMA_MANIFEST_V3_ID,
	artifacts: PREPARATION_SCHEMA_ARTIFACTS.map(
		({ schema_id, path, schema_sha256 }) => ({
			schema_id,
			path,
			schema_sha256,
		}),
	),
};

export const PREPARATION_SCHEMA_MANIFEST_V3 = Object.freeze({
	...preparationSchemaManifestContent,
	manifest_sha256: jcsSha256(preparationSchemaManifestContent),
});

export const ORDER_BOOK_LEVELS_PARQUET_PROJECTION = Object.freeze(
	levelsProjectionSchema,
);
export const ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION = Object.freeze(
	depthSummaryProjectionSchema,
);
export const ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256 = jcsSha256(
	levelsProjectionSchema,
);
export const ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256 =
	jcsSha256(depthSummaryProjectionSchema);
