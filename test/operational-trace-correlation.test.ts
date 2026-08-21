import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { createExecuteActionHandler } from "../src/handlers/execute-action/handler";
import { createSubscribeHandler } from "../src/handlers/subscribe/handler";
import type {
	ActionRequest,
	ActionResponse,
	SubscribeRequest,
	SubscribeResponse,
} from "../src/handlers/types";
import type { BrokerPoolEntry } from "../src/helpers/broker";
import { Action, SubscriptionType } from "../src/helpers/constants";
import { log } from "../src/helpers/logger";
import { TRACE_METADATA_KEY } from "../src/helpers/trace-context";
import type { PolicyConfig } from "../src/types";
import { CapturingOtelMetrics } from "./order-telemetry-fixtures";

const OTEL_TRACE_ID = "0123456789abcdef0123456789abcdef";
const UUID_TRACE_ID = "550e8400-e29b-41d4-a716-446655440000";

const testPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: ["*"], limits: [] } },
};

function createPool(
	exchange: Exchange,
	cex = "binance",
): Record<string, BrokerPoolEntry> {
	return {
		[cex]: {
			primary: { exchange, label: "primary" },
			secondaryBrokers: [],
		},
	};
}

function metadataWithTraceId(traceId: string): grpc.Metadata {
	const metadata = new grpc.Metadata();
	metadata.set(TRACE_METADATA_KEY, traceId);
	return metadata;
}

async function invokeExecuteAction(options: {
	request: ActionRequest;
	metadata: grpc.Metadata;
	metrics: CapturingOtelMetrics;
	exchange: Exchange;
}): Promise<{
	error: grpc.ServiceError | null;
	response: ActionResponse | null | undefined;
}> {
	const handler = createExecuteActionHandler({
		policy: testPolicy,
		brokers: createPool(options.exchange),
		whitelistIps: ["*"],
		useVerity: false,
		verityProverUrl: "",
		otelMetrics: options.metrics.asOtelMetrics(),
	});
	let callbackResult:
		| {
				error: grpc.ServiceError | null;
				response: ActionResponse | null | undefined;
		  }
		| undefined;
	const call = {
		request: options.request,
		metadata: options.metadata,
		getPeer: () => "127.0.0.1:1234",
	} as unknown as grpc.ServerUnaryCall<ActionRequest, ActionResponse>;

	await handler(call, (error, response) => {
		callbackResult = { error, response };
	});

	if (!callbackResult) {
		throw new Error("ExecuteAction callback was not invoked");
	}
	return callbackResult;
}

type SubscribeCallFixture = {
	call: grpc.ServerWritableStream<SubscribeRequest, SubscribeResponse>;
	cancel: () => void;
};

function createSubscribeCall(
	request: SubscribeRequest,
	metadata: grpc.Metadata,
): SubscribeCallFixture {
	const emitter = new EventEmitter();
	let destroyed = false;
	let writableEnded = false;
	const call = Object.assign(emitter, {
		cancelled: false,
		metadata,
		request,
		getPeer: () => "127.0.0.1:1234",
		write: () => true,
		end: () => {
			writableEnded = true;
			emitter.emit("end");
		},
		destroy: () => {
			destroyed = true;
			emitter.emit("close");
		},
	});
	Object.defineProperties(call, {
		destroyed: { get: () => destroyed },
		writableEnded: { get: () => writableEnded },
	});
	emitter.on("error", () => {});

	return {
		call: call as unknown as grpc.ServerWritableStream<
			SubscribeRequest,
			SubscribeResponse
		>,
		cancel: () => {
			call.cancelled = true;
			emitter.emit("cancelled");
			call.destroy();
		},
	};
}

function findLogCall(
	calls: unknown[][],
	message: string,
): unknown[] | undefined {
	return calls.find(([candidate]) => candidate === message);
}

function expectNoTraceMetricDimension(metrics: CapturingOtelMetrics): void {
	for (const metric of [...metrics.counters, ...metrics.histograms]) {
		expect(metric.labels).not.toHaveProperty("trace_id");
	}
}

