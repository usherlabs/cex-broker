import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { removeSecretMaterial } from "../src/helpers/broker-execution-archive/redact";
import {
	canonicalNonnegativeDecimal,
	decimalFractionToBasisPoints,
	evidenceSourceDigest,
	extractTradingFeeRates,
	resolveEvidenceAccountScope,
} from "../src/helpers/venue-evidence";
import { CanonicalDecimalStringSchema } from "../src/schemas/action-evidence";

function brokerWithSecret(secret: string): Exchange {
	// SAFETY: evidence hashing reads only the standard dynamic CCXT credential slots.
	return { apiKey: "api-key", secret } as unknown as Exchange;
}

describe("venue evidence primitives", () => {
	test("normalizes decimal strings and converts fractions to basis points exactly", () => {
		expect(canonicalNonnegativeDecimal("0E-18", "maker")).toBe("0");
		expect(canonicalNonnegativeDecimal("0.000500000000000000", "taker")).toBe(
			"0.0005",
		);
		expect(decimalFractionToBasisPoints("0E-18")).toBe("0");
		expect(decimalFractionToBasisPoints("0.000500000000000000")).toBe("5");
		expect(() => canonicalNonnegativeDecimal("-0.1", "fee")).toThrow();
	});

	test("accepts only canonical non-negative decimal evidence strings", () => {
		for (const value of ["0", "5", "0.0005", "10.01"]) {
			expect(CanonicalDecimalStringSchema.safeParse(value).success).toBe(true);
		}
		for (const value of ["-0", "-1", "1.0", "0.0005000", "1e-3"]) {
			expect(CanonicalDecimalStringSchema.safeParse(value).success).toBe(false);
		}
	});

	test("labels request-scoped credential selection without exposing credentials", () => {
		const metadata = new grpc.Metadata();
		metadata.set("use-secondary-key", "2");
		metadata.set("api-key", "must-not-appear");
		metadata.set("api-secret", "must-not-appear");
		expect(resolveEvidenceAccountScope(undefined, metadata)).toEqual({
			accountSelector: "secondary:2",
			credentialSource: "request_metadata",
		});
	});

	test("extracts both unified and nested MEXC commission shapes", () => {
		expect(extractTradingFeeRates({ maker: "0", taker: "0.0005" })).toEqual({
			makerRate: "0",
			takerRate: "0.0005",
		});
		expect(
			extractTradingFeeRates({
				info: {
					data: {
						makerCommission: "0E-18",
						takerCommission: "0.000500000000000000",
					},
				},
			}),
		).toEqual({ makerRate: "0", takerRate: "0.0005" });
		expect(() => extractTradingFeeRates({ maker: "0" })).toThrow(
			"fee_unavailable:",
		);
	});

	test("canonical digests ignore key order, change with facts, and exclude secrets", () => {
		const broker = brokerWithSecret("configured-secret-value");
		const base = {
			action: "FetchFees",
			exchange: "mexc",
			requestedKey: "ARB-USDC",
			accountSelector: "primary",
			sourceMethod: "ccxt.fetchTradingFee",
			broker,
		};
		const left = evidenceSourceDigest({
			...base,
			source: {
				maker: "0",
				taker: "0.0005",
				apiKey: "must-not-survive",
				note: "configured-secret-value",
			},
		});
		const reordered = evidenceSourceDigest({
			...base,
			source: {
				note: "configured-secret-value",
				taker: "0.0005",
				maker: "0",
				apiKey: "different-secret",
			},
		});
		const changed = evidenceSourceDigest({
			...base,
			source: { maker: "0", taker: "0.0006" },
		});
		expect(left).toBe(reordered);
		expect(left).not.toBe(changed);
		expect(
			JSON.stringify(
				removeSecretMaterial(
					{
						apiKey: "must-not-survive",
						nested: { signature: "sig", note: "configured-secret-value" },
					},
					["configured-secret-value"],
				),
			),
		).toBe('{"nested":{"note":"[redacted]"}}');
	});
});
