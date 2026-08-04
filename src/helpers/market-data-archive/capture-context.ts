import type { BrokerArchiveSource } from "../broker-execution-archive/types";
import type { BrokerMarketType } from "../market-type";
import {
	CHECKSUM_ALGORITHM,
	MARKET_CAPTURE_SCHEMA_VERSION,
} from "./capture-contract";
import type {
	CaptureFeed,
	CaptureSourceMode,
	MarketCaptureContext,
} from "./types";

export type CaptureEnvironment = "development" | "production";

export function createMarketCaptureContext(input: {
	source: BrokerArchiveSource;
	deploymentId: string;
	captureBundleId?: string;
	exchange: string;
	symbol: string;
	assetType: BrokerMarketType;
	feed: CaptureFeed;
	provider?: string;
	sourceMode: CaptureSourceMode;
	timeframe?: string;
	accountSelector?: string;
	environment?: CaptureEnvironment;
}): MarketCaptureContext {
	const environment = input.environment ?? "development";
	const deploymentId = input.deploymentId.trim();
	if (!deploymentId) throw new Error("deployment_id must not be empty");
	const configuredBundle = input.captureBundleId?.trim();
	if (environment === "production" && !configuredBundle) {
		throw new Error(
			"capture_bundle_id is required for production market capture",
		);
	}
	const exchange = input.exchange.trim().toLowerCase();
	const symbol = input.symbol.trim();
	if (!exchange || !symbol) {
		throw new Error("exchange and symbol are required for market capture");
	}
	return {
		source: input.source,
		deploymentId,
		captureBundleId: configuredBundle ?? `development:${deploymentId}`,
		exchange,
		symbol,
		assetType: input.assetType,
		feed: input.feed,
		provider: input.provider?.trim() || `ccxt:${exchange}`,
		sourceMode: input.sourceMode,
		schemaVersion: MARKET_CAPTURE_SCHEMA_VERSION,
		checksumAlgorithm: CHECKSUM_ALGORITHM,
		provenanceComplete: true,
		timeframe: input.timeframe,
		accountSelector: input.accountSelector,
	};
}

export type MarketCaptureArchiveDisabledReason =
	| "archive_disabled"
	| "market_archive_disabled"
	| "invalid_capture_environment"
	| "missing_deployment_id"
	| "missing_capture_bundle_id";

export type MarketCaptureArchiveState =
	| { enabled: true }
	| { enabled: false; reason: MarketCaptureArchiveDisabledReason };

export function resolveMarketCaptureArchiveState(input: {
	archiveEnabled: boolean;
	marketArchiveEnabled: boolean;
	environment?: string;
	deploymentId?: string;
	captureBundleId?: string;
}): MarketCaptureArchiveState {
	if (!input.archiveEnabled) {
		return { enabled: false, reason: "archive_disabled" };
	}
	if (!input.marketArchiveEnabled) {
		return { enabled: false, reason: "market_archive_disabled" };
	}
	const environment = input.environment?.trim() || "development";
	if (environment !== "development" && environment !== "production") {
		return { enabled: false, reason: "invalid_capture_environment" };
	}
	if (environment === "production") {
		const deploymentId = input.deploymentId?.trim();
		if (!deploymentId || deploymentId === "unknown") {
			return { enabled: false, reason: "missing_deployment_id" };
		}
		if (!input.captureBundleId?.trim()) {
			return { enabled: false, reason: "missing_capture_bundle_id" };
		}
	}
	return { enabled: true };
}

export function validateExternalFallbackContext(input: {
	configuredExchange: string;
	configuredSymbol: string;
	rowExchange: string;
	rowSymbol: string;
	provider: string;
	sourceMode: "external_ccxt_fallback_v1" | "external_hummingbot_fallback_v1";
	fallbackReason: string;
}): void {
	if (
		input.configuredExchange.trim().toLowerCase() !==
		input.rowExchange.trim().toLowerCase()
	) {
		throw new Error("External fallback rejected: cross-venue substitution");
	}
	if (input.configuredSymbol.trim() !== input.rowSymbol.trim()) {
		throw new Error("External fallback rejected: cross-pair substitution");
	}
	if (!input.provider.trim()) {
		throw new Error("External fallback provider is required");
	}
	if (!input.fallbackReason.trim()) {
		throw new Error("External fallback reason is required");
	}
}

export function captureEnvironmentFromEnv(
	value = process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT,
): CaptureEnvironment {
	const environment = value?.trim() || "development";
	if (environment !== "development" && environment !== "production") {
		throw new Error(
			"CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT must be development or production",
		);
	}
	return environment;
}
