import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Exchange } from "@usherlabs/ccxt";
import type { BrokerPoolEntry } from "../src/helpers/index";
import type { OtelMetrics } from "../src/helpers/otel";
import { PROTO_LOADER_OPTIONS } from "../src/proto-loader-options";

const packageDef = protoLoader.loadSync(
	"src/proto/node.proto",
	PROTO_LOADER_OPTIONS,
);

export const grpcObj = grpc.loadPackageDefinition(packageDef) as {
	cex_broker: {
		cex_service: new (
			address: string,
			credentials: grpc.ChannelCredentials,
		) => {
			ExecuteAction(
				request: Record<string, unknown>,
				callback: grpc.requestCallback<{ result: string; proof: string }>,
			): void;
			close(): void;
		};
	};
};

export type TelemetryMetricCall = {
	name: string;
	value: number;
	labels: Record<string, string | number>;
};

export class CapturingOtelMetrics {
	readonly counters: TelemetryMetricCall[] = [];
	readonly histograms: TelemetryMetricCall[] = [];

	async recordCounter(
		name: string,
		value: number,
		labels: Record<string, string | number>,
	) {
		this.counters.push({ name, value, labels });
	}

	async recordHistogram(
		name: string,
		value: number,
		labels: Record<string, string | number>,
	) {
		this.histograms.push({ name, value, labels });
	}

	asOtelMetrics(): OtelMetrics {
		return this as unknown as OtelMetrics;
	}
}

export function createOrderExchangeFixture(options: {
	createOrderResult?: unknown;
	fetchOrderResult?: unknown;
	createOrderError?: Error;
}) {
	const calls: Record<string, unknown[][]> = {
		createOrder: [],
		fetchOrder: [],
	};
	const exchange: Record<string, unknown> = {
		markets: {
			"ARB/USDT": {},
		},
		loadMarkets: async () => undefined,
		market: (symbol: string) => {
			if (symbol !== "ARB/USDT") {
				throw new Error(`unsupported symbol ${symbol}`);
			}
			return { symbol, base: "ARB", quote: "USDT" };
		},
		createOrder: async (...args: unknown[]) => {
			calls.createOrder.push(args);
			if (options.createOrderError) {
				throw options.createOrderError;
			}
			return options.createOrderResult;
		},
		fetchOrder: async (...args: unknown[]) => {
			calls.fetchOrder.push(args);
			return options.fetchOrderResult;
		},
	};
	return { exchange: exchange as Exchange, calls };
}

export function createBinancePool(
	exchange: Exchange,
): Record<string, BrokerPoolEntry> {
	return {
		binance: {
			primary: { exchange, label: "primary" },
			secondaryBrokers: [],
		},
	};
}

export function bindServer(server: grpc.Server) {
	return new Promise<number>((resolve, reject) => {
		server.bindAsync(
			"127.0.0.1:0",
			grpc.ServerCredentials.createInsecure(),
			(error, port) => {
				if (error) {
					reject(error);
					return;
				}
				server.start();
				resolve(port);
			},
		);
	});
}

export function executeAction(
	client: InstanceType<typeof grpcObj.cex_broker.cex_service>,
	request: Record<string, unknown>,
) {
	return new Promise<{ result: string; proof: string }>((resolve, reject) => {
		client.ExecuteAction(request, (error, response) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(response as { result: string; proof: string });
		});
	});
}
