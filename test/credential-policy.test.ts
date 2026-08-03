import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import {
	CredentialPolicyConfigurationError,
	hasRequestCredentialMetadata,
	loadCredentialPermissionAttestationFromEnv,
	loadCredentialPolicyFromEnv,
	resolveCredentialSelection,
} from "../src/helpers/credential-policy";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";

const testPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

function registeredMethods(server: grpc.Server): string[] {
	const handlers = Reflect.get(server, "handlers") as Map<string, unknown>;
	return [...handlers.keys()].sort();
}

describe("credential-source policy", () => {
	test("preserves request metadata as the compatibility default", () => {
		expect(loadCredentialPolicyFromEnv({})).toEqual({
			sourcePolicy: "request_metadata_allowed",
			provisionedProfile: "public",
		});
	});

	test("requires closed source policies and profiles", () => {
		expect(
			loadCredentialPolicyFromEnv({
				CEX_BROKER_CREDENTIAL_SOURCE_POLICY: "provisioned_only",
				CEX_BROKER_PROVISIONED_CREDENTIAL_PROFILE: "read_only_key",
			}),
		).toEqual({
			sourcePolicy: "provisioned_only",
			provisionedProfile: "read_only_key",
		});
		expect(() =>
			loadCredentialPolicyFromEnv({
				CEX_BROKER_CREDENTIAL_SOURCE_POLICY: "anything",
			}),
		).toThrow(CredentialPolicyConfigurationError);
	});

	test("detects either request credential header without exposing values", () => {
		const metadata = new grpc.Metadata();
		metadata.set("api-key", "very-secret-key");
		expect(hasRequestCredentialMetadata(metadata)).toBe(true);
		expect(
			JSON.stringify(hasRequestCredentialMetadata(metadata)),
		).not.toContain("very-secret-key");
	});

	test("read_only_key never falls back to public construction", () => {
		expect(() =>
			resolveCredentialSelection({
				policy: {
					sourcePolicy: "provisioned_only",
					provisionedProfile: "read_only_key",
				},
				selectedProvisionedBroker: undefined,
				publicOperation: true,
			}),
		).toThrow("provisioned read_only_key");
	});

	test("public profile is limited to public market-data operations", () => {
		expect(
			resolveCredentialSelection({
				policy: {
					sourcePolicy: "provisioned_only",
					provisionedProfile: "public",
				},
				selectedProvisionedBroker: undefined,
				publicOperation: true,
			}),
		).toEqual({ mode: "public" });
		expect(() =>
			resolveCredentialSelection({
				policy: {
					sourcePolicy: "provisioned_only",
					provisionedProfile: "public",
				},
				selectedProvisionedBroker: undefined,
				publicOperation: false,
			}),
		).toThrow("public market-data");
	});

	test("deployment attestation is non-destructive and explicit for read-only keys", () => {
		expect(
			loadCredentialPermissionAttestationFromEnv(
				{},
				{
					sourcePolicy: "provisioned_only",
					provisionedProfile: "public",
				},
			),
		).toEqual({
			kind: "public_no_credentials",
			reference: "profile:public",
		});
		expect(
			loadCredentialPermissionAttestationFromEnv(
				{
					CEX_BROKER_CREDENTIAL_ATTESTATION_KIND:
						"operator_provisioning_record",
					CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE:
						"vault-policy/read-broker-2026-08-03",
				},
				{
					sourcePolicy: "provisioned_only",
					provisionedProfile: "read_only_key",
				},
			),
		).toEqual({
			kind: "operator_provisioning_record",
			reference: "vault-policy/read-broker-2026-08-03",
		});
		expect(() =>
			loadCredentialPermissionAttestationFromEnv(
				{},
				{
					sourcePolicy: "provisioned_only",
					provisionedProfile: "read_only_key",
				},
			),
		).toThrow("attestation");
		expect(() =>
			loadCredentialPermissionAttestationFromEnv(
				{
					CEX_BROKER_CREDENTIAL_ATTESTATION_KIND: "placed_test_order",
					CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE: "order-1",
				},
				{
					sourcePolicy: "provisioned_only",
					provisionedProfile: "read_only_key",
				},
			),
		).toThrow("exchange_permission_api or operator_provisioning_record");
	});

	test("credential/archive posture never changes the full registered RPC surface", () => {
		const compatibility = getServer(
			testPolicy,
			{},
			["*"],
			false,
			"",
			undefined,
		);
		const provisionedOnly = getServer(
			testPolicy,
			{},
			["*"],
			false,
			"",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				sourcePolicy: "provisioned_only",
				provisionedProfile: "read_only_key",
			},
		);
		try {
			expect(registeredMethods(provisionedOnly)).toEqual(
				registeredMethods(compatibility),
			);
			expect(registeredMethods(provisionedOnly)).toEqual([
				"/cex_broker.cex_service/ExecuteAction",
				"/cex_broker.cex_service/Subscribe",
			]);
		} finally {
			compatibility.forceShutdown();
			provisionedOnly.forceShutdown();
		}
	});
});
