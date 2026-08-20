import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@grpc/grpc-js";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import type { RowInserter } from "../../../../services/archive-forwarder/insert";
import { MarketDataCollector } from "../../../../services/ohlcv-collector/collector";
import type { MarketDataSubscription } from "../../../../services/ohlcv-collector/config";
import { SubscribeBrokerLifecycle } from "../../../../src/handlers/subscribe";
import type { BrokerPoolEntry } from "../../../../src/helpers/broker";
import { BrokerExecutionArchiver } from "../../../../src/helpers/broker-execution-archive";
import { buildCanonicalOrderBookRows } from "../../../../src/helpers/market-data-archive/canonical-orderbook";
import { createMarketCaptureContext } from "../../../../src/helpers/market-data-archive/capture-context";
import {
	createRawCapture,
	sha256Canonical,
} from "../../../../src/helpers/market-data-archive/capture-contract";
import {
	type PublicFeedObservation,
	type PublicMarketDataFeedObserver,
	PublicMarketDataFeedSupervisor,
	type PublicMarketDataSubscription,
} from "../../../../src/helpers/public-market-data-feed";
import { getServer } from "../../../../src/server";
import type { PolicyConfig } from "../../../../src/types";
import {
	type ArchiveFailureResult,
	type ArchiveForwarderEndpoint,
	type ArchiveLifecycleResult,
	type InserterController,
	LifecycleBarrier,
	PUBLIC_FEEDS,
	type PublicFeed,
} from "./archive-e2e-contracts";
import { startArchiveForwarderEndpoint } from "./archive-forwarder-endpoint";
import { ClickHouseLocalHarness } from "./clickhouse-local-harness";
import {
	createBlockedInserter,
	createScriptedInserter,
} from "./controlled-inserter";

type BaselineInput = {
	orderbook: { snapshot: Record<string, unknown> };
	candle: {
		bar: {
			openTimeMs: number;
			open: number;
			high: number;
			low: number;
			close: number;
			volume: number;
			quoteVolume: number;
		};
		receivedTimestamp: number;
	};
	ticker: {
		input: { payload: Record<string, unknown>; receivedTimestamp: number };
	};
	trade: {
		input: { payload: unknown[]; receivedTimestamp: number };
	};
};

type FailureKind = "blocked" | "recoverable" | "terminal";

const DEPLOYMENT_ID = "archive-e2e-baseline";
const CAPTURE_BUNDLE_ID = "archive-e2e-four-feed-v1";
const AUTH_TOKEN = "archive-e2e-local-token";
const EXPECTED_ENQUEUED = 18;
const CONTROLLED_ORDER_BOOK_PROFILE_IDS = new Set(["binance:l2-diff:500"]);
const BASELINE_INPUT_PATH = new URL(
	"../fixtures/archive-baseline-input-v1.json",
	import.meta.url,
);
const PUBLIC_ONLY_POLICY: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};
const SUBSCRIPTIONS: MarketDataSubscription[] = [
	{
		exchange: "binance",
		symbol: "BTC/USDT",
		feed: "ORDERBOOK",
		depthLimit: 2,
	},
	{ exchange: "binance", symbol: "BTC/USDT", feed: "TICKER" },
	{ exchange: "binance", symbol: "BTC/USDT", feed: "TRADES" },
	{
		exchange: "binance",
		symbol: "BTC/USDT",
		feed: "OHLCV",
		timeframe: "1m",
		bootstrapLimit: 100,
	},
];
const ARCHIVE_ENV_KEYS = [
	"CEX_BROKER_ARCHIVE_ENABLED",
	"CEX_BROKER_MARKET_ARCHIVE_ENABLED",
	"CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH",
	"CEX_BROKER_ARCHIVE_FORWARDER_URL",
	"CEX_BROKER_DEPLOYMENT_ID",
	"CEX_BROKER_CAPTURE_BUNDLE_ID",
	"CEX_BROKER_ARCHIVE_FORWARDER_TOKEN",
	"ARCHIVE_FORWARDER_TOKEN",
	"CEX_BROKER_ARCHIVE_SOURCE",
	"CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT",
	"CEX_BROKER_ORDERBOOK_INTERVAL_MS",
] as const;

function withDeadline<T>(
	promise: Promise<T>,
	label: string,
	timeoutMs = 10_000,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise.finally(() => {
			if (timeout) clearTimeout(timeout);
		}),
		new Promise<T>((_resolve, reject) => {
			timeout = setTimeout(
				() => reject(new Error(`Timed out waiting for ${label}`)),
				timeoutMs,
			);
		}),
	]);
}

class FeedQueue {
	private calls = 0;
	private closed = false;
	private hasLastValue = false;
	private lastValue: unknown;
	private readonly pending: Array<{
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	}> = [];
	private readonly callWaiters: Array<{
		count: number;
		barrier: LifecycleBarrier<void>;
	}> = [];

	public watch = (): Promise<unknown> => {
		if (this.closed && this.hasLastValue)
			return Promise.resolve(this.lastValue);
		if (this.closed)
			return Promise.reject(new Error("controlled exchange closed"));
		this.calls += 1;
		for (const waiter of this.callWaiters.splice(0)) {
			if (this.calls >= waiter.count) waiter.barrier.resolve();
			else this.callWaiters.push(waiter);
		}
		return new Promise((resolve, reject) => {
			this.pending.push({ resolve, reject });
		});
	};

	public waitForCall(count: number): Promise<void> {
		if (this.calls >= count) return Promise.resolve();
		const barrier = new LifecycleBarrier<void>();
		this.callWaiters.push({ count, barrier });
		return barrier.promise;
	}

	public releaseLatest(): void {
		if (!this.hasLastValue)
			throw new Error("feed latest value released before capture");
		const waiter = this.pending.shift();
		if (!waiter)
			throw new Error(
				"feed latest value released before the next watch started",
			);
		waiter.resolve(this.lastValue);
	}

	public callCount(): number {
		return this.calls;
	}

	public latest(): unknown {
		if (!this.hasLastValue)
			throw new Error("controlled feed has no captured value");
		return this.lastValue;
	}

	public release(value: unknown): void {
		const waiter = this.pending.shift();
		if (!waiter) throw new Error("feed released before its watch call started");
		this.hasLastValue = true;
		this.lastValue = value;
		waiter.resolve(value);
	}

	public close(): void {
		this.closed = true;
		for (const waiter of this.pending.splice(0)) {
			if (this.hasLastValue) waiter.resolve(this.lastValue);
			else waiter.reject(new Error("controlled exchange closed"));
		}
		for (const waiter of this.callWaiters.splice(0)) {
			waiter.barrier.reject(new Error("controlled exchange closed"));
		}
	}
}

class ControlledExchange {
	private readonly feeds = new Map(
		PUBLIC_FEEDS.map((feed) => [feed, new FeedQueue()] as const),
	);
	private orderBookSnapshotCalls = 0;
	public readonly has = { fetchOHLCV: true, fetchOrderBook: true };
	public readonly watchOrderBook = this.feed("ORDERBOOK").watch;
	public readonly watchTicker = this.feed("TICKER").watch;
	public readonly watchTrades = this.feed("TRADES").watch;
	public readonly watchOHLCV = this.feed("OHLCV").watch;

	public waitForCall(feed: PublicFeed, count = 1): Promise<void> {
		return this.feed(feed).waitForCall(count);
	}

	public release(feed: PublicFeed, value: unknown): void {
		this.feed(feed).release(value);
	}

	public releaseLatest(feed: PublicFeed): void {
		this.feed(feed).releaseLatest();
	}

	public callCounts(): Record<PublicFeed, number> {
		return Object.fromEntries(
			PUBLIC_FEEDS.map((feed) => [feed, this.feed(feed).callCount()]),
		) as Record<PublicFeed, number>;
	}

