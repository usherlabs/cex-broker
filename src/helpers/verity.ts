import type { Metadata } from "@grpc/grpc-js";
import type {
	HttpClientOverride,
	HttpOverridePredicate,
} from "@usherlabs/ccxt";
import { VerityClient } from "@usherlabs/verity-client";
import { CCXT_METHODS_WITH_VERITY } from "./constants";

export function createVerityHttpClientOverride(
	verityProverUrl: string,
	onProofCallback: (proof: string, notaryPubKey?: string) => void,
) {
	const client = new VerityClient({ proverUrl: verityProverUrl });
	return (redact: string, proofTimeout: number): HttpClientOverride =>
		async ({ url, config }) => {
			// { method, url, config, data, meta }
			let pending = client.get(url, config, { proofTimeout });
			if (redact) {
				pending = pending.redact(redact || "");
			}
			const response = await pending;
			if (response.proof) {
				onProofCallback(response.proof, response.notary_pub_key);
			}
			return response;
		};
}

export function buildHttpClientOverrideFromMetadata(
	metadata: Metadata,
	verityProverUrl: string,
	onProofCallback: (proof: string, notaryPubKey?: string) => void,
): HttpClientOverride {
	const redact = metadata.get("verity-t-redacted")?.[0]?.toString() || "";
	const rawTimeout = metadata.get("verity-proof-timeout")?.[0]?.toString();
	const proofTimeout = rawTimeout ? parseInt(rawTimeout, 10) : 5 * 60 * 1000; // default 5 minutes
	const factory = createVerityHttpClientOverride(
		verityProverUrl,
		onProofCallback,
	);
	return factory(redact, proofTimeout);
}

export const verityHttpClientOverridePredicate: HttpOverridePredicate = ({
	method,
	methodCalled,
}) => {
	return (
		["get", "post"].includes(method.toLowerCase()) &&
		CCXT_METHODS_WITH_VERITY.includes(methodCalled)
	);
};
