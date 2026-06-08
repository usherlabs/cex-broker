import { isIP } from "node:net";
import { log } from "./logger";

type IpVersion = 4 | 6;

type GrpcPeerCall = {
	getPeer(): string;
};

function parsePeerHost(peer: string): string | undefined {
	const value = peer.trim();
	if (!value) return undefined;

	if (value.startsWith("ipv4:")) {
		return parsePeerEndpoint(value.slice("ipv4:".length), 4);
	}

	if (value.startsWith("ipv6:")) {
		return parsePeerEndpoint(value.slice("ipv6:".length), 6);
	}

	return parsePeerEndpoint(value);
}

function parsePeerEndpoint(
	endpoint: string,
	expectedIpVersion?: IpVersion,
): string | undefined {
	if (!endpoint) return undefined;

	const bracketedIpv6 = endpoint.match(/^\[([^\]]+)\](?::(\d+))?$/);
	if (bracketedIpv6) {
		const host = bracketedIpv6[1];
		const port = bracketedIpv6[2];
		if (!host || !isValidHost(host, expectedIpVersion, 6)) {
			return undefined;
		}
		return port === undefined || isValidPort(port) ? host : undefined;
	}

	if (endpoint.includes("[") || endpoint.includes("]")) {
		return undefined;
	}

	if (isValidHost(endpoint, expectedIpVersion)) {
		return endpoint;
	}

	const hostWithPort = endpoint.match(/^([^:]+):(\d+)$/);
	if (!hostWithPort) {
		return undefined;
	}

	const host = hostWithPort[1];
	const port = hostWithPort[2];
	if (!host || !isValidHost(host, expectedIpVersion) || !isValidPort(port)) {
		return undefined;
	}

	return host;
}

function isValidHost(
	host: string,
	expectedIpVersion?: IpVersion,
	requiredIpVersion?: IpVersion,
): boolean {
	const actualIpVersion = isIP(host);
	const requiredVersion = expectedIpVersion ?? requiredIpVersion;
	if (requiredVersion !== undefined) {
		return actualIpVersion === requiredVersion;
	}

	return actualIpVersion > 0 || /^[A-Za-z0-9.-]+$/.test(host);
}

function isValidPort(port: string): boolean {
	const value = Number(port);
	return Number.isInteger(value) && value >= 0 && value <= 65535;
}

export function authenticateRequest(
	call: GrpcPeerCall,
	whitelistIps: string[],
): boolean {
	const clientIp = parsePeerHost(call.getPeer());
	if (whitelistIps.includes("*")) {
		return true;
	} else if (!clientIp || !whitelistIps.includes(clientIp)) {
		log.warn(`Blocked access from unauthorized IP: ${clientIp || "unknown"}`);
		return false;
	}
	return true;
}
