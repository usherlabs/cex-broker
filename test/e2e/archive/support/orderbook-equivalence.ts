import type { Server } from "@grpc/grpc-js";
import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import {
	MarketDataCollector,
	type MarketDataCollectorFrame,
} from "../../../../services/ohlcv-collector/collector";
import type { BrokerPoolEntry } from "../../../../src/helpers/broker";
import { buildCanonicalOrderBookRows } from "../../../../src/helpers/market-data-archive/canonical-orderbook";
import { createMarketCaptureContext } from "../../../../src/helpers/market-data-archive/capture-context";
import { createRawCapture } from "../../../../src/helpers/market-data-archive/capture-contract";
import type { NormalizedOrderBookSnapshot } from "../../../../src/helpers/order-book";
import {
	evaluateImmediateHedgeability,
	type PublicFeedObservation,
	type PublicMarketDataArchiveSink,
	type PublicMarketDataFeedObserver,
	PublicMarketDataFeedSupervisor,
	resolveConservativeOrderBookAcquisitionProfile,
} from "../../../../src/helpers/public-market-data-feed";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../../../../src/proto-package-definition";
import { getServer } from "../../../../src/server";
import type { PolicyConfig } from "../../../../src/types";
import { LifecycleBarrier } from "./archive-e2e-contracts";
import { ClickHouseLocalHarness } from "./clickhouse-local-harness";

const SYMBOL = "BTC/USDT";
const POLICY_DEPTH = 100;
const BAND_BPS = 50;
const MINIMUM_FRAMES = 3;
const OBSERVATION_DURATION_MS = 2_000;
const PUBLIC_ONLY_POLICY: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

type SubscribeResponse = MarketDataCollectorFrame;
type SubscribeClient = grpc.Client & {
	Subscribe(
		request: Record<string, unknown>,
	): grpc.ClientReadableStream<SubscribeResponse>;
};

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

class CounterBarrier {
	private value = 0;
	private readonly waiters: Array<{
		value: number;
		barrier: LifecycleBarrier<void>;
	}> = [];

	public increment(amount = 1): void {
		this.value += amount;
		for (const waiter of this.waiters.splice(0)) {
			if (this.value >= waiter.value) waiter.barrier.resolve();
			else this.waiters.push(waiter);
		}
	}

	public waitFor(value: number): Promise<void> {
		if (this.value >= value) return Promise.resolve();
		const barrier = new LifecycleBarrier<void>();
		this.waiters.push({ value, barrier });
		return barrier.promise;
	}

	public count(): number {
		return this.value;
	}
}

class EquivalenceProbe implements PublicMarketDataFeedObserver {
	readonly attached = new CounterBarrier();
	readonly workers = new CounterBarrier();
	readonly physicalFrames = new CounterBarrier();
	readonly archiveDecisions = new CounterBarrier();

	public subscriberAttached = (observation: PublicFeedObservation): void => {
		if (observation.feed === "ORDERBOOK") this.attached.increment();
	};

	public workerStarted = (observation: PublicFeedObservation): void => {
		if (observation.feed === "ORDERBOOK") this.workers.increment();
	};

	public physicalFrame = (observation: PublicFeedObservation): void => {
		if (observation.feed === "ORDERBOOK") this.physicalFrames.increment();
	};

	public archiveDecision = (observation: PublicFeedObservation): void => {
		if (observation.feed === "ORDERBOOK") this.archiveDecisions.increment();
	};
}

class ProfiledOrderBookExchange {
	private calls = 0;
	private readonly pending: Array<{
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	}> = [];
	private readonly pendingWaiters: Array<{
		count: number;
		barrier: LifecycleBarrier<void>;
	}> = [];

	public watchOrderBook = async (
		_symbol: string,
		_limit?: number,
	): Promise<unknown> => {
		this.calls += 1;
		return new Promise((resolve, reject) => {
			this.pending.push({ resolve, reject });
			this.resolvePendingWaiters();
		});
	};

	public unWatchOrderBook = async (): Promise<void> => {
		for (const waiter of this.pending.splice(0)) {
			waiter.reject(new Error("controlled order-book watch retired"));
		}
	};

	public waitForPending(count: number): Promise<void> {
		if (this.pending.length >= count) return Promise.resolve();
		const barrier = new LifecycleBarrier<void>();
		this.pendingWaiters.push({ count, barrier });
		return barrier.promise;
	}

