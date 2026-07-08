import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import type { ExecuteActionContext } from "../src/handlers/execute-action/context";
import { handleOrders } from "../src/handlers/execute-action/orders";
import { Action } from "../src/helpers/constants";
import type { PolicyConfig } from "../src/types";

/** Stand-in for a ccxt venue error: a named subclass carrying the venue message,
 * the exact shape the enclave logs today but the caller never sees. */
class InsufficientFunds extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InsufficientFunds";
	}
}

function createCallbackCapture() {
	let error: { code?: number; message?: string } | null = null;
	const callback = (
		callbackError: { code?: number; message?: string } | null,
	) => {
		error = callbackError;
	};
	return { callback, getError: () => error };
}

function createContext(
	broker: Exchange,
	action: (typeof Action)[keyof typeof Action],
	payload: Record<string, string>,
): {
	ctx: ExecuteActionContext;
	getError: () => { code?: number; message?: string } | null;
} {
	const { callback, getError } = createCallbackCapture();
	const ctx = {
		action,
		call: { request: { payload } },
		wrappedCallback: callback,
		cex: "binance",
		normalizedCex: "binance",
		symbol: "USDC/USDT",
		broker,
		verity: { proof: "" },
		// Allow-everything policy so resolveOrderExecution reaches broker.createOrder.
		policy: {
			order: { rule: { markets: ["*"], limits: [] } },
		} as unknown as PolicyConfig,
		brokers: {},
	} as unknown as ExecuteActionContext;
	return { ctx, getError };
}

describe("orders handler surfaces underlying error detail", () => {
	test("CreateOrder appends class name + message after the stable prefix", async () => {
		const venueError = new InsufficientFunds(
			"binance Account has insufficient balance for requested action.",
		);
		const broker = {
			loadMarkets: async () => {},
			markets: {
				"USDC/USDT": {
					symbol: "USDC/USDT",
					base: "USDC",
					quote: "USDT",
					spot: true,
					type: "spot",
				},
			},
			createOrder: async () => {
				throw venueError;
			},
		} as unknown as Exchange;

		const { ctx, getError } = createContext(broker, Action.CreateOrder, {
			amount: "1",
			fromToken: "USDC",
			toToken: "USDT",
			price: "1",
			marketType: "spot",
		});
		await handleOrders(ctx);

		const error = getError();
		expect(error?.code).toBe(grpc.status.INTERNAL);
		expect(error?.message).toStartWith("Order Creation failed: ");
		expect(error?.message).toContain("InsufficientFunds");
		expect(error?.message).toContain("insufficient balance");
	});

	test("GetOrderDetails surfaces detail, keeps INTERNAL, single-line and capped", async () => {
		const venueError = new InsufficientFunds(
			`binance order lookup failed\nwith a newline and padding ${"x".repeat(1000)}`,
		);
		const broker = {
			fetchOrder: async () => {
				throw venueError;
			},
		} as unknown as Exchange;

		const { ctx, getError } = createContext(broker, Action.GetOrderDetails, {
			orderId: "order-123",
		});
		await handleOrders(ctx);

		const error = getError();
		expect(error?.code).toBe(grpc.status.INTERNAL);
		expect(error?.message).toStartWith(
			"Failed to fetch order details from binance: ",
		);
		expect(error?.message).toContain("InsufficientFunds");
		// newline collapsed to a single line
		expect(error?.message).not.toContain("\n");
		// only the detail portion is capped at 512; the fixed prefix is extra
		const prefix = "Failed to fetch order details from binance: ";
		const detail = error?.message?.slice(prefix.length) ?? "";
		expect(detail.length).toBe(512);
	});
});
