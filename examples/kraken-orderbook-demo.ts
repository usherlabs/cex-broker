#!/usr/bin/env bun

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { SubscriptionType } from "../src/proto/cex_broker/SubscriptionType";
import type { ProtoGrpcType } from "../src/proto/node";
import type { SubscribeResponse__Output } from "../src/proto/cex_broker/SubscribeResponse";

const PROTO_FILE = "../src/proto/node.proto";

console.log("CEX Broker - Kraken Orderbook Demo");
console.log("━".repeat(55));

const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_FILE), {
	keepCase: true,
	longs: String,
	enums: String,
	defaults: true,
	oneofs: true,
});

const proto = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;
const client = new proto.cex_broker.cex_service(
	"localhost:8088",
	grpc.credentials.createInsecure(),
);

// Test with Kraken ETH/USDT (allowed in policy: KRAKEN:ETH/USDT)
const subscribeRequest = {
	cex: "kraken",
	symbol: "ETH/USDT",
	type: SubscriptionType.ORDERBOOK, // ORDERBOOK
	options: {},
};

console.log("Streaming live orderbook: ETH/USDT from Kraken");
console.log("Press Ctrl+C to stop...\n");

const stream = client.Subscribe(subscribeRequest);
let dataCount = 0;

stream.on("data", (response: SubscribeResponse__Output) => {
	dataCount++;

	console.clear(); // Clear screen for live updates
	console.log("LIVE ORDERBOOK - ETH/USDT (Kraken)");
	console.log("━".repeat(50));
	console.log(`Update #${dataCount}`);
	console.log(`${new Date(parseInt(response.timestamp)).toLocaleTimeString()}`);
	console.log("");

	try {
		const orderbook = JSON.parse(response.data);

		if (orderbook.asks && orderbook.bids) {
			// Show top 5 asks (sell orders)
			console.log("ASKS (Sell Orders):");
			orderbook.asks.slice(0, 5).forEach(([price, size]: [number, number]) => {
				const priceNum = Number(price);
				const sizeNum = Number(size);
				console.log(
					`   $${priceNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} - ${sizeNum.toFixed(6)} ETH`,
				);
			});

			console.log("   " + "─".repeat(40));

			// Show top 5 bids (buy orders)
			console.log("BIDS (Buy Orders):");
			orderbook.bids.slice(0, 5).forEach(([price, size]: [number, number]) => {
				const priceNum = Number(price);
				const sizeNum = Number(size);
				console.log(
					`   $${priceNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} - ${sizeNum.toFixed(6)} ETH`,
				);
			});

			// Calculate spread and market info
			if (orderbook.asks[0] && orderbook.bids[0]) {
				const askPrice = Number(orderbook.asks[0][0]);
				const bidPrice = Number(orderbook.bids[0][0]);
				const spread = askPrice - bidPrice;
				const spreadPercent = (spread / bidPrice) * 100;
				const midPrice = (askPrice + bidPrice) / 2;

				console.log("");
				console.log("Market Info:");
				console.log(
					`Mid Price: $${midPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
				);
				console.log(
					`Spread: $${spread.toFixed(2)} (${spreadPercent.toFixed(4)}%)`,
				);
				console.log(
					`Ask/Bid: $${askPrice.toLocaleString()} / $${bidPrice.toLocaleString()}`,
				);
			}
		}
	} catch (e) {
		console.log("Raw data preview:", response.data.substring(0, 200) + "...");
		console.log("Parse error:", e);
	}

	console.log("\n Press Ctrl+C to stop streaming");
});

stream.on("error", (error: grpc.ServiceError) => {
	console.error("Stream error:", error.message);
	console.log("Code:", error.code);

	if (error.code === 14) {
		console.log("Connection unavailable - is the broker running on port 8088?");
	} else if (error.code === 7) {
		console.log("Permission denied - check IP whitelist");
	} else if (error.code === 13) {
		console.log("Internal server error - likely API key or connectivity issue");
		console.log("Check broker logs for detailed error information");
	} else if (error.message.includes("Invalid padding")) {
		console.log(
			"Kraken API secret formatting issue - needs proper base64 encoding",
		);
	}
});

stream.on("end", () => {
	console.log("\n Stream ended");
	process.exit(0);
});

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
	console.log("\nStopping Kraken orderbook stream...");
	stream.cancel();
	console.log("Demo completed!");
	process.exit(0);
});

console.log("Connecting to Kraken orderbook stream...");