	public release(snapshot: unknown, workerCount: number): void {
		if (this.pending.length < workerCount) {
			throw new Error(
				`Expected ${workerCount} physical ORDERBOOK watches, found ${this.pending.length}`,
			);
		}
		for (const waiter of this.pending.splice(0, workerCount)) {
			waiter.resolve(snapshot);
		}
	}

	public callCount(): number {
		return this.calls;
	}

	private resolvePendingWaiters(): void {
		for (const waiter of this.pendingWaiters.splice(0)) {
			if (this.pending.length >= waiter.count) waiter.barrier.resolve();
			else this.pendingWaiters.push(waiter);
		}
	}
}

function orderedTape(venue: string): NormalizedOrderBookSnapshot[] {
	return Array.from({ length: MINIMUM_FRAMES }, (_, frame) => ({
		bids: Array.from({ length: POLICY_DEPTH }, (_unused, level) => [
			100 + frame * 0.1 - level * 0.01,
			1 + level / 100,
		]),
		asks: Array.from({ length: POLICY_DEPTH }, (_unused, level) => [
			100.01 + frame * 0.1 + level * 0.01,
			1.5 + level / 100,
		]),
		timestamp: 1_700_000_000_000 + frame * 1_000,
		receivedTimestamp: 1_700_000_000_100 + frame * 1_000,
		exchange: venue,
		symbol: SYMBOL,
		depthLimit: POLICY_DEPTH,
	}));
}

function normalizedPayloads(
	frames: ReadonlyArray<MarketDataCollectorFrame>,
): unknown[] {
	return frames.map((frame) => JSON.parse(frame.data));
}

function uniqueArchiveSnapshots(
	snapshots: ReadonlyArray<NormalizedOrderBookSnapshot>,
): NormalizedOrderBookSnapshot[] {
	const unique = new Map<string, NormalizedOrderBookSnapshot>();
	for (const snapshot of snapshots) {
		const canonical = {
			bids: snapshot.bids,
			asks: snapshot.asks,
			timestamp: snapshot.timestamp,
			exchange: snapshot.exchange,
			symbol: snapshot.symbol,
		};
		unique.set(JSON.stringify(canonical), snapshot);
	}
	return [...unique.values()];
}

export type OrderBookCompositionEvidence = {
	logical: { explicit: unknown[]; omitted: unknown[] };
	uniqueArchiveSnapshots: NormalizedOrderBookSnapshot[];
	policy: ReturnType<typeof evaluateImmediateHedgeability>[];
	shallowArchivePolicy: ReturnType<typeof evaluateImmediateHedgeability>[];
	physicalWorkers: number;
	physicalWatchIterations: number;
	physicalFrames: number;
	archiveDecisions: number;
	observationDurationMs: number;
};

async function bindServer(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.bindAsync(
			"127.0.0.1:0",
			grpc.ServerCredentials.createInsecure(),
			(error, port) => (error ? reject(error) : resolve(port)),
		);
	});
}

