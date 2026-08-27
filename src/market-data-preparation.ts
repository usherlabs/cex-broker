import { fileURLToPath } from "node:url";
import {
	createMarketDataSourceTapeDependenciesForRuntime,
	type MarketDataSourceTapeDependencyConfiguration,
} from "./helpers/market-data-preparation/source-tape-dependencies";
import type { MarketDataSourceTapeDependencies } from "./helpers/market-data-preparation/source-tape-operation";

export * from "./helpers/canonical-orderbook-export/exact-selection";
export * from "./helpers/canonical-orderbook-export/exporter";
export * from "./helpers/market-data-preparation/conformance-fixtures";
export * from "./helpers/market-data-preparation/contracts";
export * from "./helpers/market-data-preparation/required-clock-qualification";
export * from "./helpers/market-data-preparation/source-tape-operation";
export * from "./helpers/market-data-source-forensics";

export type { MarketDataSourceTapeDependencyConfiguration };

export function createMarketDataSourceTapeDependencies(
	configuration: MarketDataSourceTapeDependencyConfiguration,
): MarketDataSourceTapeDependencies {
	return createMarketDataSourceTapeDependenciesForRuntime(configuration, {
		exporterExecutablePath: fileURLToPath(
			new URL("./commands/cex-canonical-orderbook-export.js", import.meta.url),
		),
		nodeExecutablePath: process.execPath,
	});
}
