#!/usr/bin/env bun
import { resolveArchiveSourceFromEnv } from "../src/helpers/broker-execution-archive/writer";
import {
	loadCredentialPermissionAttestationFromEnv,
	loadCredentialPolicyFromEnv,
} from "../src/helpers/credential-policy";

const policy = loadCredentialPolicyFromEnv();
if (resolveArchiveSourceFromEnv() !== "broker_read") {
	throw new Error(
		"Read-only market-data deployment check requires CEX_BROKER_ARCHIVE_SOURCE=broker_read",
	);
}
const attestation = loadCredentialPermissionAttestationFromEnv(
	process.env,
	policy,
);

console.info(
	JSON.stringify(
		{
			status: "configuration_valid",
			archive_source: "broker_read",
			credential_source_policy: policy.sourcePolicy,
			provisioned_profile: policy.provisionedProfile,
			permission_attestation: attestation,
			request_credential_metadata: "rejected_before_exchange_construction",
			validation_operations: [
				"capability_read",
				"current_snapshot_read",
				"market_subscription_read",
			],
			prohibited_validation_operations: [
				"place_order",
				"cancel_order",
				"internal_transfer",
				"deposit",
				"withdraw",
			],
		},
		null,
		2,
	),
);
