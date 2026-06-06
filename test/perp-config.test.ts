import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { Action } from "../src/helpers/constants";
import { handlePerpConfig } from "../src/handlers/execute-action/perp-config";
import type { ExecuteActionContext } from "../src/handlers/execute-action/context";

function createContext(
	broker: Exchange | null,
	action: (typeof Action)[keyof typeof Action],
	payload: Record<string, string>,
): {
	ctx: ExecuteActionContext;
	callback: ReturnType<typeof createCallbackCapture>["callback"];
	getResponse: ReturnType<typeof createCallbackCapture>["getResponse"];
} {
	const { callback, getResponse } = createCallbackCapture();
	const ctx = {
		action,
		call: {
			request: {
				payload,
			},
		},
		wrappedCallback: callback,
		cex: "hyperliquid",
		normalizedCex: "hyperliquid",
		broker,
	} as unknown as ExecuteActionContext;
	return { ctx, callback, getResponse };
}

function createCallbackCapture() {
	let response: { code?: number; message?: string } | null = null;
	let result: { result?: string } | null = null;
	const callback = (
		error: { code?: number; message?: string } | null,
		value: { result?: string } | null,
	) => {
		response = error;
		result = value;
	};
	return {
		callback,
		getResponse: () => ({ error: response, result }),
	};
}

describe("perp-config handler", () => {
	test("GetPerpConfigState returns UNIMPLEMENTED when fetchPositions is unavailable", async () => {
		const broker = {
			has: { fetchPositions: false },
		} as unknown as Exchange;
		const { ctx, getResponse } = createContext(
			broker,
			Action.GetPerpConfigState,
			{},
		);
		await handlePerpConfig(ctx);
		expect(getResponse().error?.code).toBe(grpc.status.UNIMPLEMENTED);
	});

	test("GetPerpConfigState returns normalized configs", async () => {
		const broker = {
			has: { fetchPositions: true },
			fetchPositions: async () => [
				{
					symbol: "ETH/USDC:USDC",
					leverage: 20,
					marginMode: "cross",
				},
			],
		} as unknown as Exchange;
		const { ctx, getResponse } = createContext(
			broker,
			Action.GetPerpConfigState,
			{},
		);
		await handlePerpConfig(ctx);
		expect(getResponse().error).toBeNull();
		const parsed = JSON.parse(getResponse().result?.result ?? "{}");
		expect(parsed.configs).toEqual([
			{
				symbol: "ETH/USDC:USDC",
				leverage: 20,
				marginMode: "cross",
			},
		]);
	});

	test("SetPerpConfigState calls setLeverage with marginMode default", async () => {
		let calledWith: unknown;
		const broker = {
			has: { setLeverage: true },
			setLeverage: async (
				leverage: number,
				symbol: string,
				params: Record<string, unknown>,
			) => {
				calledWith = { leverage, symbol, params };
				return { status: "ok" };
			},
		} as unknown as Exchange;
		const { ctx, getResponse } = createContext(
			broker,
			Action.SetPerpConfigState,
			{
				symbol: "ETH/USDC:USDC",
				leverage: "10",
				marginMode: "isolated",
			},
		);
		await handlePerpConfig(ctx);
		expect(getResponse().error).toBeNull();
		expect(calledWith).toEqual({
			leverage: 10,
			symbol: "ETH/USDC:USDC",
			params: { marginMode: "isolated" },
		});
	});
});
