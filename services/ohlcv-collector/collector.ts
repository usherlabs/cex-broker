import * as grpc from "@grpc/grpc-js";
import { SubscriptionType } from "../../src/helpers/constants";
import { log } from "../../src/helpers/logger";
import type { OtelMetrics } from "../../src/helpers/otel";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../../src/proto-package-definition";
import type { OhlcvSubscription } from "./config";

type SubscribeResponse = {
	data: string;
	timestamp: string;
	symbol: string;
	type: string;
};

type SubscribeClient = grpc.Client & {
	Subscribe(
		request: Record<string, unknown>,
	): grpc.ClientReadableStream<SubscribeResponse>;
};

type CollectorMetrics = Pick<OtelMetrics, "recordCounter">;

export type OhlcvCollectorOptions = {
	brokerUrl: string;
	subscriptions: OhlcvSubscription[];
	metrics?: CollectorMetrics;
	retry?: Partial<RetryPolicy>;
};

type RetryPolicy = {
	initialDelayMs: number;
	maxDelayMs: number;
	jitterRatio: number;
	random: () => number;
};

type StreamResult =
	| { reason: "aborted" }
	| { reason: "end" | "close" }
	| { reason: "error"; error: grpc.ServiceError };

const DEFAULT_RETRY_POLICY: RetryPolicy = {
	initialDelayMs: 1_000,
	maxDelayMs: 60_000,
	jitterRatio: 0.2,
	random: Math.random,
};
const BACKOFF_RESET_AFTER_MS = 60_000;

const grpcObject = grpc.loadPackageDefinition(
	CEX_BROKER_PACKAGE_DEFINITION,
) as unknown as {
	cex_broker: {
		cex_service: new (
			address: string,
			credentials: grpc.ChannelCredentials,
		) => SubscribeClient;
	};
};

function pairLabels(subscription: OhlcvSubscription) {
	return {
		exchange: subscription.exchange,
		symbol: subscription.symbol,
		timeframe: subscription.timeframe,
	};
}

function countOhlcvBars(data: string): number {
	try {
		const payload = JSON.parse(data) as unknown;
		if (!Array.isArray(payload) || payload.length === 0) {
			return 0;
		}
		if (Array.isArray(payload[0])) {
			return payload.filter((bar) => Array.isArray(bar) && bar.length >= 6)
				.length;
		}
		return payload.length >= 6 ? 1 : 0;
	} catch {
		return 0;
	}
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) {
		return Promise.resolve(false);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export class OhlcvCollector {
	readonly #client: SubscribeClient;
	readonly #subscriptions: OhlcvSubscription[];
	readonly #metrics?: CollectorMetrics;
	readonly #retry: RetryPolicy;
	#started = false;

	constructor(options: OhlcvCollectorOptions) {
		this.#subscriptions = options.subscriptions;
		this.#metrics = options.metrics;
		this.#retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
		this.#client = new grpcObject.cex_broker.cex_service(
			options.brokerUrl,
			grpc.credentials.createInsecure(),
		);
	}

	async run(signal: AbortSignal): Promise<void> {
		if (this.#started) {
			throw new Error("OHLCV collector can only be started once");
		}
		this.#started = true;
		try {
			await Promise.all(
				this.#subscriptions.map((subscription) =>
					this.#supervise(subscription, signal),
				),
			);
		} finally {
			this.#client.close();
		}
	}

	async #supervise(
		subscription: OhlcvSubscription,
		signal: AbortSignal,
	): Promise<void> {
		let consecutiveFailures = 0;
		let subscriptionCount = 0;
		const labels = pairLabels(subscription);

		while (!signal.aborted) {
			if (subscriptionCount > 0) {
				void this.#metrics?.recordCounter(
					"cex_ohlcv_collector_reconnects_total",
					1,
					labels,
				);
			}
			subscriptionCount += 1;
			log.info("OHLCV collector subscription opened", {
				...labels,
				subscription_attempt: subscriptionCount,
			});

			const openedAt = Date.now();
			const result = await this.#openStream(subscription, signal);
			if (result.reason === "aborted" || signal.aborted) {
				break;
			}

			if (Date.now() - openedAt >= BACKOFF_RESET_AFTER_MS) {
				consecutiveFailures = 0;
			}
			consecutiveFailures += 1;
			const delayMs = this.#retryDelay(consecutiveFailures);
			const errorFields =
				result.reason === "error"
					? { grpc_code: result.error.code, error: result.error.message }
					: {};
			log.warn("OHLCV collector stream closed; reconnect scheduled", {
				...labels,
				reason: result.reason,
				delay_ms: delayMs,
				...errorFields,
			});
			if (!(await waitForDelay(delayMs, signal))) {
				break;
			}
		}
	}

	#openStream(
		subscription: OhlcvSubscription,
		signal: AbortSignal,
	): Promise<StreamResult> {
		return new Promise((resolve) => {
			let settled = false;
			let stream: grpc.ClientReadableStream<SubscribeResponse>;
			const settle = (result: StreamResult) => {
				if (settled) {
					return;
				}
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const onAbort = () => {
				stream.cancel();
				settle({ reason: "aborted" });
			};

			try {
				stream = this.#client.Subscribe({
					cex: subscription.exchange,
					symbol: subscription.symbol,
					type: SubscriptionType.OHLCV,
					options: { timeframe: subscription.timeframe },
				});
			} catch (error) {
				settle({ reason: "error", error: error as grpc.ServiceError });
				return;
			}

			stream.on("data", (response) => {
				const bars = countOhlcvBars(response.data);
				if (bars === 0) {
					return;
				}
				void this.#metrics?.recordCounter(
					"cex_ohlcv_collector_bars_received_total",
					bars,
					pairLabels(subscription),
				);
				log.debug("OHLCV collector bars received", {
					...pairLabels(subscription),
					bars,
				});
			});
			stream.on("error", (error: grpc.ServiceError) => {
				settle({ reason: "error", error });
			});
			stream.on("end", () => settle({ reason: "end" }));
			stream.on("close", () => settle({ reason: "close" }));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
			}
		});
	}

	#retryDelay(consecutiveFailures: number): number {
		const exponent = Math.min(consecutiveFailures - 1, 30);
		const baseDelay = Math.min(
			this.#retry.maxDelayMs,
			this.#retry.initialDelayMs * 2 ** exponent,
		);
		const jitter = 1 + (this.#retry.random() * 2 - 1) * this.#retry.jitterRatio;
		return Math.max(0, Math.round(baseDelay * jitter));
	}
}
