import type { Metadata } from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import {
	type BrokerPoolEntry,
	createBroker,
	createPublicBroker,
} from "../broker";
import type { BrokerExecutionArchiver } from "../broker-execution-archive";
import {
	SubscriptionType,
	type SubscriptionType as SubscriptionTypeValue,
} from "../constants";
import { log } from "../logger";
import {
	archiveOhlcvInBackground,
	archiveOrderbookInBackground,
	archiveTickerInBackground,
	archiveTradesInBackground,
	createOhlcvBarTracker,
	createOrderbookSampler,
	getOrderbookArchiveDepthLimit,
	getOrderbookIntervalMs,
	getOrderbookMeasurementBandsBps,
	type OhlcvArchiveInput,
	type OhlcvBarTracker,
	type OrderbookArchiveInput,
	type TickerArchiveInput,
	type TradesArchiveInput,
} from "../market-data-archive";
import {
	type BrokerMarketType,
	parseMarketType,
	resolveSubscriptionSymbol,
} from "../market-type";
import { normalizeOrderBookSnapshot } from "../order-book";
import type { OtelMetrics } from "../otel";
import {
	buildPublicFeedKey,
	normalizePublicExchange,
	type PublicFeedName,
	resolvePublicOhlcvTimeframe,
} from "./identity";
import {
	type OrderBookAcquisitionProfile,
	type OrderBookAcquisitionProfileInput,
	projectOrderBookSnapshot,
	resolveOrderBookAcquisitionProfile,
} from "./orderbook-profile";
import {
	type PublicFeedFrame,
	PublicFeedSubscriberBuffer,
	type PublicFeedSubscriberBufferOptions,
} from "./subscriber-buffer";

const DEFAULT_RETIREMENT_TIMEOUT_MS = 5_000;

export type PublicFeedArchiveContext = {
	deploymentId: string;
	exchange: string;
	symbol: string;
	assetType: BrokerMarketType;
	accountSelector?: string;
};

export interface PublicMarketDataArchiveSink {
	orderbook(
		input: OrderbookArchiveInput,
		options: { sampledOut: boolean },
	): void;
	ticker(input: TickerArchiveInput): void;
	trades(input: TradesArchiveInput): void;
	ohlcv(tracker: OhlcvBarTracker, input: OhlcvArchiveInput): void;
	ohlcvBootstrap(tracker: OhlcvBarTracker, input: OhlcvArchiveInput): void;
}

type Metrics = Pick<OtelMetrics, "recordCounter"> &
	Partial<Pick<OtelMetrics, "recordGauge">>;

export type PublicMarketDataFeedSupervisorOptions = {
	brokers: Record<string, BrokerPoolEntry>;
	brokerArchiver?: BrokerExecutionArchiver;
	otelMetrics?: OtelMetrics;
	archiveSink?: PublicMarketDataArchiveSink;
	metrics?: Metrics;
	bufferLimits?: PublicFeedSubscriberBufferOptions;
	retirementTimeoutMs?: number;
	createRequestBroker?: (
		exchange: string,
		metadata: Metadata | undefined,
	) => Exchange | null;
	createPublicBroker?: (exchange: string) => Exchange | null;
	resolveOrderBookProfile?: (
		input: OrderBookAcquisitionProfileInput,
	) => OrderBookAcquisitionProfile;
	enabledOrderBookProfileIds?: ReadonlySet<string>;
	observer?: PublicMarketDataFeedObserver;
};

export type PublicFeedObservation = {
	key: string;
	exchange: string;
	feed: PublicFeedName;
	marketType: BrokerMarketType;
	profile?: string;
	subscriberCount: number;
};

export interface PublicMarketDataFeedObserver {
	workerStarted?(observation: PublicFeedObservation): void;
	subscriberAttached?(observation: PublicFeedObservation): void;
	physicalFrame?(observation: PublicFeedObservation): void;
	archiveDecision?(observation: PublicFeedObservation): void;
	delivered?(observation: PublicFeedObservation): void;
	overflow?(observation: PublicFeedObservation): void;
	workerRetired?(observation: PublicFeedObservation): void;
}

