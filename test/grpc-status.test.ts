import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import ccxt from "@usherlabs/ccxt";
import {
	mapCcxtErrorToGrpcStatus,
	resolveGrpcError,
	stableGrpcErrorCode,
} from "../src/helpers/grpc/status";

describe("grpc status", () => {
	test("stableGrpcErrorCode maps known prefixes", () => {
		expect(stableGrpcErrorCode("venue_discovery_unavailable: x")).toBe(
			grpc.status.UNIMPLEMENTED,
		);
		expect(stableGrpcErrorCode("network_alias_unresolved: x")).toBe(
			grpc.status.INVALID_ARGUMENT,
		);
		expect(stableGrpcErrorCode("deposit_amount_mismatch: x")).toBe(
			grpc.status.FAILED_PRECONDITION,
		);
		expect(stableGrpcErrorCode("policy_deposit_denied: x")).toBe(
			grpc.status.PERMISSION_DENIED,
		);
	});

	test("mapCcxtErrorToGrpcStatus maps authentication errors", () => {
		expect(mapCcxtErrorToGrpcStatus(new ccxt.AuthenticationError("auth"))).toBe(
			grpc.status.UNAUTHENTICATED,
		);
	});

	test("resolveGrpcError prefers stable prefix over CCXT", () => {
		const err = new ccxt.BadRequest("network_alias_unresolved: BTC");
		const resolved = resolveGrpcError(err);
		expect(resolved.code).toBe(grpc.status.INVALID_ARGUMENT);
	});
});
