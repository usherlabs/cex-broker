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
		expect(stableGrpcErrorCode("AuthenticationError: x")).toBe(
			grpc.status.UNAUTHENTICATED,
		);
		expect(stableGrpcErrorCode("InsufficientFunds: x")).toBe(
			grpc.status.FAILED_PRECONDITION,
		);
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
		expect(stableGrpcErrorCode("passive_order_unsupported: x")).toBe(
			grpc.status.UNIMPLEMENTED,
		);
		expect(stableGrpcErrorCode("passive_order_rejected: x")).toBe(
			grpc.status.FAILED_PRECONDITION,
		);
		expect(stableGrpcErrorCode("passive_order_would_cross: x")).toBe(
			grpc.status.FAILED_PRECONDITION,
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
