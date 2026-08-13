import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { Action } from "../src/helpers/constants";
import { TRACE_METADATA_KEY } from "../src/helpers/trace-context";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";
import {
	bindServer,
	CapturingOtelMetrics,
	createBinancePool,
	executeAction,
	grpcObj,
} from "./order-telemetry-fixtures";

const testPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: ["*"], limits: [] } },
};

function createClient(port: number) {
	return new grpcObj.cex_broker.cex_service(
		`127.0.0.1:${port}`,
		grpc.credentials.createInsecure(),
	);
}

function executeActionWithMetadata(
	client: InstanceType<typeof grpcObj.cex_broker.cex_service>,
	request: Record<string, unknown>,
	metadata: grpc.Metadata,
) {
	return new Promise<{ result: string; proof: string }>((resolve, reject) => {
		(
			client.ExecuteAction as unknown as (
				request: Record<string, unknown>,
				metadata: grpc.Metadata,
				callback: grpc.requestCallback<{ result: string; proof: string }>,
			) => void
		)(request, metadata, (error, response) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(response as { result: string; proof: string });
		});
	});
}

describe("ExecuteAction x-trace-id propagation", () => {
	let server: grpc.Server | undefined;
	let client: InstanceType<typeof grpcObj.cex_broker.cex_service> | undefined;

	afterEach(async () => {
		client?.close();
		if (server) {
			await server.forceShutdown();
		}
	});

	test("attaches x-trace-id to request metrics", async () => {
		const metrics = new CapturingOtelMetrics();
		const exchange = {
			has: { fetchTicker: true },
			fetchTicker: async () => ({
				symbol: "BTC/USDT",
				last: 1,
				bid: 1,
				ask: 1,
			}),
		} as unknown as Exchange;

		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
		);
		client = createClient(await bindServer(server));

		const metadata = new grpc.Metadata();
		metadata.set(TRACE_METADATA_KEY, "prover-trace-abc");

		await executeActionWithMetadata(
			client,
			{
				action: Action.FetchTicker,
				cex: "binance",
				symbol: "BTC/USDT",
			},
			metadata,
		);

		const requestMetric = metrics.counters.find(
			(entry) => entry.name === "execute_action_requests_total",
		);
		expect(requestMetric?.labels.trace_id).toBe("prover-trace-abc");

		const successMetric = metrics.counters.find(
			(entry) => entry.name === "execute_action_success_total",
		);
		expect(successMetric?.labels.trace_id).toBe("prover-trace-abc");
	});

	test("omits trace_id metric label when metadata is absent", async () => {
		const metrics = new CapturingOtelMetrics();
		const exchange = {
			has: { fetchTicker: true },
			fetchTicker: async () => ({
				symbol: "BTC/USDT",
				last: 1,
				bid: 1,
				ask: 1,
			}),
		} as unknown as Exchange;

		server = getServer(
			testPolicy,
			createBinancePool(exchange),
			["*"],
			false,
			"",
			metrics.asOtelMetrics(),
		);
		client = createClient(await bindServer(server));

		await executeAction(client, {
			action: Action.FetchTicker,
			cex: "binance",
			symbol: "BTC/USDT",
		});

		const requestMetric = metrics.counters.find(
			(entry) => entry.name === "execute_action_requests_total",
		);
		expect(requestMetric?.labels.trace_id).toBeUndefined();
	});
});
