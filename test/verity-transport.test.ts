import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Exchange } from "ccxt";
import { createBroker } from "../src/helpers/broker";
import {
	createVerityTransport,
	type ExchangeRequest,
	setExchangeTransport,
} from "../src/helpers/verity";

type Stubbable = Record<string, unknown>;

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function createMexc(): Exchange {
	const exchange = createBroker("mexc", { apiKey: "k", apiSecret: "s" });
	if (!exchange) throw new Error("mexc broker was not created");
	(exchange as unknown as Stubbable).loadMarkets = async () => ({});
	return exchange;
}

describe("exchange REST transport", () => {
	test("sends requests of Verity-proved methods through the Verity transport", async () => {
		const exchange = createMexc();
		const proved: ExchangeRequest[] = [];
		setExchangeTransport(exchange, async (request) => {
			proved.push(request);
			return Response.json({
				balances: [{ asset: "USDC", free: "12.5", locked: "0.5" }],
			});
		});
		globalThis.fetch = (async () => {
			throw new Error("platform fetch must not carry a proved request");
		}) as unknown as typeof fetch;

		const balance = await exchange.fetchBalance();

		expect(balance.USDC).toEqual({ free: 12.5, used: 0.5, total: 13 });
		expect(proved).toHaveLength(1);
		expect(proved[0]?.method).toBe("GET");
		expect(proved[0]?.url).toStartWith("https://api.mexc.com/api/v3/account?");
		expect(proved[0]?.headers?.["X-MEXC-APIKEY"]).toBe("k");
	});

	test("sends other requests through the platform fetch without Verity", async () => {
		const exchange = createMexc();
		setExchangeTransport(exchange, async () => {
			throw new Error("the Verity transport must not carry a public request");
		});
		const platform: { url: string; init: RequestInit }[] = [];
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			platform.push({ url, init });
			return Response.json({ serverTime: 1700000000000 });
		}) as unknown as typeof fetch;

		expect(await exchange.fetchTime()).toBe(1700000000000);
		expect(platform).toHaveLength(1);
		expect(platform[0]?.url).toBe("https://api.mexc.com/api/v3/time");
		expect(platform[0]?.init.method).toBe("GET");
		expect(platform[0]?.init.redirect).toBe("error");
	});
});

type ProxiedRequest = {
	method: string | undefined;
	proxyUrl: string | undefined;
	redacted: string | undefined;
	venueHeader: string | undefined;
	body: string;
};

async function startProver() {
	const proofStreams = new Map<string, import("node:http").ServerResponse>();
	const proxied: ProxiedRequest[] = [];
	const readBody = (request: IncomingMessage) =>
		new Promise<string>((resolve) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => resolve(body));
		});
	const server = createServer(async (request, response) => {
		const url = request.url ?? "";
		if (url.startsWith("/proof/")) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.flushHeaders();
			proofStreams.set(url.slice("/proof/".length), response);
			return;
		}
		if (url === "/proxy") {
			const header = (name: string) => request.headers[name]?.toString();
			proxied.push({
				method: request.method,
				proxyUrl: header("t-proxy-url"),
				redacted: header("t-redacted"),
				venueHeader: header("x-mbx-apikey"),
				body: await readBody(request),
			});
			const requestId = header("t-request-id") ?? "";
			proofStreams.get(requestId)?.end("data: notary-key|venue-proof\n\n");
			proofStreams.delete(requestId);
			response.writeHead(418, {
				"Content-Type": "application/json",
				"X-Venue": "fixture",
			});
			response.end(JSON.stringify({ code: -4104, msg: "travel rule" }));
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		proxied,
		close: () =>
			new Promise<void>((resolve) => {
				for (const stream of proofStreams.values()) stream.end();
				server.close(() => resolve());
			}),
	};
}

describe("createVerityTransport", () => {
	test("forwards the venue request through the prover and returns the venue response", async () => {
		const prover = await startProver();
		try {
			const proofs: [string, string | undefined][] = [];
			const transport = createVerityTransport(
				prover.url,
				"secret-field",
				2000,
				(proof, notaryPubKey) => proofs.push([proof, notaryPubKey]),
			);

			const response = await transport({
				url: "https://api.binance.com/sapi/v1/capital/withdraw/apply",
				method: "POST",
				headers: { "X-MBX-APIKEY": "k" },
				body: "coin=USDC&amount=1&signature=abc",
				timeout: 2000,
			});

			expect(prover.proxied).toEqual([
				{
					method: "POST",
					proxyUrl: "https://api.binance.com/sapi/v1/capital/withdraw/apply",
					redacted: "secret-field",
					venueHeader: "k",
					body: "coin=USDC&amount=1&signature=abc",
				},
			]);
			expect(proofs).toEqual([["venue-proof", "notary-key"]]);
			expect(response.status).toBe(418);
			expect(response.headers.get("x-venue")).toBe("fixture");
			expect(await response.json()).toEqual({
				code: -4104,
				msg: "travel rule",
			});
		} finally {
			await prover.close();
		}
	});
});