export type PublicFeedSubscribeOptions = {
	exchange: string;
	symbol: string;
	marketType?: string;
	feed: PublicFeedName;
	depthLimit?: number;
	timeframe?: string;
	bootstrapLimit?: number;
	metadata?: Metadata;
};

export interface PublicMarketDataSubscription
	extends AsyncIterable<PublicFeedFrame> {
	readonly key: string;
	readonly acquisitionProfileId?: string;
	close(): void;
}

type ExchangeResolution = {
	exchange: Exchange;
	owned: boolean;
	accountSelector?: string;
};

function createDefaultArchiveSink(
	archiver: BrokerExecutionArchiver | undefined,
	metrics: OtelMetrics | undefined,
): PublicMarketDataArchiveSink {
	return {
		orderbook: (input, options) =>
			archiveOrderbookInBackground(archiver, metrics, input, options),
		ticker: (input) => archiveTickerInBackground(archiver, metrics, input),
		trades: (input) => archiveTradesInBackground(archiver, metrics, input),
		ohlcv: (tracker, input) =>
			archiveOhlcvInBackground(archiver, metrics, tracker, input),
		ohlcvBootstrap: (tracker, input) =>
			archiveOhlcvInBackground(archiver, metrics, tracker, {
				...input,
				sourceMode: "broker_bootstrap_fetch_v1",
			}),
	};
}

function subscriptionType(feed: PublicFeedName): SubscriptionTypeValue {
	switch (feed) {
		case "ORDERBOOK":
			return SubscriptionType.ORDERBOOK;
		case "TRADES":
			return SubscriptionType.TRADES;
		case "TICKER":
			return SubscriptionType.TICKER;
		case "OHLCV":
			return SubscriptionType.OHLCV;
	}
}

class PublicSubscriber implements PublicMarketDataSubscription {
	readonly buffer: PublicFeedSubscriberBuffer;
	#closed = false;

	constructor(
		readonly key: string,
		readonly acquisitionProfileId: string | undefined,
		bufferOptions: PublicFeedSubscriberBufferOptions,
		private readonly onClose: (subscriber: PublicSubscriber) => void,
		readonly depthLimit?: number,
	) {
		this.buffer = new PublicFeedSubscriberBuffer(bufferOptions);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.buffer.close();
		this.onClose(this);
	}

	fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.buffer.fail(error);
	}

	[Symbol.asyncIterator](): AsyncIterator<PublicFeedFrame> {
		return this.buffer[Symbol.asyncIterator]();
	}
}

type WorkerOptions = {
	key: string;
	exchangeName: string;
	exchange: Exchange;
	exchangeOwned: boolean;
	accountSelector?: string;
	symbol: string;
	marketType: BrokerMarketType;
	feed: PublicFeedName;
	timeframe?: string;
	profile?: OrderBookAcquisitionProfile;
	archiveDepth: number;
	deploymentId: string;
	archiveSink: PublicMarketDataArchiveSink;
	metrics?: Metrics;
	observer?: PublicMarketDataFeedObserver;
	bufferLimits: PublicFeedSubscriberBufferOptions;
	retirementTimeoutMs: number;
	onRetire: (worker: PublicFeedWorker, cleanup: Promise<void>) => void;
};

class PublicFeedWorker {
	readonly #subscribers = new Set<PublicSubscriber>();
	readonly #tracker = createOhlcvBarTracker();
	readonly #sampler = createOrderbookSampler();
	#retired = false;
	#started = false;
	#run: Promise<void> | null = null;
	#inFlight: Promise<unknown> | null = null;
	#cleanup: Promise<void> | null = null;
	#bootstrapState: "unclaimed" | "in-flight" | "complete" = "unclaimed";
	#archiveBootstrapAttempt: Promise<void> | null = null;

