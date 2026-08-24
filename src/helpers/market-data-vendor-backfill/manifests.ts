import { documentSha256, jcsSha256 } from "./identity";
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

export const LEGACY_CAPABILITY_POLICY_ID =
	"market-data-vendor-backfill-capabilities/v1" as const;
export const CAPABILITY_POLICY_ID =
	"market-data-vendor-backfill-capabilities/v2" as const;
export const LEGACY_RESOURCE_POLICY_ID =
	"market-data-vendor-backfill-resources/v1" as const;
export const RESOURCE_POLICY_ID =
	"market-data-vendor-backfill-resources/v2" as const;
export const ADAPTER_POLICY_ID = "cryptohftdata-orderbook-adapter/v1" as const;
export const ACQUISITION_POLICY_ID =
	"cryptohftdata-hourly-acquisition/v1" as const;

const legacyCapabilityPolicyContent = {
	policy_id: LEGACY_CAPABILITY_POLICY_ID,
	provider: "cryptohftdata",
	adapter_policy: {
		policy_id: ADAPTER_POLICY_ID,
		adapter_version: "cryptohftdata-orderbook/v2",
	},
	acquisition_policy: {
		policy_id: ACQUISITION_POLICY_ID,
		object_granularity: "utc_hour",
		authentication: "bearer",
		initialization_lookback_ms: 0,
	},
	profiles: [
		{
			exchange: "okx",
			market_type: "spot",
			feed: "ORDERBOOK",
			canonical_trading_pair: "ARB-USDT",
			provider_exchange_id: "okx_spot",
			resolved_symbol: "ARB-USDT",
			construction_modes: ["sampled_top_n_snapshot"],
			source_policies: ["authoritative_window"],
			max_depth: 400,
		},
	],
} as const;

export const LEGACY_CAPABILITY_POLICY = Object.freeze({
	...legacyCapabilityPolicyContent,
	policy_sha256: jcsSha256(legacyCapabilityPolicyContent),
});

const capabilityPolicyContent = {
	...legacyCapabilityPolicyContent,
	policy_id: CAPABILITY_POLICY_ID,
	profiles: [
		...legacyCapabilityPolicyContent.profiles.map((profile) => ({
			...profile,
			source_policies: ["authoritative_window", "fill_gaps"] as const,
		})),
		{
			exchange: "okx",
			market_type: "spot",
			feed: "ORDERBOOK",
			canonical_trading_pair: "ARB-USDC",
			provider_exchange_id: "okx_spot",
			resolved_symbol: "ARB-USDC",
			construction_modes: ["sampled_top_n_snapshot"],
			source_policies: ["authoritative_window", "fill_gaps"],
			max_depth: 400,
		},
	],
} as const;

export const CAPABILITY_POLICY = Object.freeze({
	...capabilityPolicyContent,
	policy_sha256: jcsSha256(capabilityPolicyContent),
});

const legacyResourcePolicyContent = {
	policy_id: LEGACY_RESOURCE_POLICY_ID,
	limits: {
		max_files: 10_000,
		max_bytes: 100 * 1024 * 1024 * 1024,
		max_rows: 1_000_000_000,
		max_duration_ms: 24 * 60 * 60 * 1_000,
		max_boundary_lookback_ms: 7 * 24 * 60 * 60 * 1_000,
	},
	request_bounds: {
		max_depth: 500,
		max_window_ms: 7 * 24 * 60 * 60 * 1_000,
		max_required_events: 100_000,
	},
} as const;

export const LEGACY_RESOURCE_POLICY = Object.freeze({
	...legacyResourcePolicyContent,
	policy_sha256: jcsSha256(legacyResourcePolicyContent),
});

const resourcePolicyContent = {
	...legacyResourcePolicyContent,
	policy_id: RESOURCE_POLICY_ID,
	request_bounds: {
		...legacyResourcePolicyContent.request_bounds,
		max_window_ms: 31 * 24 * 60 * 60 * 1_000,
	},
} as const;

export const RESOURCE_POLICY = Object.freeze({
	...resourcePolicyContent,
	policy_sha256: jcsSha256(resourcePolicyContent),
});

export const EFFECTIVE_ADAPTER_POLICY_PIN = Object.freeze({
	policy_id: ADAPTER_POLICY_ID,
	policy_sha256: jcsSha256(legacyCapabilityPolicyContent.adapter_policy),
});

export const EFFECTIVE_ACQUISITION_POLICY_PIN = Object.freeze({
	policy_id: ACQUISITION_POLICY_ID,
	policy_sha256: jcsSha256(legacyCapabilityPolicyContent.acquisition_policy),
});

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

export type PolicyPin = {
	policy_id: string;
	policy_sha256: string;
};

export function assertPolicyDocumentIdentity(
	policy: Record<string, unknown> & { policy_sha256: string },
): void {
	if (documentSha256(policy, "policy_sha256") !== policy.policy_sha256) {
		throw new Error("policy_sha256 does not match RFC 8785 policy content");
	}
}
