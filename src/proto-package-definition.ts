import * as protoLoader from "@grpc/proto-loader";
import descriptor from "./proto/node.descriptor.ts";
import { PROTO_LOADER_OPTIONS } from "./proto-loader-options";

export const CEX_BROKER_PACKAGE_DEFINITION = protoLoader.fromJSON(
	descriptor as unknown as Record<string, unknown>,
	PROTO_LOADER_OPTIONS,
);
