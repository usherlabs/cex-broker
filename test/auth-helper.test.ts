import { describe, expect, test } from "bun:test";
import { authenticateRequest } from "../src/helpers/auth";

function callFromPeer(peer: string) {
	return {
		getPeer: () => peer,
	};
}

describe("authenticateRequest", () => {
	test.each([
		["127.0.0.1:1234", "127.0.0.1"],
		["ipv4:127.0.0.1:1234", "127.0.0.1"],
		["ipv6:[::1]:50051", "::1"],
		["[::1]:50051", "::1"],
		["127.0.0.1", "127.0.0.1"],
		["::1", "::1"],
		["localhost", "localhost"],
		["localhost:50051", "localhost"],
	])("allows whitelisted peer %s", (peer, whitelistIp) => {
		expect(authenticateRequest(callFromPeer(peer), [whitelistIp])).toBe(true);
	});

	test.each([
		["192.168.1.10:1234", ["127.0.0.1"]],
		["ipv4:192.168.1.10:1234", ["127.0.0.1"]],
		["ipv6:[2001:db8::1]:50051", ["::1"]],
		["[2001:db8::1]:50051", ["::1"]],
	])("denies unlisted peer %s", (peer, whitelistIps) => {
		expect(authenticateRequest(callFromPeer(peer), whitelistIps)).toBe(false);
	});

	test.each([
		"",
		"   ",
		"ipv4:",
		"ipv6:",
		"ipv4:[::1]:50051",
		"ipv6:127.0.0.1:50051",
		"ipv6:[::1]:not-a-port",
		"[2001:db8::1",
		"2001:db8::1:50051",
		"unix:/tmp/grpc.sock",
	])("denies malformed or unsupported peer %s", (peer) => {
		expect(authenticateRequest(callFromPeer(peer), ["127.0.0.1", "::1"])).toBe(
			false,
		);
	});

	test.each([
		"",
		"ipv6:[2001:db8::1]:50051",
		"unix:/tmp/grpc.sock",
	])("allows peer %s with wildcard whitelist", (peer) => {
		expect(authenticateRequest(callFromPeer(peer), ["*"])).toBe(true);
	});
});
