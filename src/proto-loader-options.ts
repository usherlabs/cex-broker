import type { Options } from "@grpc/proto-loader";

export const PROTO_LOADER_OPTIONS = {
	keepCase: true,
	longs: String,
	enums: String,
	defaults: true,
	oneofs: true,
} satisfies Options;
