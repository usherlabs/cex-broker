import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "../proto/node";
import { Action } from "../proto/cexBroker/Action";
import {config} from "dotenv"

const PROTO_FILE = "../proto/node.proto";
const port= 8086

const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_FILE));
const grpcObj = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;

const client = new grpcObj.cexBroker.CexService(
	`0.0.0.0:${port}`,
	grpc.credentials.createInsecure(),
);

config()

const metadata = new grpc.Metadata();
metadata.add('api-key', process.env.BYBIT_API_KEY??""); // Example header
metadata.add('api-secret', process.env.BYBIT_API_SECRET??"");

const deadline = new Date();
deadline.setSeconds(deadline.getSeconds() + 5);
client.waitForReady(deadline, (err) => {
	if (err) {
		console.error(err);
		return;
	}
	onClientReady();
});

function onClientReady() {
	client.executeCcxtAction({ cex: "bybit", symbol: "USDT",payload:{},action: Action.FetchBalance },metadata, (err, result) => {
		if (err) {
			console.error({ err });
			return;
		}
		console.log({ x: result });
	});

}