	public fetchTicker = async (): Promise<unknown> => {
		const ticker = this.feed("TICKER");
		if (ticker.callCount() === 0)
			throw new Error("controlled ticker is unavailable before capture");
		return ticker.latest();
	};

	public fetchOrderBook = async (): Promise<unknown> => {
		const orderBook = this.feed("ORDERBOOK");
		if (orderBook.callCount() === 0)
			throw new Error("controlled order book is unavailable before capture");
		this.orderBookSnapshotCalls += 1;
		return orderBook.latest();
	};

	public fetchOHLCV = async (): Promise<unknown> => [
		[1_699_999_980_000, 39_990, 40_000, 39_980, 39_995, 10, 399_950],
	];

	public orderBookSnapshotCallCount(): number {
		return this.orderBookSnapshotCalls;
	}

	public async close(): Promise<void> {
		for (const feed of this.feeds.values()) feed.close();
	}

	private feed(feed: PublicFeed): FeedQueue {
		const queue = this.feeds.get(feed);
		if (!queue) throw new Error(`Unknown controlled feed ${feed}`);
		return queue;
	}
}

class PublicFeedProbe implements PublicMarketDataFeedObserver {
	private readonly attached = new Map<PublicFeed, number>();
	private readonly workers = new Map<PublicFeed, number>();
	private readonly physicalFrames = new Map<PublicFeed, number>();
	private readonly archiveDecisions = new Map<PublicFeed, number>();
	private readonly sharedAttachActions = new Map<PublicFeed, () => void>();

	public workerStarted = (observation: PublicFeedObservation): void => {
		this.increment(this.workers, observation.feed);
	};

	public subscriberAttached = (observation: PublicFeedObservation): void => {
		this.increment(this.attached, observation.feed);
		if (observation.subscriberCount < 2) return;
		const action = this.sharedAttachActions.get(observation.feed);
		if (!action) return;
		this.sharedAttachActions.delete(observation.feed);
		queueMicrotask(action);
	};

	public physicalFrame = (observation: PublicFeedObservation): void => {
		this.increment(this.physicalFrames, observation.feed);
	};

	public archiveDecision = (observation: PublicFeedObservation): void => {
		this.increment(this.archiveDecisions, observation.feed);
	};

	public releaseOnSharedAttach(feed: PublicFeed, action: () => void): void {
		this.sharedAttachActions.set(feed, action);
	}

	public counts(): {
		attached: Record<PublicFeed, number>;
		workers: Record<PublicFeed, number>;
		physicalFrames: Record<PublicFeed, number>;
		archiveDecisions: Record<PublicFeed, number>;
	} {
		return {
			attached: this.record(this.attached),
			workers: this.record(this.workers),
			physicalFrames: this.record(this.physicalFrames),
			archiveDecisions: this.record(this.archiveDecisions),
		};
	}

	private increment(target: Map<PublicFeed, number>, feed: PublicFeed): void {
		target.set(feed, (target.get(feed) ?? 0) + 1);
	}

	private record(source: Map<PublicFeed, number>): Record<PublicFeed, number> {
		return Object.fromEntries(
			PUBLIC_FEEDS.map((feed) => [feed, source.get(feed) ?? 0]),
		) as Record<PublicFeed, number>;
	}
}

class CollectorObserver {
	private readonly counts = new Map<PublicFeed, number>();
	private readonly waiters: Array<{
		feed: PublicFeed;
		count: number;
		barrier: LifecycleBarrier<void>;
	}> = [];

	public recordCounter = (
		name: string,
		value: number,
		labels: Record<string, unknown>,
	): void => {
		if (name !== "cex_market_data_collector_frames_received_total") return;
		const feed = labels.feed as PublicFeed;
		const count = (this.counts.get(feed) ?? 0) + value;
		this.counts.set(feed, count);
		for (const waiter of this.waiters.splice(0)) {
			if (waiter.feed === feed && count >= waiter.count)
				waiter.barrier.resolve();
			else this.waiters.push(waiter);
		}
	};

	public waitFor(feed: PublicFeed, count = 1): Promise<void> {
		if ((this.counts.get(feed) ?? 0) >= count) return Promise.resolve();
		const barrier = new LifecycleBarrier<void>();
		this.waiters.push({ feed, count, barrier });
		return barrier.promise;
	}

	public hasObserved(feed: PublicFeed): boolean {
		return (this.counts.get(feed) ?? 0) > 0;
	}
}

class ArchiveObserver {
	private enqueued = 0;
	private flushed = 0;
	private readonly enqueuedWaiters: Array<{
		count: number;
		barrier: LifecycleBarrier<void>;
	}> = [];
	private readonly flushedWaiters: Array<{
		count: number;
		barrier: LifecycleBarrier<void>;
	}> = [];

	public recordCounter = (
		name: string,
		value: number,
		_labels: Record<string, unknown>,
	): void => {
		if (name === "cex_archive_rows_enqueued_total") {
			this.enqueued += value;
			this.resolve(this.enqueuedWaiters, this.enqueued);
		}
		if (name === "cex_archive_rows_flushed_total") {
			this.flushed += value;
			this.resolve(this.flushedWaiters, this.flushed);
		}
	};

	public recordGauge = (): void => {};

	public waitForEnqueued(count: number): Promise<void> {
		return this.waitFor(this.enqueuedWaiters, this.enqueued, count);
	}

	public waitForFlushed(count: number): Promise<void> {
		return this.waitFor(this.flushedWaiters, this.flushed, count);
	}

	private waitFor(
		waiters: Array<{ count: number; barrier: LifecycleBarrier<void> }>,
		actual: number,
		count: number,
	): Promise<void> {
		if (actual >= count) return Promise.resolve();
		const barrier = new LifecycleBarrier<void>();
		waiters.push({ count, barrier });
		return barrier.promise;
	}

	private resolve(
		waiters: Array<{ count: number; barrier: LifecycleBarrier<void> }>,
		actual: number,
	): void {
		for (const waiter of waiters.splice(0)) {
			if (actual >= waiter.count) waiter.barrier.resolve();
			else waiters.push(waiter);
		}
	}
}

class EnvironmentScope {
	private readonly original = new Map<string, string | undefined>();

	public set(values: Record<string, string>): void {
		for (const key of ARCHIVE_ENV_KEYS) {
			if (!this.original.has(key)) this.original.set(key, process.env[key]);
		}
		for (const [key, value] of Object.entries(values)) process.env[key] = value;
	}

	public restore(): void {
		for (const [key, value] of this.original) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		this.original.clear();
	}
}

type ComposedContext = {
	harness: ClickHouseLocalHarness;
	endpoint: ArchiveForwarderEndpoint;
	archiver: BrokerExecutionArchiver;
	archiveObserver: ArchiveObserver;
	collector: MarketDataCollector;
	collectorObserver: CollectorObserver;
	collectorAbort: AbortController;
	collectorRun: Promise<void>;
	exchange: ControlledExchange;
	server: Server;
	brokerLifecycle: SubscribeBrokerLifecycle;
	publicFeedSupervisor: PublicMarketDataFeedSupervisor;
	zeroBootstrapSubscription: PublicMarketDataSubscription;
	input: BaselineInput;
	deadLetterPath: string;
	inserterController?: InserterController;
	environment: EnvironmentScope;
	restoreClock: () => void;
	setClock: (timestampMs: number) => void;
	closed: boolean;
};

async function bindServer(server: Server, requestedPort = 0): Promise<number> {
	return new Promise((resolve, reject) => {
		server.bindAsync(
			`127.0.0.1:${requestedPort}`,
			grpc.ServerCredentials.createInsecure(),
			(error, port) => (error ? reject(error) : resolve(port)),
		);
	});
}

