import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "../proto/node";
import { Action } from "../proto/cexBroker/Action";
import { config } from "dotenv";
import { log } from "./helpers/logger";
import CEXBroker from ".";
import { loadPolicy } from "./helpers";

const PROTO_FILE = "../proto/node.proto";
const port = 8086;

const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_FILE));
const grpcObj = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;

const client = new grpcObj.cexBroker.CexService(
	`0.0.0.0:${port}`,
	grpc.credentials.createInsecure(),
);

config();

const broker = new CEXBroker({}, loadPolicy("./policy/policy.json"), {
	useVerity: true,
});
broker.loadEnvConfig();
broker.run();

const metadata = new grpc.Metadata();
metadata.add("api-key", process.env.BYBIT_API_KEY ?? ""); // Example header
metadata.add("api-secret", process.env.BYBIT_API_SECRET ?? "");

const deadline = new Date();
deadline.setSeconds(deadline.getSeconds() + 5);
client.waitForReady(deadline, (err) => {
	if (err) {
		log.error(err);
		return;
	}
	onClientReady();
});

function onClientReady() {
	// // Test ExecuteAction for balance
	// client.executeAction({ cex: "bybit", symbol: "USDT",payload:{},action: Action.FetchBalance },metadata, (err, result) => {
	// 	if (err) {
	// 		log.error({ err });
	// 		return;
	// 	}
	// 	log.info("ExecuteAction Balance Result:", { result });
	// });

	// Test ExecuteAction for balance
	client.executeAction(
		{
			cex: "bybit",
			symbol: "USDT",
			payload: { type: "spot" },
			action: Action.FetchBalance,
		},
		metadata,
		(err, result) => {
			if (err) {
				log.error({ err });
				return;
			}
			log.info("ExecuteAction Balance Result:", { result });
		},
	);

	// // Test Subscribe for balance streaming
	// log.info("Starting balance subscription test...");
	// const subscribeCall = client.subscribe(
	// 	{
	// 		cex: "bybit",
	// 		symbol: "BTC/USDT",
	// 		type: SubscriptionType.TICKER,
	// 		options: {},
	// 	},
	// 	metadata,
	// );

	// // Handle incoming stream data
	// subscribeCall.on("data", (response) => {
	// 	log.info("Balance Subscription Update:", {
	// 		symbol: response.symbol,
	// 		type: response.type,
	// 		data: JSON.parse(response.data),
	// 	});
	// });

	// // Handle stream end
	// subscribeCall.on("end", () => {
	// 	log.info("Balance subscription stream ended");
	// });

	// // Handle stream errors
	// subscribeCall.on("error", (error) => {
	// 	log.error("Balance subscription stream error:", error);
	// });

	// // Keep the subscription alive for 30 seconds
	// setTimeout(() => {
	// 	log.info("Closing balance subscription after 30 seconds");
	// 	// For server-side streaming, we don't need to call end() on the client
	// 	// The server will handle the stream lifecycle
	// }, 3000000);
}
