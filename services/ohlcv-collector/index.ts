import * as grpc from "@grpc/grpc-js";
import { SubscribeBrokerLifecycle } from "../../src/handlers/subscribe";
import { createBrokerExecutionArchiverFromEnv } from "../../src/helpers/broker-execution-archive";
import { log } from "../../src/helpers/logger";
import { validateProductionCollectorArchive } from "../../src/helpers/market-data-archive/capture-context";
import {
	createOtelLogsFromEnv,
	createOtelMetricsFromEnv,
} from "../../src/helpers/otel";
import { getServer } from "../../src/server";
import type { PolicyConfig } from "../../src/types";
import { OhlcvCollector } from "./collector";
import {
	loadMarketDataCollectorConfig,
	loadOhlcvCollectorConfig,
	MARKET_DATA_COLLECTOR_CONFIG_ENV,
	type MarketDataSubscription,
} from "./config";

const PUBLIC_ONLY_POLICY: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

// CCXT can otherwise retain a connecting WebSocket until its own 10-second timer fires.
const SHUTDOWN_CLOSE_TIMEOUT_MS = 2_000;

type CloseResult = "closed" | "failed" | "timed_out";

async function closeWithinDeadline(
	path: string,
	close: () => Promise<void>,
): Promise<CloseResult> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			close().then(() => "closed" as const),
			new Promise<"timed_out">((resolve) => {
				timeout = setTimeout(
					() => resolve("timed_out"),
					SHUTDOWN_CLOSE_TIMEOUT_MS,
				);
			}),
		]);
		if (result === "timed_out") {
			log.warn("OHLCV collector shutdown path timed out", {
				path,
				timeout_ms: SHUTDOWN_CLOSE_TIMEOUT_MS,
			});
		}
		return result;
	} catch (error) {
		log.warn("OHLCV collector shutdown path failed", { path, error });
		return "failed";
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function bindPublicBroker(server: grpc.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.bindAsync(
			"127.0.0.1:0",
			grpc.ServerCredentials.createInsecure(),
			(error, port) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(port);
			},
		);
	});
}

async function run(): Promise<string[]> {
	let subscriptions: MarketDataSubscription[];
	let productionCaptureBundleId: string | undefined;
	if (process.env[MARKET_DATA_COLLECTOR_CONFIG_ENV]?.trim()) {
		const config = await loadMarketDataCollectorConfig();
		subscriptions = config.subscriptions;
		process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT = config.environment;
		if (config.captureBundleId) {
			process.env.CEX_BROKER_CAPTURE_BUNDLE_ID = config.captureBundleId;
		}
		if (config.environment === "production") {
			productionCaptureBundleId = config.captureBundleId;
		}
	} else {
		subscriptions = (await loadOhlcvCollectorConfig()).map((subscription) => ({
			...subscription,
			feed: "OHLCV" as const,
			bootstrapLimit: 100,
		}));
	}
	const metrics = createOtelMetricsFromEnv();
	const otelLogs = createOtelLogsFromEnv();
	const archiver = createBrokerExecutionArchiverFromEnv(otelLogs, metrics);
	if (productionCaptureBundleId) {
		validateProductionCollectorArchive({
			source: archiver.getSource(),
			captureBundleId: productionCaptureBundleId,
		});
	}
	const subscribeBrokerLifecycle = new SubscribeBrokerLifecycle();
	const server = getServer(
		PUBLIC_ONLY_POLICY,
		{},
		["127.0.0.1", "::1"],
		false,
		"",
		metrics,
		archiver,
		undefined,
		undefined,
		subscribeBrokerLifecycle,
		{
			sourcePolicy: "provisioned_only",
			provisionedProfile: "public",
		},
	);
	const shutdown = new AbortController();
	const onSignal = (signal: NodeJS.Signals) => {
		log.info("OHLCV collector shutdown requested", { signal });
		shutdown.abort();
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	const incompletePaths: string[] = [];

	try {
		await metrics.initialize();
		const port = await bindPublicBroker(server);
		const brokerUrl = `127.0.0.1:${port}`;
		log.info("OHLCV collector service started", {
			broker_url: brokerUrl,
			subscriptions: subscriptions.length,
			feeds: [...new Set(subscriptions.map(({ feed }) => feed))],
			bootstrap_limit:
				process.env.CEX_BROKER_OHLCV_ARCHIVE_BOOTSTRAP_LIMIT ?? "100",
		});
		const collector = new OhlcvCollector({
			brokerUrl,
			subscriptions,
			metrics,
		});
		await collector.run(shutdown.signal);
	} finally {
		shutdown.abort();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		server.forceShutdown();
		const closeAndRecord = async (
			path: string,
			close: () => Promise<void>,
		): Promise<void> => {
			if ((await closeWithinDeadline(path, close)) !== "closed") {
				incompletePaths.push(path);
			}
		};
		const brokerClose = closeAndRecord("subscribe_brokers", () =>
			subscribeBrokerLifecycle.closeAll(),
		);
		await closeAndRecord("archiver", () => archiver.close());
		await closeAndRecord("metrics", () => metrics.close());
		await closeAndRecord("otel_logs", () => otelLogs.close());
		await brokerClose;
		log.info("OHLCV collector service stopped", {
			incomplete_paths: incompletePaths,
		});
	}

	return incompletePaths;
}

try {
	const incompletePaths = await run();
	if (incompletePaths.length > 0) {
		log.warn("Forcing process exit after bounded OHLCV collector shutdown", {
			incomplete_paths: incompletePaths,
		});
		process.exit(0);
	}
} catch (error) {
	log.fatal("OHLCV collector service failed", { error });
	process.exitCode = 1;
}
