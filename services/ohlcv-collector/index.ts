import * as grpc from "@grpc/grpc-js";
import { createBrokerExecutionArchiverFromEnv } from "../../src/helpers/broker-execution-archive";
import { log } from "../../src/helpers/logger";
import {
	createOtelLogsFromEnv,
	createOtelMetricsFromEnv,
} from "../../src/helpers/otel";
import { getServer } from "../../src/server";
import type { PolicyConfig } from "../../src/types";
import { OhlcvCollector } from "./collector";
import { loadOhlcvCollectorConfig } from "./config";

const PUBLIC_ONLY_POLICY: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

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

async function run(): Promise<void> {
	const subscriptions = await loadOhlcvCollectorConfig();
	const metrics = createOtelMetricsFromEnv();
	const otelLogs = createOtelLogsFromEnv();
	const archiver = createBrokerExecutionArchiverFromEnv(otelLogs, metrics);
	const server = getServer(
		PUBLIC_ONLY_POLICY,
		{},
		["127.0.0.1", "::1"],
		false,
		"",
		metrics,
		archiver,
	);
	const shutdown = new AbortController();
	const onSignal = (signal: NodeJS.Signals) => {
		log.info("OHLCV collector shutdown requested", { signal });
		shutdown.abort();
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	try {
		await metrics.initialize();
		const port = await bindPublicBroker(server);
		const brokerUrl = `127.0.0.1:${port}`;
		log.info("OHLCV collector service started", {
			broker_url: brokerUrl,
			subscriptions: subscriptions.length,
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
		await archiver.close();
		await metrics.close();
		await otelLogs.close();
	}
}

try {
	await run();
} catch (error) {
	log.fatal("OHLCV collector service failed", { error });
	process.exitCode = 1;
}
