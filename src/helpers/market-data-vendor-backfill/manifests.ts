import { documentSha256, jcsSha256 } from "./identity";
import capabilityPolicyDocument from "./policies/capability-policy-v3.json" with {
	type: "json",
};
import resourcePolicyDocument from "./policies/resource-policy-v2.json" with {
	type: "json",
};

export const CAPABILITY_POLICY_ID =
	"market-data-vendor-backfill-capabilities/v3" as const;
export const RESOURCE_POLICY_ID =
	"market-data-vendor-backfill-resources/v2" as const;
export const ADAPTER_POLICY_ID = "cryptohftdata-orderbook-adapter/v1" as const;
export const ACQUISITION_POLICY_ID =
	"cryptohftdata-hourly-acquisition/v2" as const;

const {
	policy_sha256: declaredCapabilityPolicySha256,
	...capabilityPolicyContent
} = capabilityPolicyDocument;
if (
	capabilityPolicyContent.policy_id !== CAPABILITY_POLICY_ID ||
	jcsSha256(capabilityPolicyContent) !== declaredCapabilityPolicySha256
) {
	throw new Error("current capability policy asset identity is invalid");
}

export const CAPABILITY_POLICY = Object.freeze({
	...capabilityPolicyContent,
	policy_id: CAPABILITY_POLICY_ID,
	policy_sha256: declaredCapabilityPolicySha256,
});

const {
	policy_sha256: declaredResourcePolicySha256,
	...resourcePolicyContent
} = resourcePolicyDocument;
if (
	resourcePolicyContent.policy_id !== RESOURCE_POLICY_ID ||
	jcsSha256(resourcePolicyContent) !== declaredResourcePolicySha256
) {
	throw new Error("current resource policy asset identity is invalid");
}

export const RESOURCE_POLICY = Object.freeze({
	...resourcePolicyContent,
	policy_id: RESOURCE_POLICY_ID,
	policy_sha256: declaredResourcePolicySha256,
});

export const EFFECTIVE_ADAPTER_POLICY_PIN = Object.freeze({
	policy_id: ADAPTER_POLICY_ID,
	policy_sha256: jcsSha256(capabilityPolicyContent.adapter_policy),
});

export const EFFECTIVE_ACQUISITION_POLICY_PIN = Object.freeze({
	policy_id: ACQUISITION_POLICY_ID,
	policy_sha256: jcsSha256(capabilityPolicyContent.acquisition_policy),
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
