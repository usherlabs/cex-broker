import * as grpc from "@grpc/grpc-js";
import { SubscriptionType } from "../../src/helpers/constants";
import { log } from "../../src/helpers/logger";
import type { OtelMetrics } from "../../src/helpers/otel";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../../src/proto-package-definition";
import type { MarketDataSubscription } from "./config";

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
	subscriptions: MarketDataSubscription[];
	metrics?: CollectorMetrics;
	retry?: Partial<RetryPolicy>;
};

type CollectorSubscription = MarketDataSubscription;

export type CollectorFeedHealth = {
	state: "connecting" | "healthy" | "backoff" | "stopped";
	lastFrameAtMs?: number;
	reconnectCount: number;
	gapCount: number;
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

function pairLabels(subscription: CollectorSubscription) {
	return {
		exchange: subscription.exchange,
		symbol: subscription.symbol,
		feed: subscription.feed,
		...(subscription.feed === "OHLCV"
			? { timeframe: subscription.timeframe }
			: {}),
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
	readonly #subscriptions: CollectorSubscription[];
	readonly #metrics?: CollectorMetrics;
	readonly #retry: RetryPolicy;
	readonly #health = new Map<string, CollectorFeedHealth>();
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

	getHealthSnapshot(): Readonly<Record<string, CollectorFeedHealth>> {
		return Object.fromEntries(
			[...this.#health.entries()].map(([key, value]) => [key, { ...value }]),
		);
	}

	#healthKey(subscription: CollectorSubscription): string {
		return `${subscription.exchange}:${subscription.symbol}:${subscription.feed}`;
	}

	#updateHealth(
		subscription: CollectorSubscription,
		update: Partial<CollectorFeedHealth>,
	): void {
		const key = this.#healthKey(subscription);
		this.#health.set(key, {
			state: "connecting",
			reconnectCount: 0,
			gapCount: 0,
			...(this.#health.get(key) ?? {}),
			...update,
		});
	}

	async run(signal: AbortSignal): Promise<void> {
		if (this.#started) {
			throw new Error("OHLCV collector can only be started once");
		}
		this.#started = true;
		try {
			await Promise.all(
				this.#subscriptions.map((subscription) =>
					this.#keepSupervisorAlive(subscription, signal),
				),
			);
		} finally {
			for (const subscription of this.#subscriptions) {
				this.#updateHealth(subscription, { state: "stopped" });
			}
			this.#client.close();
		}
	}

	async #keepSupervisorAlive(
		subscription: CollectorSubscription,
		signal: AbortSignal,
	): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.#supervise(subscription, signal);
				return;
			} catch (error) {
				log.error("OHLCV collector pair supervisor failed; restarting", {
					...pairLabels(subscription),
					error,
				});
				if (!(await waitForDelay(this.#retry.initialDelayMs, signal))) {
					return;
				}
			}
		}
	}

	async #supervise(
		subscription: CollectorSubscription,
		signal: AbortSignal,
	): Promise<void> {
		let consecutiveFailures = 0;
		let subscriptionCount = 0;
		const labels = pairLabels(subscription);

		while (!signal.aborted) {
			this.#updateHealth(subscription, { state: "connecting" });
			if (subscriptionCount > 0) {
				const health = this.#health.get(this.#healthKey(subscription));
				this.#updateHealth(subscription, {
					reconnectCount: (health?.reconnectCount ?? 0) + 1,
				});
				void this.#metrics?.recordCounter(
					"cex_market_data_collector_reconnects_total",
					1,
					labels,
				);
				if (subscription.feed === "OHLCV") {
					void this.#metrics?.recordCounter(
						"cex_ohlcv_collector_reconnects_total",
						1,
						labels,
					);
				} else {
					const gapCount = (health?.gapCount ?? 0) + 1;
					this.#updateHealth(subscription, { gapCount });
					void this.#metrics?.recordCounter(
						"cex_market_data_collector_unrecoverable_gaps_total",
						1,
						labels,
					);
					log.warn("Market-data collector recorded unrecoverable feed gap", {
						...labels,
						gap_count: gapCount,
					});
				}
			}
			subscriptionCount += 1;
			log.info("Market-data collector subscription opened", {
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
			this.#updateHealth(subscription, { state: "backoff" });
			const errorFields =
				result.reason === "error"
					? { grpc_code: result.error.code, error: result.error.message }
					: {};
			log.warn("Market-data collector stream closed; reconnect scheduled", {
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
		subscription: CollectorSubscription,
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
				const options =
					subscription.feed === "ORDERBOOK"
						? { depthLimit: String(subscription.depthLimit) }
						: subscription.feed === "OHLCV"
							? {
									timeframe: subscription.timeframe,
									...(subscription.bootstrapLimit === undefined
										? {}
										: {
												bootstrapLimit: String(subscription.bootstrapLimit),
											}),
								}
							: {};
				stream = this.#client.Subscribe({
					cex: subscription.exchange,
					symbol: subscription.symbol,
					type: SubscriptionType[subscription.feed],
					options,
				});
			} catch (error) {
				settle({ reason: "error", error: error as grpc.ServiceError });
				return;
			}

			stream.on("data", (response) => {
				const frames =
					subscription.feed === "OHLCV"
						? countOhlcvBars(response.data)
						: response.data.length > 0
							? 1
							: 0;
				if (frames === 0) {
					return;
				}
				this.#updateHealth(subscription, {
					state: "healthy",
					lastFrameAtMs: Date.now(),
				});
				void this.#metrics?.recordCounter(
					"cex_market_data_collector_frames_received_total",
					frames,
					pairLabels(subscription),
				);
				if (subscription.feed === "OHLCV") {
					void this.#metrics?.recordCounter(
						"cex_ohlcv_collector_bars_received_total",
						frames,
						pairLabels(subscription),
					);
				}
				log.debug("Market-data collector frames received", {
					...pairLabels(subscription),
					frames,
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

export const MarketDataCollector = OhlcvCollector;
