#!/usr/bin/env bun

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import type { SubscribeResponse__Output } from "../src/proto/cex_broker/SubscribeResponse";
import { SubscriptionType } from "../src/proto/cex_broker/SubscriptionType";
import type { ProtoGrpcType } from "../src/proto/node";
import { PROTO_LOADER_OPTIONS } from "../src/proto-loader-options";

const PROTO_FILE = "../src/proto/node.proto";
const brokerUrl = process.env.CEX_BROKER_URL ?? "localhost:8086";
const cex = process.env.CEX ?? "binance";
const symbol = process.env.SYMBOL ?? "BTC/USDT";
const timeframe = process.env.TIMEFRAME ?? "1m";

console.log("CEX Broker - OHLCV Archive Seeder");
console.log("━".repeat(55));
console.log(`Broker: ${brokerUrl}`);
console.log(`Stream: ${cex} ${symbol} @ ${timeframe}`);
console.log("Ensure archive-forwarder + ClickHouse are running.");
console.log("Press Ctrl+C to stop...\n");

const packageDef = protoLoader.loadSync(
	path.resolve(__dirname, PROTO_FILE),
	PROTO_LOADER_OPTIONS,
);

const proto = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;
const client = new proto.cex_broker.cex_service(
	brokerUrl,
	grpc.credentials.createInsecure(),
);

const subscribeRequest = {
	cex,
	symbol,
	type: SubscriptionType.OHLCV,
	options: { timeframe },
};

const stream = client.Subscribe(subscribeRequest);
let updateCount = 0;

stream.on("data", (response: SubscribeResponse__Output) => {
	updateCount += 1;
	const timestamp = new Date(Number.parseInt(response.timestamp, 10));
	let summary = response.data.slice(0, 120);
	try {
		const payload = JSON.parse(response.data) as unknown;
		if (Array.isArray(payload)) {
			const bars = Array.isArray(payload[0]) ? payload : [payload];
			const last = bars[bars.length - 1] as number[];
			if (Array.isArray(last) && last.length >= 6) {
				summary = `bar ts=${last[0]} o=${last[1]} h=${last[2]} l=${last[3]} c=${last[4]} v=${last[5]}`;
			}
		}
	} catch {
		// keep raw summary
	}

	console.log(`[${timestamp.toISOString()}] update #${updateCount} ${summary}`);
});

stream.on("error", (error: grpc.ServiceError) => {
	console.error("Stream error:", error.message);
	if (error.code === 14) {
		console.error(
			`Connection unavailable - is the broker running on ${brokerUrl}?`,
		);
	}
	process.exit(1);
});

stream.on("end", () => {
	console.log("\nStream ended");
	process.exit(0);
});

process.on("SIGINT", () => {
	console.log("\nStopping OHLCV archive seeder...");
	stream.cancel();
	process.exit(0);
});

console.log("Subscribing to OHLCV stream...");
