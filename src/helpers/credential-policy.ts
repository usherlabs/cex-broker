import type { Metadata } from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";

export const CREDENTIAL_SOURCE_POLICIES = [
	"provisioned_only",
	"request_metadata_allowed",
] as const;
export const PROVISIONED_CREDENTIAL_PROFILES = [
	"public",
	"read_only_key",
] as const;
export const CREDENTIAL_ATTESTATION_KINDS = [
	"exchange_permission_api",
	"operator_provisioning_record",
] as const;

export type CredentialSourcePolicy =
	(typeof CREDENTIAL_SOURCE_POLICIES)[number];
export type ProvisionedCredentialProfile =
	(typeof PROVISIONED_CREDENTIAL_PROFILES)[number];
export type CredentialAttestationKind =
	(typeof CREDENTIAL_ATTESTATION_KINDS)[number];
export type CredentialPermissionAttestation =
	| { kind: "public_no_credentials"; reference: "profile:public" }
	| { kind: CredentialAttestationKind; reference: string };
export type CredentialPolicy = {
	sourcePolicy: CredentialSourcePolicy;
	provisionedProfile: ProvisionedCredentialProfile;
};

export class CredentialPolicyConfigurationError extends Error {
	readonly kind:
		| "invalid_configuration"
		| "missing_provisioned_broker"
		| "operation_not_public";

	constructor(
		message: string,
		kind: CredentialPolicyConfigurationError["kind"] = "invalid_configuration",
	) {
		super(message);
		this.name = "CredentialPolicyConfigurationError";
		this.kind = kind;
	}
}

export function loadCredentialPolicyFromEnv(
	env: Record<string, string | undefined> = process.env,
): CredentialPolicy {
	const sourcePolicy =
		env.CEX_BROKER_CREDENTIAL_SOURCE_POLICY?.trim() ||
		"request_metadata_allowed";
	const provisionedProfile =
		env.CEX_BROKER_PROVISIONED_CREDENTIAL_PROFILE?.trim() || "public";
	if (
		!(CREDENTIAL_SOURCE_POLICIES as readonly string[]).includes(sourcePolicy)
	) {
		throw new CredentialPolicyConfigurationError(
			"CEX_BROKER_CREDENTIAL_SOURCE_POLICY must be provisioned_only or request_metadata_allowed",
		);
	}
	if (
		!(PROVISIONED_CREDENTIAL_PROFILES as readonly string[]).includes(
			provisionedProfile,
		)
	) {
		throw new CredentialPolicyConfigurationError(
			"CEX_BROKER_PROVISIONED_CREDENTIAL_PROFILE must be public or read_only_key",
		);
	}
	return {
		sourcePolicy: sourcePolicy as CredentialSourcePolicy,
		provisionedProfile: provisionedProfile as ProvisionedCredentialProfile,
	};
}

export function hasRequestCredentialMetadata(metadata: Metadata): boolean {
	return (
		metadata.get("api-key").length > 0 || metadata.get("api-secret").length > 0
	);
}

export function loadCredentialPermissionAttestationFromEnv(
	env: Record<string, string | undefined>,
	policy: CredentialPolicy,
): CredentialPermissionAttestation {
	if (policy.sourcePolicy !== "provisioned_only") {
		throw new CredentialPolicyConfigurationError(
			"Read-only deployment validation requires provisioned_only credential policy",
		);
	}
	if (policy.provisionedProfile === "public") {
		return { kind: "public_no_credentials", reference: "profile:public" };
	}
	const kind = env.CEX_BROKER_CREDENTIAL_ATTESTATION_KIND?.trim();
	const reference = env.CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE?.trim();
	if (
		!(CREDENTIAL_ATTESTATION_KINDS as readonly string[]).includes(kind ?? "")
	) {
		throw new CredentialPolicyConfigurationError(
			"Credential permission attestation kind must be exchange_permission_api or operator_provisioning_record",
		);
	}
	if (!reference) {
		throw new CredentialPolicyConfigurationError(
			"CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE is required for a read_only_key attestation",
		);
	}
	return { kind: kind as CredentialAttestationKind, reference };
}

export type CredentialSelection =
	| { mode: "request_metadata_allowed" }
	| { mode: "public" }
	| { mode: "provisioned"; broker: Exchange };

export function resolveCredentialSelection(input: {
	policy: CredentialPolicy;
	selectedProvisionedBroker?: Exchange;
	publicOperation: boolean;
}): CredentialSelection {
	if (input.policy.sourcePolicy === "request_metadata_allowed") {
		return { mode: "request_metadata_allowed" };
	}
	if (input.policy.provisionedProfile === "public") {
		if (!input.publicOperation) {
			throw new CredentialPolicyConfigurationError(
				"The public credential profile is limited to public market-data operations",
				"operation_not_public",
			);
		}
		return { mode: "public" };
	}
	if (!input.selectedProvisionedBroker) {
		throw new CredentialPolicyConfigurationError(
			"The provisioned read_only_key profile has no valid provisioned broker credentials",
			"missing_provisioned_broker",
		);
	}
	return { mode: "provisioned", broker: input.selectedProvisionedBroker };
}
