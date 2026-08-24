import { createHash } from "node:crypto";
import {
	ARCHIVE_SELECTION_SCHEMA_ID,
	BACKFILL_REQUEST_SCHEMA_ID,
	type BackfillRequestWire,
	createBackfillIdempotencyKey,
	decodeBackfillRunDocuments,
	finalizeArchiveSelection,
	finalizeRequiredClock,
	type MarketDataVendorBackfillRequest,
	type ProviderCapability,
	REQUIRED_CLOCK_SCHEMA_ID,
	type RequiredClockWire,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import type { ProviderDataset } from "../src/helpers/market-data-vendor-backfill/core";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	CryptoHftDataAdapter,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import { jcsSha256 } from "../src/helpers/market-data-vendor-backfill/identity";
import {
	CAPABILITY_POLICY,
	RESOURCE_POLICY,
} from "../src/helpers/market-data-vendor-backfill/manifests";

const CONFORMANCE_WINDOW_MS = 60_000;
const CONFORMANCE_TARGET = {
	environment: "production",
	cluster: "cex-archive-primary",
} as const;
const CONFORMANCE_COVERAGE_POLICY = {
	policy_id: "prior-asof-strict/v1",
	max_asof_lag_ms: CONFORMANCE_WINDOW_MS,
	future_rows: "reject",
	missing_required_event: "fail",
} as const;
const CONFORMANCE_CANONICAL_SCHEMA = {
	schema_id: "cex-order-book-canonical/v1",
	schema_sha256: jcsSha256({
		schema_version: "1.0.0",
		checksum_algorithm: "sha256-canonical-json-v1",
	}),
} as const;

export type CryptoHftDataConformanceDocuments = {
	request: BackfillRequestWire;
	requiredClock: RequiredClockWire;
};

export type CryptoHftDataConformancePair = "ARB-USDC" | "ARB-USDT";

function deterministicUuid(startTimeMs: number, role: string): string {
	const hex = createHash("sha256")
		.update(`market-data-vendor-backfill-conformance:${startTimeMs}:${role}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildCryptoHftDataConformanceDocuments(
	startTimeMs: number,
	tradingPair: CryptoHftDataConformancePair = "ARB-USDT",
): CryptoHftDataConformanceDocuments {
	if (
		!Number.isSafeInteger(startTimeMs) ||
		startTimeMs < Date.UTC(2025, 5, 28)
	) {
		throw new Error("conformance_start_time_invalid");
	}
	if (tradingPair !== "ARB-USDC" && tradingPair !== "ARB-USDT") {
		throw new Error("conformance_pair_unsupported");
	}
	const runUuid = (role: string) =>
		deterministicUuid(startTimeMs, `${tradingPair}:${role}`);
	const endTimeMs = startTimeMs + CONFORMANCE_WINDOW_MS;
	const scope = {
		exchange: "okx",
		trading_pair: tradingPair,
		market_type: "spot",
		feed: "ORDERBOOK",
	} as const;
	const window = {
		start_at: new Date(startTimeMs).toISOString(),
		end_at: new Date(endTimeMs).toISOString(),
	};
	const requiredClock = finalizeRequiredClock({
		schema_id: REQUIRED_CLOCK_SCHEMA_ID,
		clock_id: runUuid("clock"),
		created_at: new Date(startTimeMs).toISOString(),
		targets: [
			{
				target_id: runUuid("target"),
				target_at: new Date(
					startTimeMs + CONFORMANCE_WINDOW_MS / 2,
				).toISOString(),
			},
		],
	});
	const initialSelection = finalizeArchiveSelection({
		schema_id: ARCHIVE_SELECTION_SCHEMA_ID,
		scope,
		required_clock: {
			clock_id: requiredClock.clock_id,
			clock_sha256: requiredClock.clock_sha256,
			event_count: requiredClock.targets.length,
		},
		coverage_policy: CONFORMANCE_COVERAGE_POLICY,
		source_policy: "authoritative_window",
		coverage_class: "missing",
		requested_intervals: [window],
		selected_intervals: [],
		precedence: ["vendor"],
		bundles: [],
		support_anchors: [],
		receipt_ids: [],
		qualification_event_ids: [],
		resolved_at: new Date(startTimeMs).toISOString(),
	});
	const requestContent = {
		schema_id: BACKFILL_REQUEST_SCHEMA_ID,
		request_id: runUuid("request"),
		attempt_id: runUuid("attempt"),
		scope,
		window,
		depth: 20,
		construction_mode: "sampled_top_n_snapshot",
		source_policy: "authoritative_window",
		target: CONFORMANCE_TARGET,
		coverage_policy: CONFORMANCE_COVERAGE_POLICY,
		required_clock: {
			schema_id: REQUIRED_CLOCK_SCHEMA_ID,
			clock_id: requiredClock.clock_id,
			file_name: "required-clock.json",
			clock_sha256: requiredClock.clock_sha256,
			event_count: requiredClock.targets.length,
		},
		initial_selection: initialSelection,
		expected_canonical_schema: CONFORMANCE_CANONICAL_SCHEMA,
		product_pins: {
			capability_policy: {
				policy_id: CAPABILITY_POLICY.policy_id,
				policy_sha256: CAPABILITY_POLICY.policy_sha256,
			},
			resource_policy: {
				policy_id: RESOURCE_POLICY.policy_id,
				policy_sha256: RESOURCE_POLICY.policy_sha256,
			},
		},
		production_authorization_id: runUuid("production-authorization"),
	} as const;
	return {
		request: {
			...requestContent,
			idempotency_key: createBackfillIdempotencyKey(requestContent),
		},
		requiredClock,
	};
}

export function buildCryptoHftDataConformanceRequest(
	startTimeMs: number,
	tradingPair: CryptoHftDataConformancePair = "ARB-USDT",
): MarketDataVendorBackfillRequest {
	return decodeBackfillRunDocuments(
		buildCryptoHftDataConformanceDocuments(startTimeMs, tradingPair),
	);
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
	tradingPair?: CryptoHftDataConformancePair;
	apiKey: string;
	fetch?: typeof globalThis.fetch;
}) {
	if (!input.apiKey.trim()) throw new Error("cryptohftdata_api_key_missing");
	const request = buildCryptoHftDataConformanceRequest(
		input.startTimeMs,
		input.tradingPair,
	);
	const adapter = new CryptoHftDataAdapter({
		fetch: input.fetch,
		profiles: [
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
		],
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
		tradingPair: (process.env.CRYPTOHFTDATA_CONFORMANCE_TRADING_PAIR ??
			"ARB-USDT") as CryptoHftDataConformancePair,
		apiKey: process.env.CRYPTOHFTDATA_API_KEY ?? "",
	});
	console.log(JSON.stringify(evidence, null, 2));
}
