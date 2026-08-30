import { randomUUID } from "node:crypto";
import type { Server } from "@grpc/grpc-js";
import * as grpc from "@grpc/grpc-js";
import { OhlcvCollector } from "../services/ohlcv-collector/collector";
import type { MarketDataSubscription } from "../services/ohlcv-collector/config";
import { SubscribeBrokerLifecycle } from "../src/handlers/subscribe";
import type { BrokerPoolEntry } from "../src/helpers/broker";
import { BrokerExecutionArchiver } from "../src/helpers/broker-execution-archive";
import { getServer } from "../src/server";
import type { PolicyConfig } from "../src/types";
import type { PublicFeed } from "../test/e2e/archive/support/archive-e2e-contracts";
import { startArchiveForwarderEndpoint } from "../test/e2e/archive/support/archive-forwarder-endpoint";
import { ClickHouseLocalHarness } from "../test/e2e/archive/support/clickhouse-local-harness";
import {
	ARCHIVE_SMOKE_FEEDS,
	ARCHIVE_SMOKE_RPC_METHODS,
	assertArchiveSmokeSafety,
} from "./archive-live-smoke-contract";

const PUBLIC_ONLY_POLICY: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};
const PER_FEED_TIMEOUT_MS = 60_000;
const OVERALL_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 10_000;

class FirstFrameObserver {
	private readonly seen = new Set<PublicFeed>();
	private readonly waiters = new Map<PublicFeed, () => void>();

	public recordCounter = async (
		name: string,
		_value: number,
		labels: Record<string, unknown>,
	): Promise<void> => {
		if (name !== "cex_market_data_collector_frames_received_total") return;
		const feed = labels.feed as PublicFeed;
		this.seen.add(feed);
		this.waiters.get(feed)?.();
	};

	public waitFor(feed: PublicFeed): Promise<void> {
		if (this.seen.has(feed)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(feed);
				reject(new Error(`No first archived ${feed} frame before deadline`));
			}, PER_FEED_TIMEOUT_MS);
			this.waiters.set(feed, () => {
				clearTimeout(timer);
				this.waiters.delete(feed);
				resolve();
			});
		});
	}
}

function withDeadline<T>(
	promise: Promise<T>,
	label: string,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise.finally(() => {
			if (timer) clearTimeout(timer);
		}),
		new Promise<T>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
				timeoutMs,
			);
		}),
	]);
}

function bindServer(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.bindAsync(
			"127.0.0.1:0",
			grpc.ServerCredentials.createInsecure(),
			(error, port) => (error ? reject(error) : resolve(port)),
		);
	});
}

function subscriptions(
	exchange: string,
	symbol: string,
): MarketDataSubscription[] {
	return [
		{ exchange, symbol, feed: "ORDERBOOK", depthLimit: 10 },
		{ exchange, symbol, feed: "TICKER" },
		{ exchange, symbol, feed: "TRADES" },
		{
			exchange,
			symbol,
			feed: "OHLCV",
			timeframe: "1m",
			bootstrapLimit: 0,
		},
	];
}

async function assertLinkedRows(
	harness: ClickHouseLocalHarness,
	captureBundleId: string,
): Promise<void> {
	const normalizedTables: Record<PublicFeed, string[]> = {
		ORDERBOOK: [
			"market_data.cex_order_book_levels",
			"market_data.cex_order_book_depth_summary",
		],
		TICKER: ["market_data.cex_ticker_events"],
		TRADES: ["market_data.cex_trades"],
		OHLCV: ["market_data.cex_ohlcv"],
	};
	for (const feed of ARCHIVE_SMOKE_FEEDS) {
		const rawRows = await harness.query(
			`SELECT raw_capture_id, raw_checksum, checksum_algorithm FROM market_data.cex_stream_events WHERE capture_bundle_id = '${captureBundleId}' AND source = 'broker_read' AND feed = '${feed}' ORDER BY source_time_ms DESC`,
		);
		let linked = false;
		for (const raw of rawRows) {
			const rawCaptureId = String(raw.raw_capture_id ?? "");
			if (
				!rawCaptureId ||
				String(raw.raw_checksum ?? "").length !== 64 ||
				raw.checksum_algorithm !== "sha256-canonical-json-v1"
			) {
				continue;
			}
			const counts = await Promise.all(
				normalizedTables[feed].map(async (table) => {
					const rows = await harness.query(
						`SELECT count() AS count FROM ${table} WHERE capture_bundle_id = '${captureBundleId}' AND source = 'broker_read' AND raw_capture_id = '${rawCaptureId}' AND length(normalized_row_checksum) = 64`,
					);
					return Number(rows[0]?.count ?? 0);
				}),
			);
			if (counts.every((count) => count > 0)) {
				linked = true;
				break;
			}
		}
		if (!linked) {
			throw new Error(`Live ${feed} feed has no linked canonical archive row`);
		}
	}
}

