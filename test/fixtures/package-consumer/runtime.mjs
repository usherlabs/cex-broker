import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import protobuf from "protobufjs";

// Tests never inherit operator credentials, archive endpoints or telemetry.
for (const key of Object.keys(process.env)) {
	if (key.startsWith("CEX_BROKER_") || key.startsWith("OTEL_")) delete process.env[key];
}
const output = [];
const originalConsole = {};
for (const method of ["log", "info", "warn", "error", "debug"]) {
	originalConsole[method] = console[method];
	console[method] = (...args) => output.push(args.join(" "));
}
const { default: CEXBroker, Action, BatchResponseEnvelopeSchema, MAX_BATCH_REQUEST_BYTES } =
	await import("@usherlabs/cex-broker");
const { default: descriptor } = await import("@usherlabs/cex-broker/proto/node.descriptor");
const protoPath = fileURLToPath(import.meta.resolve("@usherlabs/cex-broker/proto/node.proto"));
assert.deepEqual((await protobuf.load(protoPath)).toJSON(), descriptor);

const streams = new Map();
const prover = createServer((request, response) => {
	if (request.url.startsWith("/proof/")) {
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.flushHeaders();
		streams.set(request.url.slice("/proof/".length), response);
	} else if (request.url === "/proxy") {
		const stream = streams.get(request.headers["t-request-id"]);
		assert(stream, "proof subscription must precede proxy request");
		stream.end("data: fixture-notary|fixture-child-proof\n\n");
		streams.delete(request.headers["t-request-id"]);
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ last: 1 }));
	} else {
		response.writeHead(404).end();
	}
});
await new Promise((resolve) => prover.listen(0, "127.0.0.1", resolve));
const fakeKey = "fixture-not-a-real-api-key";
const fakeSecret = "fixture-not-a-real-api-secret";
const calls = [];
function exchange(account) {
	let override;
	const markets = Object.fromEntries(["USDC", "USDT"].map((quote) => [
		`ARB/${quote}`, {
			id: `ARB${quote}`, symbol: `ARB/${quote}`, base: "ARB", quote,
			type: "spot", spot: true, active: true, precision: { price: 0.0001, amount: 0.01 },
			limits: { amount: { min: 0.1 }, price: {}, cost: { min: 1 } },
		},
	]));
	return {
		id: "mexc", apiKey: fakeKey, secret: fakeSecret, precisionMode: 4,
		has: { fetchTradingFee: true }, markets,
		loadMarkets: async () => markets,
		market: (symbol) => markets[symbol],
		fetchTradingFee: async (symbol) => {
			calls.push(`${account}:fees:${symbol}`);
			return { symbol, maker: "0", taker: symbol === "ARB/USDC" ? "0" : "0.0005",
				info: { makerCommission: "0", apiKey: fakeKey, secret: fakeSecret } };
		},
		fetchCurrencies: async () => {
			calls.push(`${account}:currency`);
			return { USDC: { code: "USDC", networks: { BSC: {
				id: "BSC", network: "BSC", deposit: true, withdraw: true, fee: "0.25",
				limits: { withdraw: { min: "1", max: "50000" } },
			} } } };
		},
		setHttpClientOverride: (value) => { override = value; },
		fetchTicker: async (symbol) => {
			calls.push(`${account}:ticker:${symbol}`);
			if (symbol === "fail") throw new Error(`AuthenticationError: ${fakeKey} ${fakeSecret}`);
			if (symbol === "proof") await override({
				url: "https://fixture.invalid/ticker", config: {}, method: "get", methodCalled: "fetchTicker",
			});
			return { symbol, last: 1 };
		},
	};
}
const broker = new CEXBroker({}, {
	withdraw: { rule: [] }, deposit: {}, order: { rule: { markets: [], limits: [] } },
}, { useVerity: true, verityProverUrl: `http://127.0.0.1:${prover.address().port}` });
// Existing runtime property only: no package export or production test seam.
const pool = { primary: { exchange: exchange("primary"), label: "primary" },
	secondaryBrokers: [{ exchange: exchange("secondary:1"), label: "secondary:1", index: 1 }] };
