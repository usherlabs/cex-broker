import { afterEach, expect, spyOn, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import type { ExecuteActionContext } from "../src/handlers/execute-action/context";
import { handlePassThrough } from "../src/handlers/execute-action/pass-through";
import { Action } from "../src/helpers/constants";
import { log } from "../src/helpers/logger";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

for (const fallback of [false, true]) {
	test(`FetchTicker removes secrets before ${fallback ? "console fallback" : "structured logging"} without changing response`, async () => {
		const key = "fixture-ticker-key-not-a-credential";
		const secret = "fixture-ticker-secret-not-a-credential";
		const error = Object.assign(new Error(`${key} ${secret}`), {
			name: `${key} ${secret}`,
			apiKey: key,
			secret,
			request: {
				headers: {
					authorization: "fixture-auth",
					signature: "fixture-signature",
				},
			},
		});
		const captured: unknown[] = [];
		spies.push(
			spyOn(log, "error").mockImplementation((...args) => {
				captured.push(args);
				if (fallback) throw new Error("fixture logging failure");
				return log;
			}),
		);
		spies.push(
			spyOn(console, "error").mockImplementation((...args) => {
				captured.push(args);
			}),
		);
		const responses: unknown[] = [];
		const ctx = {
			action: Action.FetchTicker,
			cex: "mexc",
			symbol: "ARB/USDC",
			broker: {
				apiKey: key,
				secret,
				fetchTicker: async () => {
					throw error;
				},
			} as unknown as Exchange,
			wrappedCallback: (...args: unknown[]) => {
				responses.push(args);
			},
		} as unknown as ExecuteActionContext;
		await handlePassThrough(ctx);
		expect(responses).toEqual([
			[
				{
					code: grpc.status.INTERNAL,
					message: "Failed to fetch ticker from mexc",
				},
				null,
			],
		]);
		expect(captured).toHaveLength(fallback ? 2 : 1);
		const serialized = JSON.stringify(captured);
		for (const forbidden of [
			key,
			secret,
			"apiKey",
			"signature",
			"authorization",
			"fixture-auth",
			"fixture-signature",
			"request",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
		expect(serialized).toContain("redacted_error");
	});
}
