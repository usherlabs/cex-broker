import { log } from "../../src/helpers/logger";
import { createOtelMetricsFromEnv } from "../../src/helpers/otel";
import { MarketDataCollector } from "./collector";
import {
	loadCollectorBrokerUrl,
	loadMarketDataCollectorConfig,
	loadOhlcvCollectorConfig,
	MARKET_DATA_COLLECTOR_CONFIG_ENV,
	type MarketDataSubscription,
} from "./config";

async function run(): Promise<void> {
	const brokerUrl = loadCollectorBrokerUrl();
	let subscriptions: MarketDataSubscription[];
	if (process.env[MARKET_DATA_COLLECTOR_CONFIG_ENV]?.trim()) {
		const config = await loadMarketDataCollectorConfig();
		subscriptions = config.subscriptions;
	} else {
		subscriptions = (await loadOhlcvCollectorConfig()).map((subscription) => ({
			...subscription,
			feed: "OHLCV" as const,
			bootstrapLimit: 100,
		}));
	}
	const metrics = createOtelMetricsFromEnv();
	const shutdown = new AbortController();
	const onSignal = (signal: NodeJS.Signals) => {
		log.info("Market-data collector shutdown requested", { signal });
		shutdown.abort();
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	try {
		await metrics.initialize();
		log.info("Market-data collector service started", {
			broker_url: brokerUrl,
			subscriptions: subscriptions.length,
			feeds: [...new Set(subscriptions.map(({ feed }) => feed))],
		});
		const collector = new MarketDataCollector({
			brokerUrl,
			subscriptions,
			metrics,
		});
		await collector.run(shutdown.signal);
	} finally {
		shutdown.abort();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await metrics.close();
		log.info("Market-data collector service stopped");
	}
}

try {
	await run();
} catch (error) {
	log.fatal("Market-data collector service failed", { error });
	process.exitCode = 1;
}
