import {
	BACKFILL_REQUEST_SCHEMA_VERSION,
	createBackfillIdempotencyKey,
	type MarketDataVendorBackfillRequest,
	type ProviderCapability,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import type { ProviderDataset } from "../src/helpers/market-data-vendor-backfill/core";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	CryptoHftDataAdapter,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";

const CONFORMANCE_WINDOW_MS = 60_000;

export function buildCryptoHftDataConformanceRequest(
	startTimeMs: number,
): MarketDataVendorBackfillRequest {
	if (
		!Number.isSafeInteger(startTimeMs) ||
		startTimeMs < Date.UTC(2025, 5, 28)
	) {
		throw new Error("conformance_start_time_invalid");
	}
	const business = {
		schemaVersion: BACKFILL_REQUEST_SCHEMA_VERSION,
		requestId: `cryptohftdata-conformance-${startTimeMs}`,
		providerPolicy: {
			provider: "cryptohftdata" as const,
			allowedAdapterVersions: ["cryptohftdata-orderbook/v2"],
		},
		scope: {
			exchange: "okx",
			tradingPair: "ARB-USDT",
			sourceSymbol: "ARB-USDT",
			marketType: "spot" as const,
			feed: "ORDERBOOK" as const,
		},
		window: {
			startTimeMs,
			endTimeMs: startTimeMs + CONFORMANCE_WINDOW_MS,
		},
		depth: 20,
		constructionMode: "sampled_top_n_snapshot" as const,
		requiredClockTargetsMs: [startTimeMs + CONFORMANCE_WINDOW_MS / 2],
		maxPriorAsOfLagMs: CONFORMANCE_WINDOW_MS,
		sourcePolicy: "authoritative_window" as const,
		budgets: {
			maxFiles: 1,
			maxBytes: 1024 * 1024 * 1024,
			maxRows: 10_000_000,
			maxDurationMs: 120_000,
			maxBoundaryLookbackMs: 0,
		},
		expectedProduct: {
			packageName: "@usherlabs/cex-broker" as const,
			canonicalSchemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1" as const,
		},
	};
	return {
		...business,
		idempotencyKey: createBackfillIdempotencyKey(business),
	};
}

export function toHashOnlyConformanceEvidence(
	capability: ProviderCapability,
	dataset: ProviderDataset,
) {
	return {
		schemaVersion:
			"market-data-vendor-backfill-provider-conformance/v1" as const,
		provider: capability.provider,
		adapterVersion: capability.adapterVersion,
		providerExchangeId: capability.providerExchangeId,
		resolvedSymbol: capability.resolvedSymbol,
		objects: dataset.objects.map(({ identity, checksum, bytes, rows }) => ({
			identity,
			checksum,
			bytes,
			rows,
		})),
		vendorSemanticDigest: dataset.vendorSemanticDigest,
	};
}

export async function runCryptoHftDataConformance(input: {
	startTimeMs: number;
	apiKey: string;
	fetch?: typeof globalThis.fetch;
}) {
	if (!input.apiKey.trim()) throw new Error("cryptohftdata_api_key_missing");
	const request = buildCryptoHftDataConformanceRequest(input.startTimeMs);
	const adapter = new CryptoHftDataAdapter({
		fetch: input.fetch,
		profiles: [CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE],
	});
	const capability = adapter.capabilityFor(request);
	if (!capability) throw new Error("conformance_profile_unsupported");
	const dataset = await adapter.acquire(request, capability, {
		apiKey: input.apiKey,
	});
	return toHashOnlyConformanceEvidence(capability, dataset);
}

if (import.meta.main) {
	if (process.env.CRYPTOHFTDATA_CONFORMANCE_ENABLED !== "1") {
		throw new Error(
			"Set CRYPTOHFTDATA_CONFORMANCE_ENABLED=1 to run the licensed-provider conformance probe",
		);
	}
	const startTimeMs = Number(
		process.env.CRYPTOHFTDATA_CONFORMANCE_START_MS ?? "",
	);
	const evidence = await runCryptoHftDataConformance({
		startTimeMs,
		apiKey: process.env.CRYPTOHFTDATA_API_KEY ?? "",
	});
	console.log(JSON.stringify(evidence, null, 2));
}
