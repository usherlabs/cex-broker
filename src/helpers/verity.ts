import type { Metadata } from "@grpc/grpc-js";
import { VerityClient, type VerityResponse } from "@usherlabs/verity-client";
import type { Exchange } from "ccxt";
import { CCXT_METHODS_WITH_VERITY } from "./constants";
import { VERITY_REQUEST_METHODS } from "./verity-request-methods";

/** A REST request as ccxt hands it to the exchange's fetch implementation. */
export type ExchangeRequest = {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string;
	timeout: number;
};

/** Sends an exchange request through the Verity prover and returns the venue's response. */
export type VerityTransport = (request: ExchangeRequest) => Promise<Response>;

// ccxt calls a user-supplied fetchImplementation as fetch(url, init) and also
// passes node-style `timeout`/`agent` options, which the platform fetch ignores.
type CcxtFetchInit = {
	method: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
};

/** The ccxt method that sends `url` on `exchangeId`, or "" when no prefix matches. */
export function ccxtMethodForRequest(exchangeId: string, url: string): string {
	const path = url.split("?")[0] ?? url;
	const prefixes = VERITY_REQUEST_METHODS[exchangeId] ?? {};
	for (const [prefix, method] of Object.entries(prefixes)) {
		if (path.startsWith(prefix)) return method;
	}
	return "";
}

export function isVerityRequest(
	exchangeId: string,
	method: string,
	url: string,
): boolean {
	return (
		["get", "post"].includes(method.toLowerCase()) &&
		CCXT_METHODS_WITH_VERITY.includes(ccxtMethodForRequest(exchangeId, url))
	);
}

/**
 * Sets the REST transport of a ccxt exchange instance. With a Verity transport,
 * requests sent by Verity-proved methods go through it; every other request
 * uses the platform fetch.
 *
 * ccxt resolves its fetch implementation once per instance, and on Node it
 * bypasses a fetchImplementation assigned after its native client loaded.
 * Call this before the instance's first request (see applyCommonExchangeConfig)
 * and again whenever the Verity transport changes.
 */
export function setExchangeTransport(
	exchange: Exchange,
	verity?: VerityTransport,
): void {
	exchange.fetchImplementation = (url: string, init: CcxtFetchInit) => {
		if (verity && isVerityRequest(exchange.id, init.method, url)) {
			return verity({
				url,
				method: init.method,
				headers: init.headers,
				body: init.body,
				timeout: exchange.timeout,
			});
		}
		return fetch(url, {
			method: init.method,
			headers: init.headers,
			body: init.body,
			signal: init.signal,
			// Exchange REST APIs do not redirect legitimately; ccxt's native fetch
			// path refuses redirects too.
			redirect: "error",
		});
	};
}

export function toFetchResponse(response: VerityResponse<unknown>): Response {
	const headers = new Headers();
	for (const [name, value] of Object.entries(response.headers ?? {})) {
		if (value === undefined || value === null) continue;
		headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
	}
	const body =
		typeof response.data === "string"
			? response.data
			: JSON.stringify(response.data);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function createVerityTransport(
	verityProverUrl: string,
	redact: string,
	proofTimeout: number,
	onProofCallback: (proof: string, notaryPubKey?: string) => void,
): VerityTransport {
	const client = new VerityClient({ proverUrl: verityProverUrl });
	return async ({ url, method, headers, body, timeout }) => {
		// VerityClient sends `config.method` and `config.data` as given; `get`
		// only supplies the default method.
		let pending = client.get(
			url,
			{
				method: method.toLowerCase(),
				headers,
				data: body,
				timeout,
				validateStatus: () => true,
			},
			{ proofTimeout },
		);
		if (redact) {
			pending = pending.redact(redact);
		}
		const response = await pending;
		if (response.proof) {
			onProofCallback(response.proof, response.notary_pub_key);
		}
		return toFetchResponse(response);
	};
}

export function buildVerityTransportFromMetadata(
	metadata: Metadata,
	verityProverUrl: string,
	onProofCallback: (proof: string, notaryPubKey?: string) => void,
): VerityTransport {
	const redact = metadata.get("verity-t-redacted")?.[0]?.toString() || "";
	const rawTimeout = metadata.get("verity-proof-timeout")?.[0]?.toString();
	const proofTimeout = rawTimeout ? parseInt(rawTimeout, 10) : 5 * 60 * 1000; // default 5 minutes
	return createVerityTransport(
		verityProverUrl,
		redact,
		proofTimeout,
		onProofCallback,
	);
}