	constructor(readonly options: WorkerOptions) {}

	async subscribe(
		input: PublicFeedSubscribeOptions,
	): Promise<PublicSubscriber> {
		if (this.#retired) throw new Error("Public market-data worker is retiring");
		const subscriber = new PublicSubscriber(
			this.options.key,
			this.options.profile?.id,
			this.options.bufferLimits,
			(candidate) => this.#remove(candidate),
			input.depthLimit,
		);

		if (this.options.feed === "OHLCV" && (input.bootstrapLimit ?? 0) > 0) {
			await this.#prepareBootstrap(subscriber, input.bootstrapLimit as number);
		}
		if (this.#retired) {
			subscriber.close();
			throw new Error("Public market-data worker retired during bootstrap");
		}
		this.#subscribers.add(subscriber);
		this.#recordGauge("public_feed_active_subscribers", this.#subscribers.size);
		this.options.observer?.subscriberAttached?.(this.#observation());
		this.#start();
		return subscriber;
	}

	retire(): Promise<void> {
		if (this.#cleanup) return this.#cleanup;
		this.#retired = true;
		this.options.observer?.workerRetired?.(this.#observation());
		for (const subscriber of [...this.#subscribers]) subscriber.close();
		this.#cleanup = this.#cleanupResources();
		return this.#cleanup;
	}

	#start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#recordCounter("public_feed_physical_workers_started_total");
		this.options.observer?.workerStarted?.(this.#observation());
		if (this.options.profile) {
			void this.options.metrics?.recordCounter(
				"public_feed_acquisition_profiles_total",
				1,
				{
					...this.#metricLabels(),
					profile: this.options.profile.id,
				},
			);
		}
		this.#run = this.#watchLoop();
	}

	async #watchLoop(): Promise<void> {
		while (!this.#retired) {
			try {
				const watch = this.#watch();
				this.#inFlight = watch;
				const payload = await watch;
				if (this.#inFlight === watch) this.#inFlight = null;
				if (this.#retired) return;
				if (
					this.options.feed === "OHLCV" &&
					this.#bootstrapState === "in-flight" &&
					this.#archiveBootstrapAttempt
				) {
					await this.#archiveBootstrapAttempt;
					if (this.#retired) return;
				}
				this.#accept(payload);
			} catch (error) {
				this.#inFlight = null;
				if (this.#retired) return;
				const message =
					error instanceof Error
						? error.message
						: "Unknown public feed failure";
				this.#failSubscribers(
					new Error(
						`Failed to fetch ${this.options.feed === "OHLCV" ? "OHLCV" : this.options.feed.toLowerCase()}: ${message}`,
					),
				);
				this.options.onRetire(this, this.retire());
				return;
			}
		}
	}

	#watch(): Promise<unknown> {
		const exchange = this.options.exchange;
		switch (this.options.feed) {
			case "ORDERBOOK":
				if (this.options.profile?.upstreamLimit === undefined) {
					return exchange.watchOrderBook(this.options.symbol);
				}
				return this.options.profile.upstreamOptions === undefined
					? exchange.watchOrderBook(
							this.options.symbol,
							this.options.profile.upstreamLimit,
						)
					: exchange.watchOrderBook(
							this.options.symbol,
							this.options.profile.upstreamLimit,
							this.options.profile.upstreamOptions,
						);
			case "TICKER":
				return exchange.watchTicker(this.options.symbol);
			case "TRADES":
				return exchange.watchTrades(this.options.symbol);
			case "OHLCV":
				return exchange.watchOHLCV(this.options.symbol, this.options.timeframe);
		}
	}

	#accept(payload: unknown): void {
		const receivedTimestamp = Date.now();
		this.#recordCounter("public_feed_physical_frames_total");
		this.options.observer?.physicalFrame?.(this.#observation());
		const context: PublicFeedArchiveContext = {
			deploymentId: this.options.deploymentId,
			exchange: this.options.exchangeName,
			symbol: this.options.symbol,
			assetType: this.options.marketType,
			accountSelector: this.options.accountSelector,
		};

		if (this.options.feed === "ORDERBOOK") {
			const record = payload as { bids?: unknown[]; asks?: unknown[] };
			const retainedDepth = Math.max(
				Array.isArray(record?.bids) ? record.bids.length : 0,
				Array.isArray(record?.asks) ? record.asks.length : 0,
			);
			const snapshot = normalizeOrderBookSnapshot(payload, {
				exchange: this.options.exchangeName,
				symbol: this.options.symbol,
				depthLimit: retainedDepth,
				receivedTimestamp,
			});
			const observedBidCount = snapshot.bids.length;
			const observedAskCount = snapshot.asks.length;
			this.options.archiveSink.orderbook(
				{
					...context,
					snapshot,
					archiveMetadata: {
						captureProfileId:
							this.options.profile?.id ??
							`${this.options.exchangeName}:conservative:default`,
						effectiveCadenceMs: getOrderbookIntervalMs(),
						requestedUpstreamDepth:
							this.options.profile?.upstreamLimit ?? null,
						observedBidCount,
						observedAskCount,
						observedFarthestBid: snapshot.bids.at(-1)?.[0] ?? Number.NaN,
						observedFarthestAsk: snapshot.asks.at(-1)?.[0] ?? Number.NaN,
						bidExhausted:
							this.options.profile?.bidExhaustionEvidence ?? false,
						askExhausted:
							this.options.profile?.askExhaustionEvidence ?? false,
						measurementBandsBps: getOrderbookMeasurementBandsBps(),
					},
				},
				{ sampledOut: !this.#sampler.shouldEmit(receivedTimestamp) },
			);
			this.#recordCounter("public_feed_archive_decisions_total");
			this.options.observer?.archiveDecision?.(this.#observation());
			this.#fanout((subscriber) =>
				this.#frame(
					projectOrderBookSnapshot(snapshot, subscriber.depthLimit),
					receivedTimestamp,
				),
			);
			return;
		}

		if (this.options.feed === "TICKER") {
			this.options.archiveSink.ticker({
				...context,
				payload,
				receivedTimestamp,
			});
		} else if (this.options.feed === "TRADES") {
			this.options.archiveSink.trades({
				...context,
				payload,
				receivedTimestamp,
			});
		} else {
			this.options.archiveSink.ohlcv(this.#tracker, {
				...context,
				timeframe: this.options.timeframe ?? "1m",
				payload,
				receivedTimestamp,
			});
		}
		this.#recordCounter("public_feed_archive_decisions_total");
		this.options.observer?.archiveDecision?.(this.#observation());
		this.#fanout(() => this.#frame(payload, receivedTimestamp));
	}

	#frame(payload: unknown, timestamp: number): PublicFeedFrame {
		return {
			data: JSON.stringify(payload),
			timestamp,
			symbol: this.options.symbol,
			type: subscriptionType(this.options.feed),
		};
	}

	#fanout(project: (subscriber: PublicSubscriber) => PublicFeedFrame): void {
		for (const subscriber of [...this.#subscribers]) {
			if (subscriber.buffer.enqueue(project(subscriber))) {
				this.options.observer?.delivered?.(this.#observation());
				continue;
			}
			this.#subscribers.delete(subscriber);
			this.#recordCounter("public_feed_subscriber_overflow_total");
			this.options.observer?.overflow?.(this.#observation());
		}
		this.#recordGauge("public_feed_active_subscribers", this.#subscribers.size);
		if (this.#subscribers.size === 0) {
			this.options.onRetire(this, this.retire());
		}
	}

	#remove(subscriber: PublicSubscriber): void {
		this.#subscribers.delete(subscriber);
		this.#recordGauge("public_feed_active_subscribers", this.#subscribers.size);
		if (this.#subscribers.size === 0 && this.#started && !this.#retired) {
			this.options.onRetire(this, this.retire());
		}
	}

	#failSubscribers(error: Error): void {
		for (const subscriber of [...this.#subscribers]) subscriber.fail(error);
		this.#subscribers.clear();
		this.#recordGauge("public_feed_active_subscribers", 0);
	}

	async #prepareBootstrap(
		subscriber: PublicSubscriber,
		limit: number,
	): Promise<void> {
		if (this.#bootstrapState === "in-flight") {
			await this.#archiveBootstrapAttempt;
			const stateAfterAttempt: string = this.#bootstrapState;
			if (stateAfterAttempt === "unclaimed") {
				return this.#prepareBootstrap(subscriber, limit);
			}
		}
		if (this.#bootstrapState === "unclaimed") {
			this.#bootstrapState = "in-flight";
			const attempt = this.#fetchBootstrap(subscriber, limit, true);
			this.#archiveBootstrapAttempt = attempt;
			try {
				await attempt;
			} finally {
				if (this.#archiveBootstrapAttempt === attempt) {
					this.#archiveBootstrapAttempt = null;
				}
			}
			return;
		}
		await this.#fetchBootstrap(subscriber, limit, false);
	}

	async #fetchBootstrap(
		subscriber: PublicSubscriber,
		limit: number,
		ownsArchive: boolean,
	): Promise<void> {
		// SAFETY: CCXT exchange typings omit optional runtime methods exposed by
		// individual adapters; this branch checks the property before invocation.
		const fetch = (this.options.exchange as unknown as { fetchOHLCV?: unknown })
			.fetchOHLCV;
		if (typeof fetch !== "function") {
			if (ownsArchive) this.#bootstrapState = "unclaimed";
			return;
		}
		try {
			const payload = await fetch.call(
				this.options.exchange,
				this.options.symbol,
				this.options.timeframe,
				undefined,
				limit,
			);
			if (!Array.isArray(payload) || payload.length === 0) {
				if (ownsArchive) this.#bootstrapState = "unclaimed";
				return;
			}
			const receivedTimestamp = Date.now();
			if (ownsArchive) {
				this.options.archiveSink.ohlcvBootstrap(this.#tracker, {
					deploymentId: this.options.deploymentId,
					exchange: this.options.exchangeName,
					symbol: this.options.symbol,
					assetType: this.options.marketType,
					accountSelector: this.options.accountSelector,
					timeframe: this.options.timeframe ?? "1m",
					payload,
					receivedTimestamp,
				});
				this.#bootstrapState = "complete";
				this.#recordCounter("public_feed_archive_decisions_total");
				this.options.observer?.archiveDecision?.(this.#observation());
			}
			subscriber.buffer.enqueue(this.#frame(payload, receivedTimestamp));
		} catch (error) {
			if (ownsArchive) this.#bootstrapState = "unclaimed";
			log.warn("OHLCV public worker bootstrap fetch failed", {
				exchange: this.options.exchangeName,
				symbol: this.options.symbol,
				timeframe: this.options.timeframe,
				error,
			});
		}
	}

	async #cleanupResources(): Promise<void> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = async () => {
			const releases: Promise<unknown>[] = [];
			const unwatch = this.#unwatch();
			if (unwatch) releases.push(unwatch.catch(() => undefined));
			if (this.options.exchangeOwned) {
				releases.push(
					this.options.exchange.close().catch((error) => {
						log.warn("Failed to close public feed exchange", {
							exchange: this.options.exchangeName,
							symbol: this.options.symbol,
							error,
						});
					}),
				);
			}
			await Promise.all(releases);
			await this.#run;
		};
		try {
			await Promise.race([
				cleanup(),
				new Promise<void>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error("Public feed retirement timed out")),
						this.options.retirementTimeoutMs,
					);
					timeout.unref?.();
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	#unwatch(): Promise<unknown> | null {
		// SAFETY: adapter-specific unwatch methods are discovered dynamically and
		// guarded with a typeof function check before they are invoked.
		const exchange = this.options.exchange as unknown as Record<
			string,
			unknown
		>;
		const [method, args] =
			this.options.feed === "ORDERBOOK"
				? ["unWatchOrderBook", [this.options.symbol]]
				: this.options.feed === "TICKER"
					? ["unWatchTicker", [this.options.symbol]]
					: this.options.feed === "TRADES"
						? ["unWatchTrades", [this.options.symbol]]
						: ["unWatchOHLCV", [this.options.symbol, this.options.timeframe]];
		const fn = exchange[method];
		return typeof fn === "function"
			? Promise.resolve(fn.apply(this.options.exchange, args))
			: null;
	}

	#metricLabels(): Record<string, string> {
		return {
			exchange: this.options.exchangeName,
			feed: this.options.feed,
			market_type: this.options.marketType,
		};
	}

	#observation(): PublicFeedObservation {
		return {
			key: this.options.key,
			exchange: this.options.exchangeName,
			feed: this.options.feed,
			marketType: this.options.marketType,
			profile: this.options.profile?.id,
			subscriberCount: this.#subscribers.size,
		};
	}

	#recordCounter(name: string): void {
		void this.options.metrics?.recordCounter(name, 1, this.#metricLabels());
	}

	#recordGauge(name: string, value: number): void {
		if (this.options.metrics?.recordGauge) {
			void this.options.metrics.recordGauge(name, value, this.#metricLabels());
			return;
		}
		void this.options.metrics?.recordCounter(name, value, this.#metricLabels());
	}
}

/** Owns one physical public CCXT watch/archive path per canonical runtime key. */
export class PublicMarketDataFeedSupervisor {
	readonly #workers = new Map<string, PublicFeedWorker>();
	readonly #retirements = new Set<Promise<void>>();
	readonly #retirementBarriers = new Map<string, Promise<void>>();
	readonly #retirementFailures: unknown[] = [];
	readonly #archiveSink: PublicMarketDataArchiveSink;
	readonly #metrics?: Metrics;
	#closing = false;

	constructor(private readonly options: PublicMarketDataFeedSupervisorOptions) {
		this.#archiveSink =
			options.archiveSink ??
			createDefaultArchiveSink(options.brokerArchiver, options.otelMetrics);
		this.#metrics = options.metrics ?? options.otelMetrics;
	}

	async subscribe(
		input: PublicFeedSubscribeOptions,
	): Promise<PublicMarketDataSubscription> {
		if (this.#closing)
			throw new Error("Public market-data supervisor is stopping");
		const exchangeName = normalizePublicExchange(input.exchange);
		const resolution = this.#resolveExchange(exchangeName, input.metadata);
		if (!resolution) {
			throw new Error("Exchange not registered and no API metadata found");
		}
		const marketType = parseMarketType(input.marketType);
		let symbol: string;
		try {
			symbol = await resolveSubscriptionSymbol(
				resolution.exchange,
				input.symbol,
				marketType,
			);
		} catch (error) {
			if (resolution.owned) await resolution.exchange.close();
			throw error;
		}
		const archiveDepth = getOrderbookArchiveDepthLimit();
		const profileResolver =
			this.options.resolveOrderBookProfile ??
			resolveOrderBookAcquisitionProfile;
		const profile =
			input.feed === "ORDERBOOK"
				? profileResolver({
						exchange: exchangeName,
						requestedDepth: input.depthLimit,
						archiveDepth,
						enabledProfileIds: this.options.enabledOrderBookProfileIds,
					})
				: undefined;
		const timeframe =
			input.feed === "OHLCV"
				? resolvePublicOhlcvTimeframe(input.timeframe)
				: undefined;
		const key = buildPublicFeedKey({
			exchange: exchangeName,
			symbol,
			marketType,
			feed: input.feed,
			acquisitionProfileId: profile?.id,
			timeframe,
		});
		const predecessor = this.#retirementBarriers.get(key);
		if (predecessor) {
			try {
				await predecessor;
				if (this.#retirementBarriers.get(key) === predecessor) {
					this.#retirementBarriers.delete(key);
				}
			} catch (error) {
				if (resolution.owned) await resolution.exchange.close();
				throw error;
			}
		}

		let worker = this.#workers.get(key);
		if (worker) {
			if (resolution.owned) await resolution.exchange.close();
		} else {
			worker = new PublicFeedWorker({
				key,
				exchangeName,
				exchange: resolution.exchange,
				exchangeOwned: resolution.owned,
				accountSelector: resolution.accountSelector,
				symbol,
				marketType,
				feed: input.feed,
				timeframe,
				profile,
				archiveDepth,
				deploymentId:
					this.options.brokerArchiver?.getDeploymentId() ?? "unknown",
				archiveSink: this.#archiveSink,
				metrics: this.#metrics,
				observer: this.options.observer,
				bufferLimits: this.options.bufferLimits ?? {},
				retirementTimeoutMs:
					this.options.retirementTimeoutMs ?? DEFAULT_RETIREMENT_TIMEOUT_MS,
				onRetire: (candidate, cleanup) =>
					this.#retireWorker(key, candidate, cleanup),
			});
			this.#workers.set(key, worker);
		}
		return worker.subscribe({ ...input, timeframe });
	}

	async close(): Promise<void> {
		this.#closing = true;
		for (const [key, worker] of [...this.#workers]) {
			this.#workers.delete(key);
			this.#trackRetirement(worker.retire());
		}
		const outcomes = await Promise.allSettled([
			...this.#retirements,
			...this.#retirementBarriers.values(),
		]);
		const failed = outcomes.filter((outcome) => outcome.status === "rejected");
		const failureCount = new Set([
			...this.#retirementFailures,
			...failed.map((outcome) => outcome.reason),
		]).size;
		if (failureCount > 0) {
			throw new Error(`${failureCount} public feed worker(s) failed to retire`);
		}
	}

	#resolveExchange(
		exchangeName: string,
		metadata: Metadata | undefined,
	): ExchangeResolution | null {
		const pool = this.options.brokers[exchangeName];
		if (pool) {
			return {
				exchange: pool.primary.exchange,
				owned: false,
				accountSelector: pool.primary.label,
			};
		}
		const requestBroker = this.options.createRequestBroker
			? this.options.createRequestBroker(exchangeName, metadata)
			: metadata
				? createBroker(exchangeName, metadata)
				: null;
		if (requestBroker) return { exchange: requestBroker, owned: true };
		const publicBroker = this.options.createPublicBroker
			? this.options.createPublicBroker(exchangeName)
			: createPublicBroker(exchangeName);
		return publicBroker ? { exchange: publicBroker, owned: true } : null;
	}

	#retireWorker(
		key: string,
		worker: PublicFeedWorker,
		cleanup: Promise<void>,
	): void {
		if (this.#workers.get(key) === worker) this.#workers.delete(key);
		this.#retirementBarriers.set(key, cleanup);
		void cleanup.then(
			() => {
				if (this.#retirementBarriers.get(key) === cleanup) {
					this.#retirementBarriers.delete(key);
				}
			},
			() => {},
		);
		this.#trackRetirement(cleanup);
	}

	#trackRetirement(cleanup: Promise<void>): void {
		this.#retirements.add(cleanup);
		void cleanup.then(
			() => this.#retirements.delete(cleanup),
			(error) => {
				this.#retirements.delete(cleanup);
				this.#retirementFailures.push(error);
				log.warn("Public feed worker retirement failed", { error });
			},
		);
	}
}