async function runComposition(
	venue: "binance" | "mexc",
	mode: "conservative" | "coalesced",
): Promise<OrderBookCompositionEvidence> {
	const originalDateNow = Date.now;
	let clockMs = 1_700_000_000_100;
	Date.now = () => clockMs;
	const exchange = new ProfiledOrderBookExchange();
	const probe = new EquivalenceProbe();
	const archiveSnapshots: NormalizedOrderBookSnapshot[] = [];
	const archiveSink: PublicMarketDataArchiveSink = {
		orderbook: (input) => archiveSnapshots.push(input.snapshot),
		ticker: () => {},
		trades: () => {},
		ohlcv: () => {},
		ohlcvBootstrap: () => {},
	};
	const brokers = {
		[venue]: {
			primary: {
				exchange: exchange as unknown as Exchange,
				label: "spot:primary",
			},
			secondaryBrokers: [],
		},
	} as unknown as Record<string, BrokerPoolEntry>;
	const supervisor = new PublicMarketDataFeedSupervisor({
		brokers,
		archiveSink,
		observer: probe,
		...(mode === "conservative"
			? {
					resolveOrderBookProfile:
						resolveConservativeOrderBookAcquisitionProfile,
				}
			: {}),
	});
	const server = getServer(
		PUBLIC_ONLY_POLICY,
		brokers,
		["*"],
		false,
		"",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		supervisor,
	);
	const port = await bindServer(server);
	const explicitFrames: MarketDataCollectorFrame[] = [];
	const collectorAbort = new AbortController();
	const collector = new MarketDataCollector({
		brokerUrl: `127.0.0.1:${port}`,
		subscriptions: [
			{
				exchange: venue,
				symbol: SYMBOL,
				feed: "ORDERBOOK",
				depthLimit: POLICY_DEPTH,
			},
		],
		onFrame: (_subscription, frame) => explicitFrames.push({ ...frame }),
		retry: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 },
	});
	const collectorRun = collector.run(collectorAbort.signal);
	const client = new grpcObject.cex_broker.cex_service(
		`127.0.0.1:${port}`,
		grpc.credentials.createInsecure(),
	);
	const omittedFrames: MarketDataCollectorFrame[] = [];
	const omittedBarrier = new CounterBarrier();
	const omittedStream = client.Subscribe({
		cex: venue,
		symbol: SYMBOL,
		type: "ORDERBOOK",
		options: {},
	});
	omittedStream.on("data", (frame) => {
		omittedFrames.push({ ...frame });
		omittedBarrier.increment();
	});
	omittedStream.on("error", () => {
		// Cancellation during deterministic teardown is expected.
	});
	const workerCount = mode === "conservative" ? 2 : 1;
	const tape = orderedTape(venue);
	try {
		await probe.attached.waitFor(2);
		await probe.workers.waitFor(workerCount);
		for (let index = 0; index < tape.length; index += 1) {
			await exchange.waitForPending(workerCount);
			clockMs = tape[index]?.receivedTimestamp ?? clockMs;
			exchange.release(tape[index], workerCount);
			await probe.physicalFrames.waitFor((index + 1) * workerCount);
			await probe.archiveDecisions.waitFor((index + 1) * workerCount);
			await omittedBarrier.waitFor(index + 1);
			while (explicitFrames.length < index + 1) {
				await Bun.sleep(0);
			}
		}
		const unique = uniqueArchiveSnapshots(archiveSnapshots);
		return {
			logical: {
				explicit: normalizedPayloads(explicitFrames),
				omitted: normalizedPayloads(omittedFrames),
			},
			uniqueArchiveSnapshots: unique,
			policy: unique.map((snapshot) =>
				evaluateImmediateHedgeability(snapshot, BAND_BPS),
			),
			shallowArchivePolicy: unique.map((snapshot) =>
				evaluateImmediateHedgeability(
					{
						...snapshot,
						bids: snapshot.bids.slice(0, 25),
						asks: snapshot.asks.slice(0, 25),
					},
					BAND_BPS,
				),
			),
			physicalWorkers: probe.workers.count(),
			physicalWatchIterations: exchange.callCount(),
			physicalFrames: probe.physicalFrames.count(),
			archiveDecisions: probe.archiveDecisions.count(),
			observationDurationMs:
				Number(tape.at(-1)?.timestamp) - Number(tape[0]?.timestamp),
		};
	} finally {
		omittedStream.cancel();
		collectorAbort.abort();
		server.forceShutdown();
		await supervisor.close().catch(() => {});
		await collectorRun.catch(() => {});
		client.close();
		Date.now = originalDateNow;
	}
}

export type OrderBookEquivalenceEvidence = {
	venue: "binance" | "mexc";
	policyDepth: number;
	bandBps: number;
	minimumFrames: number;
	minimumDurationMs: number;
	conservative: OrderBookCompositionEvidence;
	coalesced: OrderBookCompositionEvidence;
};

export async function runOrderBookEquivalenceGate(
	venue: "binance" | "mexc",
): Promise<OrderBookEquivalenceEvidence> {
	const conservative = await runComposition(venue, "conservative");
	const coalesced = await runComposition(venue, "coalesced");
	return {
		venue,
		policyDepth: POLICY_DEPTH,
		bandBps: BAND_BPS,
		minimumFrames: MINIMUM_FRAMES,
		minimumDurationMs: OBSERVATION_DURATION_MS,
		conservative,
		coalesced,
	};
}

type ReplayPolicyEvidence = ReturnType<typeof evaluateImmediateHedgeability>;

function policyComparable(
	evidence: ReplayPolicyEvidence,
): Record<string, unknown> {
	return {
		covered: evidence.covered,
		mid: evidence.mid,
		bidDepth: evidence.bidDepth,
		askDepth: evidence.askDepth,
		limitingSide: evidence.limitingSide,
		liquidityCap: evidence.liquidityCap,
	};
}