async function runSmoke(): Promise<void> {
	assertArchiveSmokeSafety({
		rpcMethods: ARCHIVE_SMOKE_RPC_METHODS,
		feeds: ARCHIVE_SMOKE_FEEDS,
	});
	const exchangeName = (
		process.env.CEX_BROKER_SMOKE_EXCHANGE?.trim() || "binance"
	).toLowerCase();
	const symbol = process.env.CEX_BROKER_SMOKE_SYMBOL?.trim() || "BTC/USDT";
	if (
		!/^[-a-z0-9_]+$/.test(exchangeName) ||
		!/^[A-Za-z0-9:/_-]+$/.test(symbol)
	) {
		throw new Error(
			"Archive smoke exchange or symbol contains unsafe characters",
		);
	}
	const captureBundleId = `archive-live-smoke-${randomUUID()}`;
	const deploymentId = `archive-live-smoke-${randomUUID()}`;
	const forwarderToken = randomUUID();
	process.env.CEX_BROKER_ARCHIVE_ENABLED = "true";
	process.env.CEX_BROKER_MARKET_ARCHIVE_ENABLED = "true";
	process.env.CEX_BROKER_ARCHIVE_SOURCE = "broker_read";
	process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT = "production";
	process.env.CEX_BROKER_CAPTURE_BUNDLE_ID = captureBundleId;
	process.env.CEX_BROKER_DEPLOYMENT_ID = deploymentId;
	process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN = forwarderToken;
	process.env.ARCHIVE_FORWARDER_TOKEN = forwarderToken;

	const harness = await ClickHouseLocalHarness.create();
	let endpoint:
		| Awaited<ReturnType<typeof startArchiveForwarderEndpoint>>
		| undefined;
	let archiver: BrokerExecutionArchiver | undefined;
	let server: Server | undefined;
	let lifecycle: SubscribeBrokerLifecycle | undefined;
	let collectorAbort: AbortController | undefined;
	let collectorRun: Promise<void> | undefined;
	try {
		await harness.initialize();
		endpoint = await startArchiveForwarderEndpoint({
			inserter: harness.inserter,
			authToken: forwarderToken,
		});
		const deadLetterPath = `${harness.rootDirectory}/archive-live-smoke-loss.jsonl`;
		process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH = deadLetterPath;
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL = endpoint.url;
		archiver = BrokerExecutionArchiver.create({
			source: "broker_read",
			deploymentId,
			forwarderUrl: endpoint.url,
			deadLetterPath,
			batchSize: 1_000,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 20_000,
		});
		lifecycle = new SubscribeBrokerLifecycle();
		const brokers: Record<string, BrokerPoolEntry> = {};
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
			lifecycle,
		);
		const port = await bindServer(server);
		const observer = new FirstFrameObserver();
		const collector = new OhlcvCollector({
			brokerUrl: `127.0.0.1:${port}`,
			subscriptions: subscriptions(exchangeName, symbol),
			metrics: observer,
			retry: { initialDelayMs: 1_000, maxDelayMs: 5_000, jitterRatio: 0 },
		});
		collectorAbort = new AbortController();
		collectorRun = collector.run(collectorAbort.signal);
		await Promise.all(
			ARCHIVE_SMOKE_FEEDS.map((feed) => observer.waitFor(feed)),
		);
		collectorAbort.abort();
		await withDeadline(collectorRun, "collector shutdown", CLEANUP_TIMEOUT_MS);
		collectorRun = undefined;
		server.forceShutdown();
		server = undefined;
		await withDeadline(
			lifecycle.closeAll(),
			"broker shutdown",
			CLEANUP_TIMEOUT_MS,
		);
		lifecycle = undefined;
		await archiver.flush();
		await assertLinkedRows(harness, captureBundleId);
		await archiver.close();
		archiver = undefined;
		console.info(
			`Archive live smoke passed for ${exchangeName} ${symbol}: ORDERBOOK,TICKER,TRADES,OHLCV`,
		);
	} finally {
		collectorAbort?.abort();
		if (collectorRun) {
			await withDeadline(
				collectorRun,
				"collector cleanup",
				CLEANUP_TIMEOUT_MS,
			).catch(() => {});
		}
		server?.forceShutdown();
		if (lifecycle) {
			await withDeadline(
				lifecycle.closeAll(),
				"broker cleanup",
				CLEANUP_TIMEOUT_MS,
			).catch(() => {});
		}
		if (archiver) {
			await withDeadline(
				archiver.close(),
				"archive cleanup",
				CLEANUP_TIMEOUT_MS,
			).catch(() => {});
		}
		if (endpoint) {
			await withDeadline(
				endpoint.close(),
				"forwarder cleanup",
				CLEANUP_TIMEOUT_MS,
			).catch(() => {});
		}
		await withDeadline(
			harness.cleanup(),
			"ClickHouse Local cleanup",
			CLEANUP_TIMEOUT_MS,
		);
	}
}

try {
	await withDeadline(runSmoke(), "archive live smoke", OVERALL_TIMEOUT_MS);
	process.exit(0);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
}
