import { log } from "../../src/helpers/logger";
import { createOtelMetricsFromEnv } from "../../src/helpers/otel";
import { MarketDataCollector } from "./collector";
import {
	loadMarketDataCollectorConfig,
	MARKET_DATA_COLLECTOR_CONFIG_ENV,
} from "./config";

const BROKER_URL_ENV = "CEX_BROKER_URL";

async function run(): Promise<void> {
	const brokerUrl = process.env[BROKER_URL_ENV]?.trim();
	if (!brokerUrl) {
		throw new Error(`${BROKER_URL_ENV} must be nonempty`);
	}
	const { subscriptions } = await loadMarketDataCollectorConfig(
		process.env[MARKET_DATA_COLLECTOR_CONFIG_ENV],
	);
	const metrics = createOtelMetricsFromEnv({
		allowLegacyBrokerConfig: false,
		defaultServiceName: "market-data-collector",
	});
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