async function createComposedContext(
	failureKind?: FailureKind,
): Promise<ComposedContext> {
	const harness = await ClickHouseLocalHarness.create();
	const environment = new EnvironmentScope();
	const originalDateNow = Date.now;
	let clockMs = 1_700_000_000_000;
	Date.now = () => clockMs;
	let endpoint: ArchiveForwarderEndpoint | undefined;
	let archiver: BrokerExecutionArchiver | undefined;
	let server: Server | undefined;
	let publicFeedSupervisor: PublicMarketDataFeedSupervisor | undefined;
	try {
		await harness.initialize();
		let inserter = harness.inserter;
		let inserterController: InserterController | undefined;
		if (failureKind === "blocked") {
			inserterController = createBlockedInserter(inserter);
			inserter = inserterController.inserter;
		} else if (failureKind === "recoverable") {
			inserterController = createScriptedInserter(inserter, 6);
			inserter = inserterController.inserter;
		} else if (failureKind === "terminal") {
			inserterController = createScriptedInserter(
				inserter,
				Number.POSITIVE_INFINITY,
			);
			inserter = inserterController.inserter;
		}
		endpoint = await startArchiveForwarderEndpoint({
			inserter,
			authToken: AUTH_TOKEN,
		});
		const deadLetterPath = `${harness.rootDirectory}/archive-loss.jsonl`;
		environment.set({
			CEX_BROKER_ARCHIVE_ENABLED: "true",
			CEX_BROKER_MARKET_ARCHIVE_ENABLED: "true",
			CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH: deadLetterPath,
			CEX_BROKER_ARCHIVE_FORWARDER_URL: endpoint.url,
			CEX_BROKER_DEPLOYMENT_ID: DEPLOYMENT_ID,
			CEX_BROKER_CAPTURE_BUNDLE_ID: CAPTURE_BUNDLE_ID,
			CEX_BROKER_ARCHIVE_FORWARDER_TOKEN: AUTH_TOKEN,
			ARCHIVE_FORWARDER_TOKEN: AUTH_TOKEN,
			CEX_BROKER_ARCHIVE_SOURCE: "broker_read",
			CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT: "production",
			CEX_BROKER_ORDERBOOK_INTERVAL_MS: "1",
		});
		const archiveObserver = new ArchiveObserver();
		archiver = BrokerExecutionArchiver.create({
			source: "broker_read",
			deploymentId: DEPLOYMENT_ID,
			forwarderUrl: endpoint.url,
			deadLetterPath,
			batchSize: failureKind === "blocked" ? 1 : 1_000,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 10_000,
			otelMetrics: archiveObserver as never,
		});
		const exchange = new ControlledExchange();
		const brokerLifecycle = new SubscribeBrokerLifecycle();
		const brokers = {
			binance: {
				primary: {
					exchange: exchange as unknown as Exchange,
					label: "spot:primary",
				},
				secondaryBrokers: [],
			},
		} as unknown as Record<string, BrokerPoolEntry>;
		publicFeedSupervisor = new PublicMarketDataFeedSupervisor({
			brokers,
			brokerArchiver: archiver,
			enabledOrderBookProfileIds: CONTROLLED_ORDER_BOOK_PROFILE_IDS,
		});
		server = getServer(
			PUBLIC_ONLY_POLICY,
			brokers,
			["*"],
			false,
			"",
			undefined,
			archiver,
			undefined,
			undefined,
			brokerLifecycle,
			undefined,
			publicFeedSupervisor,
		);
		const port = await bindServer(server);
		const zeroBootstrapSubscription = await publicFeedSupervisor.subscribe({
			exchange: "binance",
			symbol: "BTC/USDT",
			marketType: "spot",
			feed: "OHLCV",
			timeframe: "1m",
			bootstrapLimit: 0,
		});
		const collectorObserver = new CollectorObserver();
		const collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: SUBSCRIPTIONS,
			metrics: collectorObserver,
			retry: { initialDelayMs: 5, maxDelayMs: 20, jitterRatio: 0 },
		});
		const collectorAbort = new AbortController();
		const collectorRun = collector.run(collectorAbort.signal);
		const input = (await Bun.file(BASELINE_INPUT_PATH).json()) as BaselineInput;
		const context: ComposedContext = {
			harness,
			endpoint,
			archiver,
			archiveObserver,
			collector,
			collectorObserver,
			collectorAbort,
			collectorRun,
			exchange,
			server,
			brokerLifecycle,
			publicFeedSupervisor,
			zeroBootstrapSubscription,
			input,
			deadLetterPath,
			inserterController,
			environment,
			restoreClock: () => {
				Date.now = originalDateNow;
			},
			setClock: (timestampMs) => {
				clockMs = timestampMs;
			},
			closed: false,
		};
		await withDeadline(
			Promise.all(PUBLIC_FEEDS.map((feed) => exchange.waitForCall(feed))).then(
				() => undefined,
			),
			"all production Subscribe watchers",
		);
		return context;
	} catch (error) {
		server?.forceShutdown();
		await publicFeedSupervisor?.close().catch(() => {});
		if (archiver) await archiver.close().catch(() => {});
		if (endpoint) await endpoint.close().catch(() => {});
		await harness.cleanup();
		environment.restore();
		Date.now = originalDateNow;
		throw error;
	}
}

async function storedLifecycleRowCount(
	harness: ClickHouseLocalHarness,
): Promise<number> {
	let total = 0;
	for (const table of [
		"market_data.cex_stream_events",
		"market_data.cex_ticker_events",
		"market_data.cex_trades",
		"market_data.cex_ohlcv",
		"market_data.cex_order_book_levels",
		"market_data.cex_order_book_depth_summary",
	]) {
		total += await queryCount(
			harness,
			table,
			`deployment_id = '${DEPLOYMENT_ID}'`,
		);
	}
	return total;
}

async function assertRecoverableStorage(
	harness: ClickHouseLocalHarness,
	emitted: Array<{ table: string; row: Record<string, unknown> }>,
): Promise<void> {
	const ohlcv = emitted.filter(
		(entry) => entry.table === "market_data.cex_ohlcv",
	);
	for (const entry of emitted.filter(
		(candidate) => candidate.table !== "market_data.cex_ohlcv",
	)) {
		const checksum = String(entry.row.normalized_row_checksum ?? "");
		if (
			checksum.length !== 64 ||
			(await queryCount(
				harness,
				entry.table,
				`deployment_id = '${DEPLOYMENT_ID}' AND normalized_row_checksum = '${checksum}'`,
			)) !== 1
		) {
			throw new Error(
				`Recoverable retry did not store ${entry.table}:${checksum}`,
			);
		}
	}
	const replacementWinners = new Map<
		string,
		{ table: string; row: Record<string, unknown> }
	>();
	for (const entry of ohlcv) {
		const row = entry.row;
		const key = JSON.stringify([
			row.exchange,
			row.trading_pair,
			row.timeframe,
			row.open_time_ms,
			row.schema_version,
		]);
		const previous = replacementWinners.get(key);
		if (
			!previous ||
			Number(row.broker_version) > Number(previous.row.broker_version)
		) {
			replacementWinners.set(key, entry);
		}
	}
	for (const entry of replacementWinners.values()) {
		const checksum = String(entry.row.normalized_row_checksum ?? "");
		if (
			checksum.length !== 64 ||
			(await queryCount(
				harness,
				"market_data.cex_ohlcv FINAL",
				`deployment_id = '${DEPLOYMENT_ID}' AND normalized_row_checksum = '${checksum}'`,
			)) !== 1
		) {
			throw new Error(
				`Recoverable retry lost OHLCV replacement winner ${checksum}`,
			);
		}
	}
	if (replacementWinners.size !== 3) {
		throw new Error(
			"Recoverable retry produced unexpected OHLCV replacement keys",
		);
	}
}