const brokers = broker.brokers;
const originalBind = grpc.Server.prototype.bindAsync;
let bound;
const ready = new Promise((resolve, reject) => {
	grpc.Server.prototype.bindAsync = function (_address, credentials, callback) {
		return originalBind.call(this, "127.0.0.1:0", credentials, (error, port) => {
			callback(error, port);
			if (error) reject(error); else { bound = port; resolve(); }
		});
	};
});
let client;
try {
	await broker.run();
	await ready;
	// Empty-account startup avoids enabling archive/user-stream services. Handlers retain this map.
	brokers.mexc = pool;
	grpc.Server.prototype.bindAsync = originalBind;
	const definition = loader.loadSync(protoPath, { enums: Number, longs: String, defaults: true });
	const service = grpc.loadPackageDefinition(definition).cex_broker.cex_service;
	client = new service(`127.0.0.1:${bound}`, grpc.credentials.createInsecure());
	const metadata = new grpc.Metadata();
	metadata.set("use-secondary-key", "1");
	metadata.set("verity-proof-timeout", "2000");
	const execute = (request) => new Promise((resolve, reject) => client.ExecuteAction(
		request, metadata, { deadline: Date.now() + 5000 }, (error, response) => error ? reject(error) : resolve(response),
	));
	const child = (id, action, symbol, payload = {}) => ({ id, action, symbol, payload });
	const request = (children) => ({ action: Action.Batch, cex: "mexc", payload: { requests: JSON.stringify(children) } });
	const evidence = await execute(request([
		child("fees-usdc", Action.FetchFees, "ARB/USDC"), child("fees-usdt", Action.FetchFees, "ARB/USDT"),
		child("rules", Action.FetchMarketRules, "ARB/USDC"), child("network", Action.FetchCurrency, "USDC", { network: "BSC" }),
	]));
	writeFileSync(process.argv[2], JSON.stringify(evidence));
	const envelope = BatchResponseEnvelopeSchema.parse(JSON.parse(evidence.result));
	const values = envelope.responses.map((entry) => { assert.equal(entry.error, null); return JSON.parse(entry.response.result); });
	assert.deepEqual(values.slice(0, 2).map((fee) => fee.takerBasisPoints), ["0", "5"]);
	assert.notEqual(values[0].sourceDigest, values[1].sourceDigest);
	for (const value of values) {
		assert.equal(value.accountSelector, "secondary:1");
		assert.equal(value.credentialSource, "configured_pool");
		assert.equal(value.effectiveFrom, undefined); assert.equal(value.effectiveUntil, undefined);
	}
	assert(calls.every((call) => call.startsWith("secondary:1:")));
	assert.equal(calls.filter((call) => call.includes(":fees:")).length, 2);
	const isolated = await execute(request([
		child("proved", Action.FetchTicker, "proof"), child("failed", Action.FetchTicker, "fail"), child("plain", Action.FetchTicker, "plain"),
	]));
	const entries = BatchResponseEnvelopeSchema.parse(JSON.parse(isolated.result)).responses;
	assert.equal(isolated.proof, "");
	assert.equal(entries[0].response.proof, "fixture-child-proof");
	assert(entries[1].error); assert.equal(entries[1].response, null);
	assert.equal(entries[2].response.proof, "");
	assert.deepEqual(entries.map((entry) => entry.id), ["proved", "failed", "plain"]);
	await execute(request(Array.from({ length: 32 }, (_, n) => child(String(n), Action.FetchTicker, "plain"))));
	const boundaryChild = child("boundary", Action.FetchTicker, "");
	const overhead = Buffer.byteLength(JSON.stringify([boundaryChild]));
	boundaryChild.symbol = "x".repeat(MAX_BATCH_REQUEST_BYTES - overhead);
	await execute(request([boundaryChild]));
	const beforeRejected = calls.length;
	for (const invalid of [
		request(Array.from({ length: 33 }, (_, n) => child(String(n), Action.FetchTicker, "plain"))),
		request([{ ...boundaryChild, symbol: `${boundaryChild.symbol}x` }]),
		request([child("nested", Action.Batch, "")]),
		request([child("generic", Action.Call, "", { functionName: "fetchMarkets" })]),
		request([child("write", Action.Withdraw, "USDC")]),
		request([child("duplicate", Action.FetchTicker, "plain"), child("duplicate", Action.FetchTicker, "plain")]),
	]) await assert.rejects(execute(invalid), { code: grpc.status.INVALID_ARGUMENT });
	assert.equal(calls.length, beforeRejected, "Invalid batches must not reach provider");
	const captured = JSON.stringify([evidence, isolated, output]);
	assert(!captured.includes(fakeKey) && !captured.includes(fakeSecret));
} finally {
	grpc.Server.prototype.bindAsync = originalBind;
	client?.close();
	await broker.stop();
	for (const stream of streams.values()) stream.end();
	await new Promise((resolve) => prover.close(resolve));
	for (const [method, original] of Object.entries(originalConsole)) console[method] = original;
}
console.log("Packed loopback RPC: account/pair evidence, proof/error isolation, bounds and redaction passed");
