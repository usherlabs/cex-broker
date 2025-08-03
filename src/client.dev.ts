import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { fileURLToPath } from "url";
import type { ProtoGrpcType } from "./proto/node";
import { Action } from "./proto/cex_broker/Action";
import { config } from "dotenv";
import { log } from "./helpers/logger";
// import CEXBroker from ".";
import CEXBroker from "../dist/index";
import { loadPolicy } from "./helpers";

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
}