describe("FIET-601 operational trace correlation", () => {
	test("ExecuteAction logs one correlated success and keeps trace_id out of metrics", async () => {
		const info = spyOn(log, "info").mockImplementation(() => {});
		const error = spyOn(log, "error").mockImplementation(() => {});
		const metrics = new CapturingOtelMetrics();
		const exchange = {
			fetchTicker: async () => ({ symbol: "BTC/USDT", last: 100 }),
		} as unknown as Exchange;

		try {
			const result = await invokeExecuteAction({
				request: {
					action: Action.FetchTicker,
					cex: "Binance",
					symbol: "BTC/USDT",
				},
				metadata: metadataWithTraceId(` ${OTEL_TRACE_ID} `),
				metrics,
				exchange,
			});

			expect(result.error).toBeNull();
			expect(
				findLogCall(info.mock.calls, "ExecuteAction started")?.[1],
			).toEqual({
				action: "FetchTicker",
				cex: "binance",
				trace_id: OTEL_TRACE_ID,
			});
			const completionCalls = info.mock.calls.filter(
				([message]) => message === "ExecuteAction completed",
			);
			expect(completionCalls).toHaveLength(1);
			expect(completionCalls[0]?.[1]).toEqual({
				action: "FetchTicker",
				cex: "binance",
				latency_ms: expect.any(Number),
				outcome: "success",
				grpc_status: "OK",
				trace_id: OTEL_TRACE_ID,
			});
			expect(
				error.mock.calls.filter(
					([message]) => message === "ExecuteAction failed",
				),
			).toHaveLength(0);
			expectNoTraceMetricDimension(metrics);
		} finally {
			info.mockRestore();
			error.mockRestore();
		}
	});

	test("ExecuteAction logs one correlated error with a stable gRPC status", async () => {
		const info = spyOn(log, "info").mockImplementation(() => {});
		const error = spyOn(log, "error").mockImplementation(() => {});
		const metrics = new CapturingOtelMetrics();
		const exchange = {} as Exchange;

		try {
			const result = await invokeExecuteAction({
				request: { action: Action.FetchTicker, cex: "binance" },
				metadata: metadataWithTraceId(UUID_TRACE_ID),
				metrics,
				exchange,
			});

			expect(result.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
			const failureCalls = error.mock.calls.filter(
				([message]) => message === "ExecuteAction failed",
			);
			expect(failureCalls).toHaveLength(1);
			expect(failureCalls[0]?.[1]).toEqual({
				action: "FetchTicker",
				cex: "binance",
				latency_ms: expect.any(Number),
				outcome: "error",
				grpc_status: "INVALID_ARGUMENT",
				trace_id: UUID_TRACE_ID,
			});
			expect(
				info.mock.calls.filter(
					([message]) => message === "ExecuteAction completed",
				),
			).toHaveLength(0);
			expectNoTraceMetricDimension(metrics);
		} finally {
			info.mockRestore();
			error.mockRestore();
		}
	});

	test("invalid ExecuteAction metadata is omitted and does not affect RPC success", async () => {
		const info = spyOn(log, "info").mockImplementation(() => {});
		const error = spyOn(log, "error").mockImplementation(() => {});
		const metrics = new CapturingOtelMetrics();
		const invalidTraceId = `${"a".repeat(256)}-sensitive-suffix`;
		const exchange = {
			fetchTicker: async () => ({ symbol: "BTC/USDT", last: 100 }),
		} as unknown as Exchange;

		try {
			const result = await invokeExecuteAction({
				request: {
					action: Action.FetchTicker,
					cex: "binance",
					symbol: "BTC/USDT",
				},
				metadata: metadataWithTraceId(invalidTraceId),
				metrics,
				exchange,
			});

			expect(result.error).toBeNull();
			const boundaryCalls = info.mock.calls.filter(([message]) =>
				String(message).startsWith("ExecuteAction"),
			);
			expect(boundaryCalls).toHaveLength(2);
			for (const call of boundaryCalls) {
				expect(call[1]).not.toHaveProperty("trace_id");
			}
			expect(
				JSON.stringify([...info.mock.calls, ...error.mock.calls]),
			).not.toContain(invalidTraceId);
			expectNoTraceMetricDimension(metrics);
		} finally {
			info.mockRestore();
			error.mockRestore();
		}
	});

	test("Subscribe logs one correlated cancellation and keeps trace_id out of metrics", async () => {
		const info = spyOn(log, "info").mockImplementation(() => {});
		const error = spyOn(log, "error").mockImplementation(() => {});
		const metrics = new CapturingOtelMetrics();
		let resolveWatch!: (value: unknown) => void;
		const exchange = {
			watchBalance: () =>
				new Promise<unknown>((resolve) => {
					resolveWatch = resolve;
				}),
		} as unknown as Exchange;
		const fixture = createSubscribeCall(
			{
				cex: "MEXC",
				symbol: "USDT",
				type: SubscriptionType.BALANCE,
			},
			metadataWithTraceId(OTEL_TRACE_ID),
		);
		const handler = createSubscribeHandler({
			brokers: createPool(exchange, "mexc"),
			whitelistIps: ["*"],
			otelMetrics: metrics.asOtelMetrics(),
		});

		try {
			const handlerPromise = handler(fixture.call);
			await Promise.resolve();
			fixture.cancel();
			fixture.call.emit("error", new Error("late error"));
			fixture.call.emit("end");
			resolveWatch({ USDT: { total: 1 } });
			await handlerPromise;

			expect(findLogCall(info.mock.calls, "Subscribe started")?.[1]).toEqual({
				cex: "mexc",
				symbol: "USDT",
				subscription_type: "BALANCE",
				trace_id: OTEL_TRACE_ID,
			});
			const terminalCalls = [...info.mock.calls, ...error.mock.calls].filter(
				([message]) =>
					message === "Subscribe ended" ||
					message === "Subscribe cancelled" ||
					message === "Subscribe failed",
			);
			expect(terminalCalls).toHaveLength(1);
			expect(terminalCalls[0]?.[1]).toEqual({
				cex: "mexc",
				symbol: "USDT",
				subscription_type: "BALANCE",
				duration_ms: expect.any(Number),
				outcome: "cancelled",
				trace_id: OTEL_TRACE_ID,
			});
			expectNoTraceMetricDimension(metrics);
		} finally {
			info.mockRestore();
			error.mockRestore();
		}
	});

	test("Subscribe logs a correlated terminal error", async () => {
		const info = spyOn(log, "info").mockImplementation(() => {});
		const error = spyOn(log, "error").mockImplementation(() => {});
		const metrics = new CapturingOtelMetrics();
		const exchange = {
			watchBalance: async () => {
				throw new Error("venue unavailable");
			},
		} as unknown as Exchange;
		const fixture = createSubscribeCall(
			{
				cex: "mexc",
				symbol: "USDT",
				type: SubscriptionType.BALANCE,
			},
			metadataWithTraceId(UUID_TRACE_ID),
		);
		const handler = createSubscribeHandler({
			brokers: createPool(exchange, "mexc"),
			whitelistIps: ["*"],
			otelMetrics: metrics.asOtelMetrics(),
		});

		try {
			await handler(fixture.call);

			const failureCalls = error.mock.calls.filter(
				([message]) => message === "Subscribe failed",
			);
			expect(failureCalls).toHaveLength(1);
			expect(failureCalls[0]?.[1]).toEqual({
				cex: "mexc",
				symbol: "USDT",
				subscription_type: "BALANCE",
				duration_ms: expect.any(Number),
				outcome: "error",
				trace_id: UUID_TRACE_ID,
			});
			expectNoTraceMetricDimension(metrics);
		} finally {
			info.mockRestore();
			error.mockRestore();
		}
	});
});
