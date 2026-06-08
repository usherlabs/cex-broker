import { log } from "./logger";

type GrpcPeerCall = {
	getPeer(): string;
};

export function authenticateRequest(
	call: GrpcPeerCall,
	whitelistIps: string[],
): boolean {
	const clientIp = call.getPeer().split(":")[0];
	if (whitelistIps.includes("*")) {
		return true;
	} else if (!clientIp || !whitelistIps.includes(clientIp)) {
		log.warn(`Blocked access from unauthorized IP: ${clientIp || "unknown"}`);
		return false;
	}
	return true;
}
