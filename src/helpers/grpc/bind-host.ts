import { isIP } from "node:net";

export function resolveGrpcBindHost(
	explicitHost: string | undefined,
	environmentHost: string | undefined,
): string {
	const host = explicitHost ?? environmentHost ?? "0.0.0.0";
	if (!isIP(host) || host.includes("%")) {
		throw new Error(
			"Invalid gRPC bind host: set --bind-host or CEX_BROKER_GRPC_BIND_HOST to a bare IPv4 or IPv6 address without a port or zone ID",
		);
	}
	return host;
}

export function grpcBindAddress(host: string, port: number): string {
	return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}
