import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "./proto/node";
import config from "./config";

const PROTO_FILE = "./proto/node.proto";

const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_FILE));
const grpcObj = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;

const client = new grpcObj.fietCexNode.CexService(
	`0.0.0.0:${config.port}`,
	grpc.credentials.createInsecure(),
);

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
	client.getBalance({ cex: "bybit", token: "USDT" }, (err, result) => {
		if (err) {
			console.error({ err });
			return;
		}
		console.log({ x: result });
	});

//   client.Transfer({cex:"binance",amount:1,token:"USDT",chain:"BEP20",recipientAddress:"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"},(err,result)=>{
//     if (err) {
// 			console.error({ err });
// 			return;
// 		}
// 		console.log({ x: result });
//   })
}
