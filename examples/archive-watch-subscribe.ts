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
const timeframe = process.env.TIMEFRAME ?? "1m";
const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const parsedReconnectDelay = Number.parseInt(
	process.env.ARCHIVE_WATCH_RECONNECT_MS ?? String(DEFAULT_RECONNECT_DELAY_MS),
	10,
);
const RECONNECT_DELAY_MS =
	Number.isFinite(parsedReconnectDelay) && parsedReconnectDelay > 0
		? parsedReconnectDelay
		: DEFAULT_RECONNECT_DELAY_MS;

function parseSymbols(): string[] {
	const raw =
		process.env.SYMBOLS?.trim() ||
		process.env.SYMBOL?.trim() ||
		"BTC/USDT,BNB/USDT,DOGE/USDT";
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

const symbols = parseSymbols();

console.log("CEX Broker - Market Data Archive Watch");
console.log("━".repeat(55));
console.log(`Broker: ${brokerUrl}`);
console.log(`Exchange: ${cex}`);
console.log(`Symbols: ${symbols.join(", ")}`);
console.log(
	`Streams per symbol: ORDERBOOK, OHLCV @ ${timeframe}, TRADES, TICKER`,
);
console.log("Runs until stopped (Ctrl+C). Reconnects automatically on errors.");
console.log("Ensure broker + archive-forwarder + ClickHouse are running.\n");

const packageDef = protoLoader.loadSync(
	path.resolve(__dirname, PROTO_FILE),
	PROTO_LOADER_OPTIONS,
);
const proto = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;

function createClient() {
	return new proto.cex_broker.cex_service(
		brokerUrl,
		grpc.credentials.createInsecure(),
	);
}

const activeStreams: grpc.ClientReadableStream<SubscribeResponse__Output>[] =
	[];
let shuttingDown = false;

function removeStream(
	stream: grpc.ClientReadableStream<SubscribeResponse__Output>,
): void {
	const index = activeStreams.indexOf(stream);
	if (index >= 0) {
		activeStreams.splice(index, 1);
	}
}

function scheduleReconnect(label: string, start: () => void) {
	if (shuttingDown) {
		return;
	}
	console.warn(`[${label}] reconnecting in ${RECONNECT_DELAY_MS}ms...`);
	setTimeout(start, RECONNECT_DELAY_MS);
}

function startOrderbookStream(symbol: string) {
	const label = `ORDERBOOK ${symbol}`;
	const stream = createClient().Subscribe({
		cex,
		symbol,
		type: SubscriptionType.ORDERBOOK,
		options: {},
	});
	activeStreams.push(stream);
	let updates = 0;

	stream.on("data", (response: SubscribeResponse__Output) => {
		updates += 1;
		if (updates % 60 === 0) {
			console.log(
				`[${label}] ${updates} frames (latest ts=${response.timestamp})`,
			);
		}
	});

	stream.on("error", (error: grpc.ServiceError) => {
		console.error(`[${label}] stream error:`, error.message);
		removeStream(stream);
		scheduleReconnect(label, () => startOrderbookStream(symbol));
	});

	stream.on("end", () => {
		console.warn(`[${label}] stream ended`);
		removeStream(stream);
		scheduleReconnect(label, () => startOrderbookStream(symbol));
	});

	console.log(`[${label}] subscribed`);
}

function startOhlcvStream(symbol: string) {
	const label = `OHLCV ${symbol}`;
	const stream = createClient().Subscribe({
		cex,
		symbol,
		type: SubscriptionType.OHLCV,
		options: { timeframe },
	});
	activeStreams.push(stream);
	let updates = 0;

	stream.on("data", (response: SubscribeResponse__Output) => {
		updates += 1;
		let summary = `update #${updates}`;
		try {
			const payload = JSON.parse(response.data) as unknown;
			if (Array.isArray(payload)) {
				const bars = Array.isArray(payload[0]) ? payload : [payload];
				const last = bars[bars.length - 1] as number[];
				if (Array.isArray(last) && last.length >= 6) {
					summary = `bar ts=${last[0]} c=${last[4]}`;
				}
			}
		} catch {
			// keep summary
		}
		if (updates % 10 === 0) {
			console.log(`[${label}] ${summary}`);
		}
	});

	stream.on("error", (error: grpc.ServiceError) => {
		console.error(`[${label}] stream error:`, error.message);
		removeStream(stream);
		scheduleReconnect(label, () => startOhlcvStream(symbol));
	});

	stream.on("end", () => {
		console.warn(`[${label}] stream ended`);
		removeStream(stream);
		scheduleReconnect(label, () => startOhlcvStream(symbol));
	});

	console.log(`[${label}] subscribed @ ${timeframe}`);
}

function startSimpleStream(
	symbol: string,
	streamName: "TRADES" | "TICKER",
	subscriptionType: SubscriptionType,
): void {
	const label = `${streamName} ${symbol}`;
	const stream = createClient().Subscribe({
		cex,
		symbol,
		type: subscriptionType,
		options: {},
	});
	activeStreams.push(stream);
	let updates = 0;

	stream.on("data", (response: SubscribeResponse__Output) => {
		updates += 1;
		if (updates % 30 === 0) {
			console.log(
				`[${label}] ${updates} frames (latest ts=${response.timestamp})`,
			);
		}
	});

	stream.on("error", (error: grpc.ServiceError) => {
		console.error(`[${label}] stream error:`, error.message);
		removeStream(stream);
		scheduleReconnect(label, () =>
			startSimpleStream(symbol, streamName, subscriptionType),
		);
	});

	stream.on("end", () => {
		console.warn(`[${label}] stream ended`);
		removeStream(stream);
		scheduleReconnect(label, () =>
			startSimpleStream(symbol, streamName, subscriptionType),
		);
	});

	console.log(`[${label}] subscribed`);
}

for (const symbol of symbols) {
	startOrderbookStream(symbol);
	startOhlcvStream(symbol);
	startSimpleStream(symbol, "TRADES", SubscriptionType.TRADES);
	startSimpleStream(symbol, "TICKER", SubscriptionType.TICKER);
}

process.on("SIGINT", () => {
	console.log("\nStopping archive watch...");
	shuttingDown = true;
	for (const stream of activeStreams) {
		stream.cancel();
	}
	process.exit(0);
});

process.on("SIGTERM", () => {
	shuttingDown = true;
	for (const stream of activeStreams) {
		stream.cancel();
	}
	process.exit(0);
});