type LossJournalEntry = {
	timestamp: string;
	source: string;
	deployment_id: string;
	reason: string;
	payload: { table: string; row: Record<string, unknown> };
};

async function readLossJournal(path: string): Promise<LossJournalEntry[]> {
	const content = await readFile(path, "utf8");
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as LossJournalEntry);
}

function stableJournalIdentity(entry: {
	table: string;
	row: Record<string, unknown>;
}): string {
	const checksum = entry.row.normalized_row_checksum;
	if (typeof checksum !== "string" || checksum.length !== 64) {
		throw new Error(
			`Loss journal row for ${entry.table} lacks stable identity`,
		);
	}
	return `${entry.table}\u0000${checksum}`;
}

function assertCompleteTerminalJournal(
	journal: LossJournalEntry[],
	emitted: Array<{ table: string; row: Record<string, unknown> }>,
): void {
	for (const entry of journal) {
		if (
			!Number.isFinite(Date.parse(entry.timestamp)) ||
			entry.source !== "broker_read" ||
			entry.deployment_id !== DEPLOYMENT_ID ||
			entry.reason !== "shutdown_forwarder_failure" ||
			!entry.payload?.table ||
			!entry.payload.row
		) {
			throw new Error(
				`Incomplete terminal loss record: ${JSON.stringify(entry)}`,
			);
		}
		stableJournalIdentity(entry.payload);
	}
	const expected = emitted.map(stableJournalIdentity).sort();
	const actual = journal
		.map((entry) => stableJournalIdentity(entry.payload))
		.sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			"Terminal loss journal does not exactly account for emitted rows",
		);
	}
}

async function releaseFrame(
	context: Pick<
		ComposedContext,
		"setClock" | "exchange" | "collectorObserver" | "archiveObserver"
	>,
	feed: PublicFeed,
	payload: unknown,
	receivedTimeMs: number,
	collectorCount: number,
	enqueuedCount: number,
): Promise<void> {
	context.setClock(receivedTimeMs);
	context.exchange.release(feed, payload);
	await withDeadline(
		context.collectorObserver.waitFor(feed, collectorCount),
		`${feed} collector frame ${collectorCount}`,
	);
	await withDeadline(
		context.archiveObserver.waitForEnqueued(enqueuedCount),
		`${feed} archive enqueue ${enqueuedCount}`,
	);
}

async function releaseLifecycleFrames(
	context: Pick<
		ComposedContext,
		"setClock" | "exchange" | "collectorObserver" | "archiveObserver" | "input"
	>,
): Promise<void> {
	const { input } = context;
	let enqueued = 2;
	enqueued += 6;
	await releaseFrame(
		context,
		"ORDERBOOK",
		input.orderbook.snapshot,
		Number(input.orderbook.snapshot.receivedTimestamp),
		1,
		enqueued,
	);
	enqueued += 2;
	await releaseFrame(
		context,
		"TICKER",
		input.ticker.input.payload,
		input.ticker.input.receivedTimestamp,
		1,
		enqueued,
	);
	enqueued += 2;
	await releaseFrame(
		context,
		"TRADES",
		input.trade.input.payload,
		input.trade.input.receivedTimestamp,
		1,
		enqueued,
	);
	const firstBar = input.candle.bar;
	enqueued += 3;
	await releaseFrame(
		context,
		"OHLCV",
		[
			[
				firstBar.openTimeMs,
				firstBar.open,
				firstBar.high,
				firstBar.low,
				firstBar.close,
				firstBar.volume,
				firstBar.quoteVolume,
			],
		],
		firstBar.openTimeMs + 123,
		2,
		enqueued,
	);
	await withDeadline(
		context.exchange.waitForCall("OHLCV", 2),
		"second OHLCV watch call",
	);
	enqueued += 3;
	await releaseFrame(
		context,
		"OHLCV",
		[
			[
				firstBar.openTimeMs + 60_000,
				firstBar.close,
				firstBar.high + 5,
				firstBar.low + 5,
				firstBar.close + 2,
				firstBar.volume + 1,
				firstBar.quoteVolume + 1,
			],
		],
		input.candle.receivedTimestamp,
		3,
		enqueued,
	);
	if (enqueued !== EXPECTED_ENQUEUED) {
		throw new Error(`Unexpected lifecycle row plan: ${enqueued}`);
	}
}

export type ProductionServerCaptureResult = {
	requestCount: number;
	emittedRows: Array<{ table: string; row: Record<string, unknown> }>;
	feedsObserved: PublicFeed[];
};

export type ProductionBrokerCollectorTopology = {
	brokerPort: number;
	feedsReady: PublicFeed[];
	capture: () => Promise<{
		emittedRows: number;
		feedsObserved: PublicFeed[];
		sourceWindow: { startTimeMs: number; endTimeMs: number };
	}>;
	brokerObservations: () => {
		collectorSubscriptionCalls: Record<PublicFeed, number>;
		totalSubscriptionCalls: Record<PublicFeed, number>;
		externalSubscriptionCalls: Record<PublicFeed, number>;
		physicalWorkers: Record<PublicFeed, number>;
		physicalFrames: Record<PublicFeed, number>;
		archiveDecisions: Record<PublicFeed, number>;
		orderBookSnapshotCalls: number;
	};
	close: () => Promise<void>;
};

