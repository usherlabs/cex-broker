import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import CEXBroker from ".";
// import CEXBroker from "../dist/index";
import { loadPolicy } from "./helpers";
import { log } from "./helpers/logger";
import { Action } from "./proto/cex_broker/Action";
import type { ProtoGrpcType } from "./proto/node";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Safe absolute path to proto
const protoPath = path.join(__dirname, ".", "proto", "node.proto");

const port = 8086;

const packageDef = protoLoader.loadSync(protoPath);
const grpcObj = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;

const client = new grpcObj.cex_broker.cex_service(
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
// metadata.add("api-key", process.env.BYBIT_API_KEY ?? ""); // Example header
// metadata.add("api-secret", process.env.BYBIT_API_SECRET ?? "");

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
	// Test ExecuteAction for ticker
	client.executeAction(
		{
			cex: "mexc",
			symbol: "ETHUSDT",
			action: Action.FetchTicker,
		},
		metadata,
		(err, result) => {
			if (err) {
				log.error({ err });
				return;
			}
			log.info("ExecuteAction Ticker Result:", { result });
		},
	);

	// Test ExecuteAction for Account ID
	client.executeAction(
		{
			cex: "mexc",
			action: Action.FetchFees,
		},
		metadata,
		(err, result) => {
			if (err) {
				log.error({ err });
				return;
			}
			log.info("ExecuteAction  Result:", { result: result?.result });
		},
	);

	// // Test ExecuteAction for balance
	// client.executeAction(
	// 	{
	// 		cex: "binance",
	// 		symbol: "USDT,BTC,ETH",
	// 		payload: { type: "spot" },
	// 		action: Action.FetchBalances,
	// 	},
	// 	metadata,
	// 	(err, result) => {
	// 		if (err) {
	// 			log.error({ err });
	// 			return;
	// 		}
	// 		log.info("ExecuteAction Balance Result:", { result });
	// 	},
	// );
}