async function insertCanonicalTape(
	harness: ClickHouseLocalHarness,
	venue: "binance" | "mexc",
	depth: number,
	deploymentId: string,
): Promise<void> {
	const context = createMarketCaptureContext({
		source: "broker_read",
		deploymentId,
		captureBundleId: `${deploymentId}:bundle`,
		exchange: venue,
		symbol: SYMBOL,
		assetType: "spot",
		feed: "ORDERBOOK",
		sourceMode: "broker_live_stream_v1",
		environment: "production",
	});
	const levels: Record<string, unknown>[] = [];
	const summaries: Record<string, unknown>[] = [];
	for (const snapshot of orderedTape(venue)) {
		const rawCapture = createRawCapture(context, {
			payload: snapshot,
			eventTimeMs: snapshot.timestamp,
			receivedTimeMs: snapshot.receivedTimestamp,
			scope: "ccxt_normalized_object",
		});
		const rows = buildCanonicalOrderBookRows({
			context,
			snapshot,
			rawCapture,
			depthLimit: depth,
			measurementBandsBps: [BAND_BPS],
		});
		levels.push(...rows.levels.map(({ row }) => row));
		summaries.push(rows.summary.row);
	}
	await harness.inserter("market_data.cex_order_book_levels", levels);
	await harness.inserter("market_data.cex_order_book_depth_summary", summaries);
}

async function rehydratePolicy(
	harness: ClickHouseLocalHarness,
	deploymentId: string,
): Promise<ReplayPolicyEvidence[]> {
	const rows = await harness.query(
		`SELECT snapshot_id, source_time_ms, received_time_ms, exchange, source_symbol, side, level_index, price, amount FROM market_data.cex_order_book_levels WHERE deployment_id = '${deploymentId}' ORDER BY source_time_ms, side, level_index`,
	);
	const snapshots = new Map<
		string,
		{
			bids: number[][];
			asks: number[][];
			timestamp: number;
			receivedTimestamp: number;
			exchange: string;
			symbol: string;
		}
	>();
	for (const row of rows) {
		const id = String(row.snapshot_id);
		const snapshot = snapshots.get(id) ?? {
			bids: [],
			asks: [],
			timestamp: Number(row.source_time_ms),
			receivedTimestamp: Number(row.received_time_ms),
			exchange: String(row.exchange),
			symbol: String(row.source_symbol),
		};
		const side = row.side === "bid" ? snapshot.bids : snapshot.asks;
		side[Number(row.level_index)] = [Number(row.price), Number(row.amount)];
		snapshots.set(id, snapshot);
	}
	return [...snapshots.values()]
		.sort((left, right) => left.timestamp - right.timestamp)
		.map((snapshot) => evaluateImmediateHedgeability(snapshot, BAND_BPS));
}

export type OrderBookReplaySufficiencyEvidence = {
	venue: "binance" | "mexc";
	policyDepth: number;
	archiveDepth: number;
	live: ReplayPolicyEvidence[];
	rehydrated: ReplayPolicyEvidence[];
	shallowArchiveDepth: number;
	shallowRehydrated: ReplayPolicyEvidence[];
};

export async function runOrderBookClickHouseReplayGate(
	venue: "binance" | "mexc",
): Promise<OrderBookReplaySufficiencyEvidence> {
	const harness = await ClickHouseLocalHarness.create();
	const fullDeployment = `fiet-1014-${venue}-depth-${POLICY_DEPTH}`;
	const shallowDeployment = `fiet-1014-${venue}-depth-25`;
	try {
		await harness.initialize();
		await insertCanonicalTape(harness, venue, POLICY_DEPTH, fullDeployment);
		await insertCanonicalTape(harness, venue, 25, shallowDeployment);
		return {
			venue,
			policyDepth: POLICY_DEPTH,
			archiveDepth: POLICY_DEPTH,
			live: orderedTape(venue).map((snapshot) =>
				evaluateImmediateHedgeability(snapshot, BAND_BPS),
			),
			rehydrated: await rehydratePolicy(harness, fullDeployment),
			shallowArchiveDepth: 25,
			shallowRehydrated: await rehydratePolicy(harness, shallowDeployment),
		};
	} finally {
		await harness.cleanup();
	}
}

export function comparableReplayPolicy(
	evidence: ReplayPolicyEvidence,
): Record<string, unknown> {
	return policyComparable(evidence);
}