export async function startProductionBrokerCollectorTopology(options: {
	forwarderUrl: string;
	forwarderToken?: string;
	deploymentId: string;
	captureBundleId: string;
	lossJournalPath: string;
	timeOffsetMs?: number;
	brokerPort?: number;
}): Promise<ProductionBrokerCollectorTopology> {
	const environment = new EnvironmentScope();
	const originalDateNow = Date.now;
	let clockMs = 1_700_000_000_000;
	Date.now = () => clockMs;
	const collectorAbort = new AbortController();
	const brokerLifecycle = new SubscribeBrokerLifecycle();
	const archiveObserver = new ArchiveObserver();
	const collectorObserver = new CollectorObserver();
	const publicFeedProbe = new PublicFeedProbe();
	const exchange = new ControlledExchange();
	let closed = false;
	let collectorSubscriptionCalls = Object.fromEntries(
		PUBLIC_FEEDS.map((feed) => [feed, 0]),
	) as Record<PublicFeed, number>;
	environment.set({
		CEX_BROKER_ARCHIVE_ENABLED: "true",
		CEX_BROKER_MARKET_ARCHIVE_ENABLED: "true",
		CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH: options.lossJournalPath,
		CEX_BROKER_ARCHIVE_FORWARDER_URL: options.forwarderUrl,
		CEX_BROKER_DEPLOYMENT_ID: options.deploymentId,
		CEX_BROKER_CAPTURE_BUNDLE_ID: options.captureBundleId,
		CEX_BROKER_ARCHIVE_FORWARDER_TOKEN: options.forwarderToken ?? "",
		ARCHIVE_FORWARDER_TOKEN: options.forwarderToken ?? "",
		CEX_BROKER_ARCHIVE_SOURCE: "broker_read",
		CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT: "production",
		CEX_BROKER_ORDERBOOK_INTERVAL_MS: "1",
	});
	const archiver = BrokerExecutionArchiver.create({
		source: "broker_read",
		deploymentId: options.deploymentId,
		forwarderUrl: options.forwarderUrl,
		forwarderToken: options.forwarderToken,
		deadLetterPath: options.lossJournalPath,
		batchSize: 1_000,
		flushIntervalMs: 60_000,
		forwarderTimeoutMs: 10_000,
		otelMetrics: archiveObserver as never,
	});
	const brokers = {
		binance: {
			primary: {
				exchange: exchange as unknown as Exchange,
				label: "spot:primary",
			},
			secondaryBrokers: [],
		},
	} as unknown as Record<string, BrokerPoolEntry>;
	const publicFeedSupervisor = new PublicMarketDataFeedSupervisor({
		brokers,
		brokerArchiver: archiver,
		observer: publicFeedProbe,
		enabledOrderBookProfileIds: CONTROLLED_ORDER_BOOK_PROFILE_IDS,
	});
	const server = getServer(
		PUBLIC_ONLY_POLICY,
		brokers,
		["*"],
		false,
		"",
		undefined,
		archiver,
		undefined,
		undefined,
		brokerLifecycle,
		undefined,
		publicFeedSupervisor,
	);
	let collectorRun: Promise<void> | undefined;
	try {
		const brokerPort = await bindServer(server, options.brokerPort);
		const collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${brokerPort}`,
			subscriptions: SUBSCRIPTIONS,
			metrics: collectorObserver,
			retry: { initialDelayMs: 5, maxDelayMs: 20, jitterRatio: 0 },
		});
		collectorRun = collector.run(collectorAbort.signal);
		await withDeadline(
			Promise.all(PUBLIC_FEEDS.map((feed) => exchange.waitForCall(feed))).then(
				() => undefined,
			),
			"sidecar broker subscriptions",
		);
		collectorSubscriptionCalls = publicFeedProbe.counts().attached;
		const input = (await Bun.file(BASELINE_INPUT_PATH).json()) as BaselineInput;
		const offset = options.timeOffsetMs ?? 0;
		if (offset !== 0) {
			input.orderbook.snapshot.timestamp =
				Number(input.orderbook.snapshot.timestamp) + offset;
			input.orderbook.snapshot.receivedTimestamp =
				Number(input.orderbook.snapshot.receivedTimestamp) + offset;
			input.candle.bar.openTimeMs += offset;
			input.candle.receivedTimestamp += offset;
			input.ticker.input.receivedTimestamp += offset;
			input.ticker.input.payload.timestamp =
				Number(input.ticker.input.payload.timestamp) + offset;
			input.trade.input.receivedTimestamp += offset;
			for (const trade of input.trade.input.payload) {
				if (trade && typeof trade === "object") {
					const row = trade as Record<string, unknown>;
					row.timestamp = Number(row.timestamp) + offset;
				}
			}
		}
		return {
			brokerPort,
			feedsReady: [...PUBLIC_FEEDS],
			capture: async () => {
				await releaseLifecycleFrames({
					setClock: (timestampMs) => {
						clockMs = timestampMs;
					},
					exchange,
					collectorObserver,
					archiveObserver,
					input,
				});
				await archiver.flush();
				await withDeadline(
					archiveObserver.waitForFlushed(EXPECTED_ENQUEUED),
					"sidecar archive flush",
				);
				for (const feed of PUBLIC_FEEDS) {
					publicFeedProbe.releaseOnSharedAttach(feed, () =>
						exchange.releaseLatest(feed),
					);
				}
				return {
					emittedRows: EXPECTED_ENQUEUED,
					feedsObserved: PUBLIC_FEEDS.filter((feed) =>
						collectorObserver.hasObserved(feed),
					),
					sourceWindow: {
						startTimeMs: Math.min(
							Number(input.orderbook.snapshot.timestamp),
							input.candle.bar.openTimeMs,
							Number(input.ticker.input.payload.timestamp),
							...input.trade.input.payload.map((trade) =>
								Number(
									trade && typeof trade === "object"
										? (trade as Record<string, unknown>).timestamp
										: 0,
								),
							),
						),
						endTimeMs:
							Math.max(
								Number(input.orderbook.snapshot.timestamp),
								input.candle.bar.openTimeMs,
								Number(input.ticker.input.payload.timestamp),
								...input.trade.input.payload.map((trade) =>
									Number(
										trade && typeof trade === "object"
											? (trade as Record<string, unknown>).timestamp
											: 0,
									),
								),
							) + 1,
					},
				};
			},
			brokerObservations: () => {
				const probeCounts = publicFeedProbe.counts();
				const totalSubscriptionCalls = probeCounts.attached;
				const externalSubscriptionCalls = Object.fromEntries(
					PUBLIC_FEEDS.map((feed) => [
						feed,
						Math.max(
							totalSubscriptionCalls[feed] - collectorSubscriptionCalls[feed],
							0,
						),
					]),
				) as Record<PublicFeed, number>;
				return {
					collectorSubscriptionCalls: { ...collectorSubscriptionCalls },
					totalSubscriptionCalls,
					externalSubscriptionCalls,
					physicalWorkers: probeCounts.workers,
					physicalFrames: probeCounts.physicalFrames,
					archiveDecisions: probeCounts.archiveDecisions,
					orderBookSnapshotCalls: exchange.orderBookSnapshotCallCount(),
				};
			},
			close: async () => {
				if (closed) return;
				closed = true;
				collectorAbort.abort();
				await exchange.close();
				if (collectorRun) {
					await withDeadline(collectorRun, "sidecar collector abort").catch(
						() => {},
					);
				}
				server.forceShutdown();
				await publicFeedSupervisor.close().catch(() => {});
				await brokerLifecycle.closeAll().catch(() => {});
				await archiver.close();
				environment.restore();
				Date.now = originalDateNow;
			},
		};
	} catch (error) {
		collectorAbort.abort();
		await exchange.close();
		server.forceShutdown();
		await publicFeedSupervisor.close().catch(() => {});
		await brokerLifecycle.closeAll().catch(() => {});
		await archiver.close().catch(() => {});
		environment.restore();
		Date.now = originalDateNow;
		throw error;
	}
}

export async function runProductionServerArchiveCapture(options: {
	inserter: RowInserter;
	deploymentId: string;
	captureBundleId: string;
	timeOffsetMs?: number;
}): Promise<ProductionServerCaptureResult> {
	const runDirectory = await mkdtemp(
		join(tmpdir(), "cex-broker-server-capture-"),
	);
	const environment = new EnvironmentScope();
	const originalDateNow = Date.now;
	let clockMs = 1_700_000_000_000;
	Date.now = () => clockMs;
	let endpoint: ArchiveForwarderEndpoint | undefined;
	let archiver: BrokerExecutionArchiver | undefined;
	let collector: MarketDataCollector | undefined;
	let collectorRun: Promise<void> | undefined;
	let server: Server | undefined;
	let exchange: ControlledExchange | undefined;
	let publicFeedSupervisor: PublicMarketDataFeedSupervisor | undefined;
	const collectorAbort = new AbortController();
	const brokerLifecycle = new SubscribeBrokerLifecycle();
	try {
		endpoint = await startArchiveForwarderEndpoint({
			inserter: options.inserter,
			authToken: AUTH_TOKEN,
			spoolPath: join(runDirectory, "strategy-spool.sqlite"),
		});
		environment.set({
			CEX_BROKER_ARCHIVE_ENABLED: "true",
			CEX_BROKER_MARKET_ARCHIVE_ENABLED: "true",
			CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH: join(
				runDirectory,
				"archive-loss.jsonl",
			),
			CEX_BROKER_ARCHIVE_FORWARDER_URL: endpoint.url,
			CEX_BROKER_DEPLOYMENT_ID: options.deploymentId,
			CEX_BROKER_CAPTURE_BUNDLE_ID: options.captureBundleId,
			CEX_BROKER_ARCHIVE_FORWARDER_TOKEN: AUTH_TOKEN,
			ARCHIVE_FORWARDER_TOKEN: AUTH_TOKEN,
			CEX_BROKER_ARCHIVE_SOURCE: "broker_read",
			CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT: "production",
			CEX_BROKER_ORDERBOOK_INTERVAL_MS: "1",
		});
		const archiveObserver = new ArchiveObserver();
		archiver = BrokerExecutionArchiver.create({
			source: "broker_read",
			deploymentId: options.deploymentId,
			forwarderUrl: endpoint.url,
			deadLetterPath: join(runDirectory, "archive-loss.jsonl"),
			batchSize: 1_000,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 10_000,
			otelMetrics: archiveObserver as never,
		});
		exchange = new ControlledExchange();
		const brokers = {
			binance: {
				primary: {
					exchange: exchange as unknown as Exchange,
					label: "spot:primary",
				},
				secondaryBrokers: [],
			},
		} as unknown as Record<string, BrokerPoolEntry>;
		publicFeedSupervisor = new PublicMarketDataFeedSupervisor({
			brokers,
			brokerArchiver: archiver,
			enabledOrderBookProfileIds: CONTROLLED_ORDER_BOOK_PROFILE_IDS,
		});
		server = getServer(
			PUBLIC_ONLY_POLICY,
			brokers,
			["*"],
			false,
			"",
			undefined,
			archiver,
			undefined,
			undefined,
			brokerLifecycle,
			undefined,
			publicFeedSupervisor,
		);
		const port = await bindServer(server);
		const collectorObserver = new CollectorObserver();
		collector = new MarketDataCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: SUBSCRIPTIONS,
			metrics: collectorObserver,
			retry: { initialDelayMs: 5, maxDelayMs: 20, jitterRatio: 0 },
		});
		collectorRun = collector.run(collectorAbort.signal);
		await withDeadline(
			Promise.all(PUBLIC_FEEDS.map((feed) => exchange?.waitForCall(feed))).then(
				() => undefined,
			),
			"server acceptance subscriptions",
		);
		const input = (await Bun.file(BASELINE_INPUT_PATH).json()) as BaselineInput;
		const offset = options.timeOffsetMs ?? 0;
		if (offset !== 0) {
			input.orderbook.snapshot.timestamp =
				Number(input.orderbook.snapshot.timestamp) + offset;
			input.orderbook.snapshot.receivedTimestamp =
				Number(input.orderbook.snapshot.receivedTimestamp) + offset;
			input.candle.bar.openTimeMs += offset;
			input.candle.receivedTimestamp += offset;
			input.ticker.input.receivedTimestamp += offset;
			input.ticker.input.payload.timestamp =
				Number(input.ticker.input.payload.timestamp) + offset;
			input.trade.input.receivedTimestamp += offset;
			for (const trade of input.trade.input.payload) {
				if (trade && typeof trade === "object") {
					const row = trade as Record<string, unknown>;
					row.timestamp = Number(row.timestamp) + offset;
				}
			}
		}
		await releaseLifecycleFrames({
			setClock: (timestampMs) => {
				clockMs = timestampMs;
			},
			exchange,
			collectorObserver,
			archiveObserver,
			input,
		});
		await archiver.flush();
		await withDeadline(
			archiveObserver.waitForFlushed(EXPECTED_ENQUEUED),
			"server acceptance archive flush",
		);
		return {
			requestCount: endpoint.requestCount,
			emittedRows: endpoint.batches.flatMap((batch) => batch.rows),
			feedsObserved: PUBLIC_FEEDS.filter((feed) =>
				collectorObserver.hasObserved(feed),
			),
		};
	} finally {
		collectorAbort.abort();
		await exchange?.close();
		if (collectorRun) {
			await withDeadline(
				collectorRun,
				"server acceptance collector abort",
			).catch(() => {});
		}
		server?.forceShutdown();
		await publicFeedSupervisor?.close().catch(() => {});
		await brokerLifecycle.closeAll().catch(() => {});
		await archiver?.close().catch(() => {});
		await endpoint?.close().catch(() => {});
		environment.restore();
		Date.now = originalDateNow;
		await rm(runDirectory, { recursive: true, force: true });
	}
}

async function queryCount(
	harness: ClickHouseLocalHarness,
	from: string,
	where: string,
): Promise<number> {
	const rows = await harness.query(
		`SELECT count() AS count FROM ${from} WHERE ${where}`,
	);
	return Number(rows[0]?.count ?? 0);
}

async function storedFeedLinks(
	harness: ClickHouseLocalHarness,
): Promise<ArchiveLifecycleResult["feedLinks"]> {
	const rawRows = await harness.query(
		`SELECT feed, raw_capture_id FROM market_data.cex_stream_events WHERE deployment_id = '${DEPLOYMENT_ID}' AND capture_bundle_id = '${CAPTURE_BUNDLE_ID}' ORDER BY feed, source_time_ms`,
	);
	const tableByFeed: Record<PublicFeed, string[]> = {
		ORDERBOOK: [
			"market_data.cex_order_book_levels",
			"market_data.cex_order_book_depth_summary",
		],
		TICKER: ["market_data.cex_ticker_events"],
		TRADES: ["market_data.cex_trades"],
		OHLCV: ["market_data.cex_ohlcv"],
	};
	return Promise.all(
		PUBLIC_FEEDS.map(async (feed) => {
			const candidates = rawRows.filter((row) => row.feed === feed);
			let rawCaptureId = "";
			for (const raw of candidates) {
				const candidate = String(raw.raw_capture_id ?? "");
				const linked = await Promise.all(
					tableByFeed[feed].map((table) =>
						queryCount(
							harness,
							table,
							`deployment_id = '${DEPLOYMENT_ID}' AND capture_bundle_id = '${CAPTURE_BUNDLE_ID}' AND raw_capture_id = '${candidate}'`,
						),
					),
				);
				if (candidate && linked.every((count) => count > 0)) {
					rawCaptureId = candidate;
					break;
				}
			}
			if (!rawCaptureId)
				throw new Error(`Missing linked raw capture for ${feed}`);
			return { feed, rawCaptureId, normalizedTables: tableByFeed[feed] };
		}),
	);
}

async function verifyStoredChecksums(
	harness: ClickHouseLocalHarness,
	endpoint: ArchiveForwarderEndpoint,
): Promise<boolean> {
	for (const table of [
		"market_data.cex_stream_events",
		"market_data.cex_ticker_events",
		"market_data.cex_trades",
		"market_data.cex_ohlcv",
		"market_data.cex_order_book_levels",
		"market_data.cex_order_book_depth_summary",
	]) {
		const rows = await harness.query(
			`SELECT * FROM ${table} WHERE deployment_id = '${DEPLOYMENT_ID}' AND capture_bundle_id = '${CAPTURE_BUNDLE_ID}'`,
		);
		if (rows.length === 0) {
			throw new Error(`No stored checksum rows in ${table}`);
		}
		for (const row of rows) {
			const emitted = endpoint.batches
				.flatMap((batch) => batch.rows)
				.find(
					(entry) =>
						entry.table === table &&
						entry.row.normalized_row_checksum === row.normalized_row_checksum,
				)?.row;
			const checksumDocument = { ...row };
			if ("capture_origin" in checksumDocument) {
				const expectedOrigin =
					row.source === "external_backfill"
						? "vendor_historical_backfill"
						: "production_capture";
				if (row.capture_origin !== expectedOrigin) {
					throw new Error(
						`Stored capture origin mismatch in ${table}: expected ${expectedOrigin}, received ${String(row.capture_origin)}`,
					);
				}
				delete checksumDocument.capture_origin;
			}
			if (
				emitted &&
				typeof emitted.sequence === "string" &&
				typeof row.sequence === "number" &&
				/^\d+$/.test(emitted.sequence) &&
				Number.isSafeInteger(row.sequence) &&
				BigInt(emitted.sequence) === BigInt(row.sequence)
			) {
				// ClickHouse materializes a safe UInt64 as a JSON number even when the
				// producer used a decimal string. Restore only the equivalent producer
				// representation before verifying the unchanged v1 row checksum.
				checksumDocument.sequence = emitted.sequence;
			}
			const recomputed = sha256Canonical(checksumDocument);
			if (recomputed !== row.normalized_row_checksum) {
				const changedFields = emitted
					? [...new Set([...Object.keys(emitted), ...Object.keys(row)])].filter(
							(field) =>
								field !== "normalized_row_checksum" &&
								JSON.stringify(emitted[field]) !== JSON.stringify(row[field]),
						)
					: ["emitted-row-not-found"];
				throw new Error(
					`Stored normalized checksum mismatch in ${table} for ${String(row.feed ?? "unknown")}: expected ${String(row.normalized_row_checksum)}, recomputed ${recomputed}; storage-changed fields: ${changedFields.join(", ")}`,
				);
			}
			if (table === "market_data.cex_stream_events") {
				const payload = JSON.parse(String(row.payload_json));
				if (sha256Canonical(payload) !== row.raw_checksum) {
					throw new Error(
						`Stored raw checksum mismatch for ${String(row.feed)}`,
					);
				}
			}
		}
	}
	return true;
}

function unexpectedDestinations(endpoint: ArchiveForwarderEndpoint): string[] {
	const allowed = new Set([
		"market_data.cex_stream_events",
		"market_data.cex_ticker_events",
		"market_data.cex_trades",
		"market_data.cex_ohlcv",
		"market_data.cex_order_book_levels",
		"market_data.cex_order_book_depth_summary",
		"market_data.orderbook_snapshots",
		"market_data.candles",
	]);
	return [
		...new Set(
			endpoint.batches
				.flatMap((batch) => batch.rows)
				.map(({ table }) => table)
				.filter((table) => !allowed.has(table)),
		),
	].sort();
}

function activeFeeds(collector: MarketDataCollector): PublicFeed[] {
	const snapshot = collector.getHealthSnapshot();
	return PUBLIC_FEEDS.filter((feed) =>
		Object.entries(snapshot).some(
			([key, health]) => key.endsWith(`:${feed}`) && health.state === "healthy",
		),
	);
}

async function closeContext(
	context: ComposedContext,
	closeArchiver = true,
): Promise<void> {
	if (context.closed) return;
	context.closed = true;
	context.zeroBootstrapSubscription.close();
	context.collectorAbort.abort();
	await context.exchange.close();
	await withDeadline(context.collectorRun, "collector abort").catch(() => {});
	context.server.forceShutdown();
	await context.publicFeedSupervisor.close().catch(() => {});
	await context.brokerLifecycle.closeAll().catch(() => {});
	if (closeArchiver) await context.archiver.close();
	await context.endpoint.close();
	await context.harness.cleanup();
	context.environment.restore();
	context.restoreClock();
}

export async function runArchiveLifecycle(): Promise<ArchiveLifecycleResult> {
	const context = await createComposedContext();
	try {
		await releaseLifecycleFrames(context);
		await context.archiver.flush();
		await withDeadline(
			context.archiveObserver.waitForFlushed(EXPECTED_ENQUEUED),
			"archive flush completion",
		);
		const feedLinks = await storedFeedLinks(context.harness);
		const conflictRows =
			(await queryCount(
				context.harness,
				"market_data.cex_order_book_levels_conflicts",
				`capture_bundle_id = '${CAPTURE_BUNDLE_ID}'`,
			)) +
			(await queryCount(
				context.harness,
				"market_data.cex_order_book_depth_summary_conflicts",
				`capture_bundle_id = '${CAPTURE_BUNDLE_ID}'`,
			));
		for (const view of [
			"market_data.cex_order_book_levels_canonical",
			"market_data.cex_order_book_depth_summary_canonical",
			"market_data.cex_ohlcv_closed",
		]) {
			if (
				(await queryCount(
					context.harness,
					view,
					`capture_bundle_id = '${CAPTURE_BUNDLE_ID}'`,
				)) === 0
			) {
				throw new Error(`Canonical lifecycle view ${view} is empty`);
			}
		}
		const result: ArchiveLifecycleResult = {
			collectorModule: "services/ohlcv-collector/collector.ts",
			feedsObserved: [...PUBLIC_FEEDS],
			streamsActiveBeforeAbort: activeFeeds(context.collector),
			feedLinks,
			unexpectedDestinations: unexpectedDestinations(context.endpoint),
			checksumsVerified: await verifyStoredChecksums(
				context.harness,
				context.endpoint,
			),
			conflictViewsEmpty: conflictRows === 0,
			legacyOrderBookRows: await queryCount(
				context.harness,
				"market_data.orderbook_snapshots",
				`deployment_id = '${DEPLOYMENT_ID}'`,
			),
			legacyCandleRows: await queryCount(
				context.harness,
				"market_data.candles",
				`deployment_id = '${DEPLOYMENT_ID}'`,
			),
		};
		return result;
	} finally {
		await closeContext(context);
	}
}

export async function runBlockedSinkLifecycle(): Promise<ArchiveFailureResult> {
	const context = await createComposedContext("blocked");
	try {
		const controller = context.inserterController;
		if (!controller) throw new Error("Blocked inserter controller is missing");
		const releases = releaseLifecycleFrames(context);
		await withDeadline(
			controller.requestStarted.promise,
			"blocked sink request",
		);
		await withDeadline(
			releases,
			"all later collector frames while the archive sink is blocked",
		);
		const laterFramesObservedBeforeRelease = PUBLIC_FEEDS.filter((feed) =>
			context.collectorObserver.hasObserved(feed),
		);
		const streamsActiveBeforeAbort = activeFeeds(context.collector);
		controller.release();
		await context.archiver.flush();
		await withDeadline(
			context.archiveObserver.waitForFlushed(EXPECTED_ENQUEUED),
			"blocked sink backlog flush",
		);
		const emittedRows = context.archiver.getStats().enqueued;
		const successfulRows = context.endpoint.batches.flatMap(
			(batch) => batch.rows,
		);
		if (successfulRows.length !== emittedRows) {
			throw new Error("Blocked-sink recovery did not send every emitted row");
		}
		await assertRecoverableStorage(context.harness, successfulRows);
		// A 2xx production-handler response acknowledges every row in the batch.
		// The query assertions above apply ReplacingMergeTree winner semantics where
		// an obsolete forming OHLCV version is intentionally no longer queryable.
		const storedRows = emittedRows;
		return {
			laterFramesObservedBeforeRelease,
			streamsActiveBeforeAbort,
			retryAttempts: context.endpoint.requestCount,
			emittedRows,
			storedRows,
			journalRows: 0,
			journalReasons: [],
			unaccountedRows: emittedRows - storedRows,
		};
	} finally {
		context.inserterController?.release();
		await closeContext(context);
	}
}

export async function runRecoverableFailureLifecycle(): Promise<ArchiveFailureResult> {
	const context = await createComposedContext("recoverable");
	try {
		await releaseLifecycleFrames(context);
		await context.archiver.flush();
		if (context.archiver.getStats().forwarderFailures !== 1) {
			throw new Error("Recoverable failure did not requeue the complete batch");
		}
		await context.archiver.flush();
		await withDeadline(
			context.archiveObserver.waitForFlushed(EXPECTED_ENQUEUED),
			"recoverable retry flush",
		);
		const emittedRows = context.archiver.getStats().enqueued;
		const successfulBatch = context.endpoint.batches.at(-1)?.rows ?? [];
		if (successfulBatch.length !== emittedRows) {
			throw new Error(
				"Recoverable retry did not resend the complete emitted batch",
			);
		}
		await assertRecoverableStorage(context.harness, successfulBatch);
		const storedRows = emittedRows;
		const journal = await readLossJournal(context.deadLetterPath);
		return {
			laterFramesObservedBeforeRelease: [...PUBLIC_FEEDS],
			streamsActiveBeforeAbort: activeFeeds(context.collector),
			retryAttempts: context.endpoint.requestCount,
			emittedRows,
			storedRows,
			journalRows: journal.length,
			journalReasons: journal.map((entry) => entry.reason),
			unaccountedRows: emittedRows - storedRows - journal.length,
		};
	} finally {
		await closeContext(context);
	}
}

export async function runTerminalFailureLifecycle(): Promise<ArchiveFailureResult> {
	const context = await createComposedContext("terminal");
	let archiverClosed = false;
	try {
		await releaseLifecycleFrames(context);
		const streamsActiveBeforeAbort = activeFeeds(context.collector);
		await context.archiver.close();
		archiverClosed = true;
		const emittedRows = context.archiver.getStats().enqueued;
		const storedRows = await storedLifecycleRowCount(context.harness);
		const journal = await readLossJournal(context.deadLetterPath);
		assertCompleteTerminalJournal(
			journal,
			context.endpoint.batches[0]?.rows ?? [],
		);
		return {
			laterFramesObservedBeforeRelease: [...PUBLIC_FEEDS],
			streamsActiveBeforeAbort,
			retryAttempts: context.endpoint.requestCount,
			emittedRows,
			storedRows,
			journalRows: journal.length,
			journalReasons: journal.map((entry) => entry.reason),
			unaccountedRows: emittedRows - storedRows - journal.length,
		};
	} finally {
		await closeContext(context, !archiverClosed);
	}
}

export async function runOrderBookConflictRegression(): Promise<{
	identicalPhysicalRows: number;
	identicalCanonicalRows: number;
	sameRequestStatus: number;
	sameRequestStoredRows: number;
	crossBatchPhysicalRows: number;
	crossBatchConflictRows: number;
	crossBatchCanonicalRows: number;
}> {
	const harness = await ClickHouseLocalHarness.create();
	let endpoint: ArchiveForwarderEndpoint | undefined;
	try {
		await harness.initialize();
		endpoint = await startArchiveForwarderEndpoint({
			inserter: harness.inserter,
			authToken: AUTH_TOKEN,
		});
		const post = async (
			rows: Array<{ table: string; row: Record<string, unknown> }>,
		): Promise<number> => {
			const response = await fetch(endpoint?.url ?? "", {
				method: "POST",
				headers: {
					authorization: `Bearer ${AUTH_TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					source: "broker_read",
					deployment_id: DEPLOYMENT_ID,
					rows,
				}),
			});
			return response.status;
		};
		const buildRows = (captureBundleId: string) => {
			const context = createMarketCaptureContext({
				source: "broker_read",
				deploymentId: DEPLOYMENT_ID,
				captureBundleId,
				exchange: "binance",
				symbol: "BTC/USDT",
				assetType: "spot",
				feed: "ORDERBOOK",
				sourceMode: "broker_live_sampling_v1",
				environment: "production",
			});
			const snapshot = {
				bids: [
					[100, 1],
					[99, 2],
				],
				asks: [
					[101, 1.5],
					[102, 2.5],
				],
				timestamp: 1_700_000_000_000,
				receivedTimestamp: 1_700_000_000_125,
				exchange: "binance",
				symbol: "BTC/USDT",
				sequence: 42,
			};
			const raw = createRawCapture(context, {
				payload: snapshot,
				eventTimeMs: snapshot.timestamp,
				receivedTimeMs: snapshot.receivedTimestamp,
				scope: "ccxt_normalized_object",
			});
			const rows = buildCanonicalOrderBookRows({
				context,
				snapshot,
				rawCapture: raw,
				depthLimit: 2,
			});
			return {
				level: rows.levels[0] as {
					table: string;
					row: Record<string, unknown>;
				},
				summary: rows.summary,
			};
		};
		const tables = [
			{
				name: "market_data.cex_order_book_levels",
				view: "market_data.cex_order_book_levels_canonical",
				conflicts: "market_data.cex_order_book_levels_conflicts",
				pick: (rows: ReturnType<typeof buildRows>) => rows.level,
			},
			{
				name: "market_data.cex_order_book_depth_summary",
				view: "market_data.cex_order_book_depth_summary_canonical",
				conflicts: "market_data.cex_order_book_depth_summary_conflicts",
				pick: (rows: ReturnType<typeof buildRows>) => rows.summary,
			},
		] as const;
		let representative:
			| {
					identicalPhysicalRows: number;
					identicalCanonicalRows: number;
					sameRequestStatus: number;
					sameRequestStoredRows: number;
					crossBatchPhysicalRows: number;
					crossBatchConflictRows: number;
					crossBatchCanonicalRows: number;
			  }
			| undefined;
		for (const [index, table] of tables.entries()) {
			const identicalBundle = `conflict-identical-${index}`;
			const identical = table.pick(buildRows(identicalBundle));
			if (
				(await post([identical])) !== 200 ||
				(await post([identical])) !== 200
			) {
				throw new Error(`${table.name} identical duplicate request failed`);
			}
			const identicalPhysicalRows = await queryCount(
				harness,
				table.name,
				`capture_bundle_id = '${identicalBundle}'`,
			);
			const identicalCanonicalRows = await queryCount(
				harness,
				table.view,
				`capture_bundle_id = '${identicalBundle}'`,
			);

			const sameRequestBundle = `conflict-same-request-${index}`;
			const sameRequestRows = buildRows(sameRequestBundle);
			const sameRequest = table.pick(sameRequestRows);
			const sameRequestConflict = {
				...sameRequest,
				row: {
					...sameRequest.row,
					normalized_row_checksum: "f".repeat(64),
				},
			};
			const unrelated =
				table.name === "market_data.cex_order_book_levels"
					? sameRequestRows.summary
					: sameRequestRows.level;
			const sameRequestStatus = await post([
				sameRequest,
				sameRequestConflict,
				unrelated,
			]);
			const sameRequestStoredRows =
				(await queryCount(
					harness,
					"market_data.cex_order_book_levels",
					`capture_bundle_id = '${sameRequestBundle}'`,
				)) +
				(await queryCount(
					harness,
					"market_data.cex_order_book_depth_summary",
					`capture_bundle_id = '${sameRequestBundle}'`,
				));

			const crossBatchBundle = `conflict-cross-batch-${index}`;
			const crossBatch = table.pick(buildRows(crossBatchBundle));
			const crossBatchConflict = {
				...crossBatch,
				row: {
					...crossBatch.row,
					normalized_row_checksum: "e".repeat(64),
				},
			};
			if (
				(await post([crossBatch])) !== 200 ||
				(await post([crossBatchConflict])) !== 200
			) {
				throw new Error(`${table.name} cross-batch conflict request failed`);
			}
			const crossBatchPhysicalRows = await queryCount(
				harness,
				table.name,
				`capture_bundle_id = '${crossBatchBundle}'`,
			);
			const crossBatchConflictRows = await queryCount(
				harness,
				table.conflicts,
				`capture_bundle_id = '${crossBatchBundle}'`,
			);
			const crossBatchCanonicalRows = await queryCount(
				harness,
				table.view,
				`capture_bundle_id = '${crossBatchBundle}'`,
			);
			const result = {
				identicalPhysicalRows,
				identicalCanonicalRows,
				sameRequestStatus,
				sameRequestStoredRows,
				crossBatchPhysicalRows,
				crossBatchConflictRows,
				crossBatchCanonicalRows,
			};
			if (
				JSON.stringify(result) !==
				JSON.stringify({
					identicalPhysicalRows: 2,
					identicalCanonicalRows: 1,
					sameRequestStatus: 400,
					sameRequestStoredRows: 0,
					crossBatchPhysicalRows: 2,
					crossBatchConflictRows: 1,
					crossBatchCanonicalRows: 0,
				})
			) {
				throw new Error(
					`${table.name} conflict contract mismatch: ${JSON.stringify(result)}`,
				);
			}
			representative ??= result;
		}
		if (!representative)
			throw new Error("No order-book conflict tables tested");
		return representative;
	} finally {
		if (endpoint) await endpoint.close();
		await harness.cleanup();
	}
}
