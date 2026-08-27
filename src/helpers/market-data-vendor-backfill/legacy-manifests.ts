/**
 * Historical v1/v2 policy and manifest identities.
 *
 * This module is deliberately disconnected from current executables and public
 * package entry points. It exists only for immutable historical-evidence tests.
 */
import { jcsSha256 } from "./identity";
import legacyCapabilityPolicy from "./policies/capability-policy.json" with {
	type: "json",
};
import previousCapabilityPolicy from "./policies/capability-policy-v2.json" with {
	type: "json",
};
import legacyResourcePolicy from "./policies/resource-policy.json" with {
	type: "json",
};
import archiveSelectionSchema from "./schemas/archive-selection.schema.json" with {
	type: "json",
};
import promotionReceiptSchema from "./schemas/promotion-receipt.schema.json" with {
	type: "json",
};
import requestSchema from "./schemas/request.schema.json" with { type: "json" };
import requiredClockSchema from "./schemas/required-clock.schema.json" with {
	type: "json",
};
import resultSchema from "./schemas/result.schema.json" with { type: "json" };

export const LEGACY_CAPABILITY_POLICY = Object.freeze(legacyCapabilityPolicy);
export const PREVIOUS_CAPABILITY_POLICY = Object.freeze(
	previousCapabilityPolicy,
);
export const LEGACY_RESOURCE_POLICY = Object.freeze(legacyResourcePolicy);

const schemaArtifacts = [
	["schemas/request.schema.json", requestSchema],
	["schemas/result.schema.json", resultSchema],
	["schemas/required-clock.schema.json", requiredClockSchema],
	["schemas/archive-selection.schema.json", archiveSelectionSchema],
	["schemas/promotion-receipt.schema.json", promotionReceiptSchema],
] as const;

export const SCHEMA_ARTIFACTS = Object.freeze(
	schemaArtifacts.map(([path, schema]) =>
		Object.freeze({
			schema_id: schema.$id,
			path,
			schema_sha256: jcsSha256(schema),
			schema,
		}),
	),
);

const schemaManifestContent = {
	schema_id:
		"https://schemas.usher.so/market-data-vendor-backfill-schema-manifest/v1",
	artifacts: SCHEMA_ARTIFACTS.map(({ schema_id, path, schema_sha256 }) => ({
		schema_id,
		path,
		schema_sha256,
	})),
};

export const SCHEMA_MANIFEST = Object.freeze({
	...schemaManifestContent,
	manifest_sha256: jcsSha256(schemaManifestContent),
});
