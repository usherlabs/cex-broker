import Ajv2020, {
	type ErrorObject,
	type ValidateFunction,
} from "ajv/dist/2020.js";
import { z } from "zod";
import { sha256Canonical } from "../market-data-archive/capture-contract";
import { assertDocumentSha256, documentSha256, jcsSha256 } from "./identity";
import {
	CAPABILITY_POLICY,
	LEGACY_CAPABILITY_POLICY,
	LEGACY_RESOURCE_POLICY,
	PREVIOUS_CAPABILITY_POLICY,
	RESOURCE_POLICY,
} from "./manifests";
import archiveSelectionSchemaJson from "./schemas/archive-selection.schema.json" with {
	type: "json",
};
import promotionReceiptSchemaJson from "./schemas/promotion-receipt.schema.json" with {
	type: "json",
};
import requestSchemaJson from "./schemas/request.schema.json" with {
	type: "json",
};
import requiredClockSchemaJson from "./schemas/required-clock.schema.json" with {
	type: "json",
};
import resultSchemaJson from "./schemas/result.schema.json" with {
	type: "json",
};

export const BACKFILL_REQUEST_SCHEMA_ID = requestSchemaJson.$id;
export const REQUIRED_CLOCK_SCHEMA_ID = requiredClockSchemaJson.$id;
export const ARCHIVE_SELECTION_SCHEMA_ID = archiveSelectionSchemaJson.$id;
export const PROMOTION_RECEIPT_SCHEMA_ID = promotionReceiptSchemaJson.$id;
export const BACKFILL_RESULT_SCHEMA_ID = resultSchemaJson.$id;

export type FixedUtcTimestamp = string;
export type Sha256Hex = string;
export type LowercaseUuid = string;

export type CanonicalScopeWire = {
	exchange: string;
	trading_pair: string;
	market_type: "spot" | "swap" | "future";
	feed: "ORDERBOOK";
};

export type CoveragePolicyWire = {
	policy_id: "prior-asof-strict/v1";
	max_asof_lag_ms: number;
	future_rows: "reject";
	missing_required_event: "fail";
};

export type RequiredClockWire = {
	schema_id: typeof REQUIRED_CLOCK_SCHEMA_ID;
	clock_id: LowercaseUuid;
	clock_sha256: Sha256Hex;
	created_at: FixedUtcTimestamp;
	targets: Array<{ target_id: LowercaseUuid; target_at: FixedUtcTimestamp }>;
};

export type ArchiveSelectionWire = {
	schema_id: typeof ARCHIVE_SELECTION_SCHEMA_ID;
	selection_sha256: Sha256Hex;
	scope: CanonicalScopeWire;
	required_clock: {
		clock_id: LowercaseUuid;
		clock_sha256: Sha256Hex;
		event_count: number;
	};
	coverage_policy: CoveragePolicyWire;
	source_policy: "authoritative_window" | "fill_gaps";
	coverage_class: "complete" | "partial" | "missing";
	requested_intervals: Array<{
		start_at: FixedUtcTimestamp;
		end_at: FixedUtcTimestamp;
	}>;
	selected_intervals: Array<{
		start_at: FixedUtcTimestamp;
		end_at: FixedUtcTimestamp;
		capture_bundle_id: Sha256Hex;
		capture_origin: "production_capture" | "vendor_historical_backfill";
	}>;
	precedence: Array<"archive" | "vendor">;
	bundles: Array<{
		capture_bundle_id: Sha256Hex;
		capture_origin: "production_capture" | "vendor_historical_backfill";
		interval: { start_at: FixedUtcTimestamp; end_at: FixedUtcTimestamp };
		qualification: null | {
			qualification_event_id: LowercaseUuid;
			state: "qualified";
			receipt_id: Sha256Hex;
			promotion_identity_sha256: Sha256Hex;
		};
	}>;
	support_anchors: Array<{
		capture_bundle_id: Sha256Hex;
		raw_capture_id: Sha256Hex;
		snapshot_id: Sha256Hex;
		source_time: FixedUtcTimestamp;
		normalized_summary_checksum: Sha256Hex;
		metadata_ref: {
			capture_origin: "production_capture" | "vendor_historical_backfill";
			qualification_event_id: LowercaseUuid | null;
			receipt_id: Sha256Hex | null;
		};
	}>;
	receipt_ids: Sha256Hex[];
	qualification_event_ids: LowercaseUuid[];
	resolved_at: FixedUtcTimestamp;
};

export type BackfillRequestWire = {
	schema_id: typeof BACKFILL_REQUEST_SCHEMA_ID;
	request_id: LowercaseUuid;
	attempt_id: LowercaseUuid;
	idempotency_key: Sha256Hex;
	scope: CanonicalScopeWire;
	window: { start_at: FixedUtcTimestamp; end_at: FixedUtcTimestamp };
	depth: number;
	construction_mode: "sampled_top_n_snapshot" | "exact_l2_reconstruction";
	source_policy: "authoritative_window" | "fill_gaps";
	target: { environment: string; cluster: string };
	coverage_policy: CoveragePolicyWire;
	required_clock: {
		schema_id: typeof REQUIRED_CLOCK_SCHEMA_ID;
		clock_id: LowercaseUuid;
		file_name: string;
		clock_sha256: Sha256Hex;
		event_count: number;
	};
	initial_selection: ArchiveSelectionWire;
	expected_canonical_schema: {
		schema_id: string;
		schema_sha256: Sha256Hex;
	};
	product_pins: {
		capability_policy: { policy_id: string; policy_sha256: Sha256Hex };
		resource_policy: { policy_id: string; policy_sha256: Sha256Hex };
	};
	production_authorization_id: LowercaseUuid;
};

export type PromotionReceiptWire = {
	schema_id: typeof PROMOTION_RECEIPT_SCHEMA_ID;
	receipt_id: Sha256Hex;
	promotion_identity_sha256: Sha256Hex;
	verified_at: FixedUtcTimestamp;
	request_id: LowercaseUuid;
	idempotency_key: Sha256Hex;
	source: "external_backfill";
	capture_origin: "vendor_historical_backfill";
	source_mode: "vendor_historical_backfill_v1";
	provider: string;
	adapter_version: string;
	effective_policies: {
		capability_policy: { policy_id: string; policy_sha256: Sha256Hex };
		resource_policy: { policy_id: string; policy_sha256: Sha256Hex };
		adapter_policy: { policy_id: string; policy_sha256: Sha256Hex };
		acquisition_policy: { policy_id: string; policy_sha256: Sha256Hex };
	};
	capture_bundle_id: Sha256Hex;
	scope: CanonicalScopeWire;
	window: { start_at: FixedUtcTimestamp; end_at: FixedUtcTimestamp };
	depth: number;
	construction_mode: "sampled_top_n_snapshot" | "exact_l2_reconstruction";
	canonical_schema: { schema_id: string; schema_sha256: Sha256Hex };
	coverage_policy: CoveragePolicyWire;
	selection_sha256: Sha256Hex;
	vendor_semantic_digest: Sha256Hex;
	canonical_semantic_digest: Sha256Hex;
	prefix_digest: Sha256Hex;
	suffix_digest: Sha256Hex;
	seam_verified: true;
	coverage_verified: true;
	dataset_objects: Array<{
		identity: string;
		checksum: Sha256Hex;
		bytes: number;
		rows: number;
	}>;
};

export const FINAL_BACKFILL_STATUSES = [
	"request_invalid",
	"archive_preflight_failed",
	"already_covered",
	"promoted",
	"capability_unsupported",
	"credentials_missing",
	"vendor_fetch_failed",
	"archive_ingest_failed",
	"promotion_verification_failed",
] as const;

export type FinalBackfillStatus = (typeof FINAL_BACKFILL_STATUSES)[number];

export type BackfillJobResultWire = {
	schema_id: typeof BACKFILL_RESULT_SCHEMA_ID;
	result_sha256: Sha256Hex;
	job_id: LowercaseUuid;
	request_file_sha256: Sha256Hex | null;
	executable_sha256: Sha256Hex;
	schema_manifest_sha256: Sha256Hex;
	cex_package: {
		name: "@usherlabs/cex-broker";
		version: string;
		package_sha256: Sha256Hex;
	};
	capability_policy: { policy_id: string; policy_sha256: Sha256Hex };
	resource_policy: { policy_id: string; policy_sha256: Sha256Hex };
	build: { fiet_tee_commit: string; created_at: FixedUtcTimestamp };
	started_at: FixedUtcTimestamp;
	completed_at: FixedUtcTimestamp;
	outcome: {
		status: FinalBackfillStatus;
		reason_code: string;
		reason_subcode: string | null;
		request_id: LowercaseUuid | null;
		idempotency_key: Sha256Hex | null;
		target: { environment: string; cluster: string } | null;
		selection: ArchiveSelectionWire | null;
		receipt: PromotionReceiptWire | null;
		diagnostics: Record<string, string | number | boolean>;
	};
};

type Codec<T> = {
	decode(value: unknown): T;
	is(value: unknown): value is T;
};

function describeAjvErrors(errors: ErrorObject[] | null | undefined): string {
	return (errors ?? [])
		.map(
			(error) =>
				`${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
		)
		.join("; ");
}

function codec<T>(
	validate: ValidateFunction,
	semantic?: (document: T) => void,
): Codec<T> {
	return {
		decode(value: unknown): T {
			if (!validate(value)) {
				throw new Error(
					`JSON Schema validation failed: ${describeAjvErrors(validate.errors)}`,
				);
			}
			semantic?.(value as T);
			return value as T;
		},
		is(value: unknown): value is T {
			if (!validate(value)) return false;
			try {
				semantic?.(value as T);
				return true;
			} catch {
				return false;
			}
		},
	};
}

function fixedTimestampMs(value: string, field: string): number {
	const parsed = Date.parse(value);
	if (
		!Number.isSafeInteger(parsed) ||
		new Date(parsed).toISOString() !== value
	) {
		throw new Error(`${field} is not a fixed UTC RFC3339 timestamp`);
	}
	return parsed;
}

function assertIncreasingInterval(
	interval: { start_at: string; end_at: string },
	field: string,
): void {
	if (
		fixedTimestampMs(interval.end_at, `${field}.end_at`) <=
		fixedTimestampMs(interval.start_at, `${field}.start_at`)
	) {
		throw new Error(`${field} must be an increasing half-open interval`);
	}
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(archiveSelectionSchemaJson);
ajv.addSchema(promotionReceiptSchemaJson);
const validateRequiredClock = ajv.compile(requiredClockSchemaJson);
const validateArchiveSelection = ajv.getSchema(ARCHIVE_SELECTION_SCHEMA_ID);
const validatePromotionReceipt = ajv.getSchema(PROMOTION_RECEIPT_SCHEMA_ID);
const validateBackfillRequest = ajv.compile(requestSchemaJson);
const validateBackfillResult = ajv.compile(resultSchemaJson);
if (!validateArchiveSelection || !validatePromotionReceipt) {
	throw new Error("Backfill referenced schemas were not registered");
}

export const requiredClockCodec = codec<RequiredClockWire>(
	validateRequiredClock,
	(clock) => {
		assertDocumentSha256(clock, "clock_sha256");
		let previous = -1;
		const targetIds = new Set<string>();
		for (const [index, target] of clock.targets.entries()) {
			const at = fixedTimestampMs(
				target.target_at,
				`targets[${index}].target_at`,
			);
			if (at <= previous)
				throw new Error("required clock targets must be strictly increasing");
			if (targetIds.has(target.target_id))
				throw new Error("required clock target IDs must be unique");
			targetIds.add(target.target_id);
			previous = at;
		}
	},
);

export const archiveSelectionCodec = codec<ArchiveSelectionWire>(
	validateArchiveSelection,
	(selection) => {
		assertDocumentSha256(selection, "selection_sha256");
		selection.requested_intervals.forEach((interval, index) => {
			assertIncreasingInterval(interval, `requested_intervals[${index}]`);
		});
		selection.selected_intervals.forEach((interval, index) => {
			assertIncreasingInterval(interval, `selected_intervals[${index}]`);
		});
		selection.bundles.forEach((bundle, index) => {
			assertIncreasingInterval(bundle.interval, `bundles[${index}].interval`);
		});
		if (
			selection.coverage_class === "missing" &&
			selection.selected_intervals.length !== 0
		) {
			throw new Error("missing selection cannot contain selected intervals");
		}
	},
);

function promotionSemanticFields(
	receipt: PromotionReceiptWire,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(receipt).filter(
			([key]) =>
				key !== "receipt_id" &&
				key !== "promotion_identity_sha256" &&
				key !== "verified_at",
		),
	);
}

export function promotionIdentitySha256(
	receipt: Omit<
		PromotionReceiptWire,
		"receipt_id" | "promotion_identity_sha256"
	> &
		Partial<
			Pick<PromotionReceiptWire, "receipt_id" | "promotion_identity_sha256">
		>,
): string {
	return jcsSha256(promotionSemanticFields(receipt as PromotionReceiptWire));
}

export const promotionReceiptCodec = codec<PromotionReceiptWire>(
	validatePromotionReceipt,
	(receipt) => {
		assertIncreasingInterval(receipt.window, "window");
		if (
			promotionIdentitySha256(receipt) !== receipt.promotion_identity_sha256
		) {
			throw new Error(
				"promotion_identity_sha256 does not match semantic receipt content",
			);
		}
		assertDocumentSha256(receipt, "receipt_id");
	},
);

export const backfillResultCodec = codec<BackfillJobResultWire>(
	validateBackfillResult,
	(result) => {
		assertDocumentSha256(result, "result_sha256");
		const startedAt = fixedTimestampMs(result.started_at, "started_at");
		const completedAt = fixedTimestampMs(result.completed_at, "completed_at");
		if (completedAt < startedAt)
			throw new Error("completed_at precedes started_at");
		if (result.outcome.selection)
			archiveSelectionCodec.decode(result.outcome.selection);
		if (result.outcome.receipt)
			promotionReceiptCodec.decode(result.outcome.receipt);
		if (
			result.outcome.status === "promoted" &&
			(!result.outcome.selection || !result.outcome.receipt)
		) {
			throw new Error("promoted outcome requires selection and receipt");
		}
		if (
			result.outcome.status === "already_covered" &&
			!result.outcome.selection
		) {
			throw new Error("already_covered outcome requires selection");
		}
	},
);

function wireIdempotencyBusinessFields(
	request: Omit<BackfillRequestWire, "idempotency_key"> & {
		idempotency_key?: string;
	},
) {
	return {
		scope: request.scope,
		window: request.window,
		depth: request.depth,
		construction_mode: request.construction_mode,
		required_clock_sha256: request.required_clock.clock_sha256,
		coverage_policy: request.coverage_policy,
		source_policy: request.source_policy,
		expected_canonical_schema: request.expected_canonical_schema,
		target: request.target,
	};
}

export const backfillRequestCodec = {
	decode(value: unknown): { wire: BackfillRequestWire } {
		if (!validateBackfillRequest(value)) {
			throw new Error(
				`JSON Schema validation failed: ${describeAjvErrors(validateBackfillRequest.errors)}`,
			);
		}
		const request = value as BackfillRequestWire;
		archiveSelectionCodec.decode(request.initial_selection);
		assertIncreasingInterval(request.window, "window");
		if (request.idempotency_key !== createBackfillIdempotencyKey(request)) {
			throw new Error(
				"idempotency_key does not match canonical business fields",
			);
		}
		const capabilityPolicyMatches = [
			CAPABILITY_POLICY,
			PREVIOUS_CAPABILITY_POLICY,
			LEGACY_CAPABILITY_POLICY,
		].some(
			(policy) =>
				request.product_pins.capability_policy.policy_id === policy.policy_id &&
				request.product_pins.capability_policy.policy_sha256 ===
					policy.policy_sha256,
		);
		const resourcePolicyMatches = [
			RESOURCE_POLICY,
			LEGACY_RESOURCE_POLICY,
		].some(
			(policy) =>
				request.product_pins.resource_policy.policy_id === policy.policy_id &&
				request.product_pins.resource_policy.policy_sha256 ===
					policy.policy_sha256,
		);
		if (!capabilityPolicyMatches || !resourcePolicyMatches) {
			throw new Error(
				"request policy pins do not match the effective package policies",
			);
		}
		if (
			request.required_clock.clock_id !==
				request.initial_selection.required_clock.clock_id ||
			request.required_clock.clock_sha256 !==
				request.initial_selection.required_clock.clock_sha256 ||
			request.required_clock.event_count !==
				request.initial_selection.required_clock.event_count
		) {
			throw new Error(
				"initial selection required clock reference does not match request",
			);
		}
		if (
			jcsSha256(request.scope) !== jcsSha256(request.initial_selection.scope)
		) {
			throw new Error("initial selection scope does not match request");
		}
		if (
			jcsSha256(request.coverage_policy) !==
			jcsSha256(request.initial_selection.coverage_policy)
		) {
			throw new Error(
				"initial selection coverage policy does not match request",
			);
		}
		if (request.source_policy !== request.initial_selection.source_policy) {
			throw new Error("initial selection source policy does not match request");
		}
		return { wire: request };
	},
	is(value: unknown): value is BackfillRequestWire {
		try {
			this.decode(value);
			return true;
		} catch {
			return false;
		}
	},
};

export function finalizeRequiredClock(
	clock: Omit<RequiredClockWire, "clock_sha256">,
): RequiredClockWire {
	return requiredClockCodec.decode({
		...clock,
		clock_sha256: documentSha256(clock, "clock_sha256"),
	});
}

export function finalizeArchiveSelection(
	selection: Omit<ArchiveSelectionWire, "selection_sha256">,
): ArchiveSelectionWire {
	return archiveSelectionCodec.decode({
		...selection,
		selection_sha256: documentSha256(selection, "selection_sha256"),
	});
}

export function finalizeBackfillResult(
	result: Omit<BackfillJobResultWire, "result_sha256"> &
		Partial<Pick<BackfillJobResultWire, "result_sha256">>,
): BackfillJobResultWire {
	const { result_sha256: _resultSha256, ...content } = result;
	return backfillResultCodec.decode({
		...content,
		result_sha256: documentSha256(content, "result_sha256"),
	});
}

export const BACKFILL_REQUEST_SCHEMA_VERSION =
	"market-data-vendor-backfill-request/v1" as const;
export const BACKFILL_RESULT_SCHEMA_VERSION =
	"market-data-vendor-backfill-result/v1" as const;
export const BACKFILL_PROMOTION_SCHEMA_VERSION =
	"market-data-vendor-backfill-promotion-receipt/v1" as const;
export const EXTERNAL_BACKFILL_SOURCE = "external_backfill" as const;
export const HISTORICAL_VENDOR_SOURCE_MODE =
	"vendor_historical_backfill_v1" as const;
export const VENDOR_DATASET_RAW_CAPTURE_SCOPE =
	"vendor_normalized_dataset_file" as const;

const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestampMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const backfillRequestSchema = z
	.object({
		schemaVersion: z.literal(BACKFILL_REQUEST_SCHEMA_VERSION),
		requestId: nonEmpty,
		idempotencyKey: sha256,
		providerPolicy: z
			.object({
				provider: z.literal("cryptohftdata"),
				allowedAdapterVersions: z.array(nonEmpty).min(1).max(16),
			})
			.strict(),
		scope: z
			.object({
				exchange: nonEmpty,
				tradingPair: nonEmpty,
				sourceSymbol: nonEmpty,
				marketType: z.enum(["spot", "swap", "future"]),
				feed: z.literal("ORDERBOOK"),
			})
			.strict(),
		window: z
			.object({ startTimeMs: timestampMs, endTimeMs: timestampMs })
			.strict()
			.refine(({ startTimeMs, endTimeMs }) => endTimeMs > startTimeMs, {
				message: "endTimeMs must be greater than startTimeMs",
			}),
		depth: z.number().int().min(1).max(500),
		constructionMode: z.enum([
			"sampled_top_n_snapshot",
			"exact_l2_reconstruction",
		]),
		requiredClockTargetsMs: z.array(timestampMs).min(1).max(100_000),
		maxPriorAsOfLagMs: z.number().int().nonnegative().max(86_400_000),
		sourcePolicy: z.enum(["authoritative_window", "fill_gaps"]),
		budgets: z
			.object({
				maxFiles: z.number().int().min(1).max(10_000),
				maxBytes: z
					.number()
					.int()
					.min(1)
					.max(100 * 1024 * 1024 * 1024),
				maxRows: z.number().int().min(1).max(1_000_000_000),
				maxDurationMs: z
					.number()
					.int()
					.min(1)
					.max(24 * 60 * 60 * 1_000),
				maxBoundaryLookbackMs: z
					.number()
					.int()
					.nonnegative()
					.max(7 * 24 * 60 * 60 * 1_000),
			})
			.strict(),
		expectedProduct: z
			.object({
				packageName: z.literal("@usherlabs/cex-broker"),
				packageVersion: nonEmpty.optional(),
				canonicalSchemaVersion: nonEmpty,
				checksumAlgorithm: z.literal("sha256-canonical-json-v1"),
			})
			.strict(),
	})
	.strict()
	.superRefine((request, context) => {
		const targets = request.requiredClockTargetsMs;
		for (let index = 0; index < targets.length; index += 1) {
			const target = targets[index] as number;
			if (
				target < request.window.startTimeMs ||
				target >= request.window.endTimeMs
			) {
				context.addIssue({
					code: "custom",
					path: ["requiredClockTargetsMs", index],
					message: "clock target must be inside the half-open request window",
				});
			}
			if (index > 0 && target <= (targets[index - 1] as number)) {
				context.addIssue({
					code: "custom",
					path: ["requiredClockTargetsMs", index],
					message: "clock targets must be strictly increasing",
				});
			}
		}
	});

type ProvisionalBackfillDomainRequest = z.infer<typeof backfillRequestSchema>;

export type MarketDataVendorBackfillRequest =
	ProvisionalBackfillDomainRequest & {
		attemptId?: string;
		target?: { environment: string; cluster: string };
		coveragePolicy?: CoveragePolicyWire;
		requiredClock?: RequiredClockWire;
		initialSelection?: ArchiveSelectionWire;
		expectedCanonicalSchema?: BackfillRequestWire["expected_canonical_schema"];
		productPins?: BackfillRequestWire["product_pins"];
		productionAuthorizationId?: string;
		wire?: BackfillRequestWire;
	};

export function decodeBackfillRunDocuments(input: {
	request: unknown;
	requiredClock: unknown;
}): MarketDataVendorBackfillRequest {
	const { wire } = backfillRequestCodec.decode(input.request);
	const requiredClock = requiredClockCodec.decode(input.requiredClock);
	if (
		requiredClock.clock_id !== wire.required_clock.clock_id ||
		requiredClock.clock_sha256 !== wire.required_clock.clock_sha256 ||
		requiredClock.targets.length !== wire.required_clock.event_count
	) {
		throw new Error("required clock sidecar does not match request reference");
	}
	const startTimeMs = fixedTimestampMs(wire.window.start_at, "window.start_at");
	const endTimeMs = fixedTimestampMs(wire.window.end_at, "window.end_at");
	const requiredClockTargetsMs = requiredClock.targets.map((target, index) => {
		const targetTimeMs = fixedTimestampMs(
			target.target_at,
			`required_clock.targets[${index}].target_at`,
		);
		if (targetTimeMs < startTimeMs || targetTimeMs >= endTimeMs) {
			throw new Error("required clock target is outside request window");
		}
		return targetTimeMs;
	});
	const capabilityPolicy = [
		CAPABILITY_POLICY,
		PREVIOUS_CAPABILITY_POLICY,
		LEGACY_CAPABILITY_POLICY,
	].find(
		(policy) =>
			wire.product_pins.capability_policy.policy_id === policy.policy_id &&
			wire.product_pins.capability_policy.policy_sha256 ===
				policy.policy_sha256,
	);
	if (!capabilityPolicy) {
		throw new Error("request capability policy pin is unsupported");
	}
	const capabilityProfile = capabilityPolicy.profiles.find(
		(profile) =>
			profile.exchange === wire.scope.exchange &&
			profile.market_type === wire.scope.market_type &&
			profile.feed === wire.scope.feed &&
			profile.canonical_trading_pair === wire.scope.trading_pair,
	);
	const resourcePolicy = [RESOURCE_POLICY, LEGACY_RESOURCE_POLICY].find(
		(policy) =>
			wire.product_pins.resource_policy.policy_id === policy.policy_id &&
			wire.product_pins.resource_policy.policy_sha256 === policy.policy_sha256,
	);
	if (!resourcePolicy) {
		throw new Error("request resource policy pin is unsupported");
	}
	return {
		schemaVersion: BACKFILL_REQUEST_SCHEMA_VERSION,
		requestId: wire.request_id,
		idempotencyKey: wire.idempotency_key,
		providerPolicy: {
			provider: "cryptohftdata",
			allowedAdapterVersions: [capabilityPolicy.adapter_policy.adapter_version],
		},
		scope: {
			exchange: wire.scope.exchange,
			tradingPair: wire.scope.trading_pair,
			sourceSymbol:
				capabilityProfile?.resolved_symbol ?? wire.scope.trading_pair,
			marketType: wire.scope.market_type,
			feed: wire.scope.feed,
		},
		window: { startTimeMs, endTimeMs },
		depth: wire.depth,
		constructionMode: wire.construction_mode,
		requiredClockTargetsMs,
		maxPriorAsOfLagMs: wire.coverage_policy.max_asof_lag_ms,
		sourcePolicy: wire.source_policy,
		budgets: {
			maxFiles: resourcePolicy.limits.max_files,
			maxBytes: resourcePolicy.limits.max_bytes,
			maxRows: resourcePolicy.limits.max_rows,
			maxDurationMs: resourcePolicy.limits.max_duration_ms,
			maxBoundaryLookbackMs: Math.min(
				resourcePolicy.limits.max_boundary_lookback_ms,
				capabilityPolicy.acquisition_policy.initialization_lookback_ms,
			),
		},
		expectedProduct: {
			packageName: "@usherlabs/cex-broker",
			canonicalSchemaVersion: "1.0.0",
			checksumAlgorithm: "sha256-canonical-json-v1",
		},
		attemptId: wire.attempt_id,
		target: wire.target,
		coveragePolicy: wire.coverage_policy,
		requiredClock,
		initialSelection: wire.initial_selection,
		expectedCanonicalSchema: wire.expected_canonical_schema,
		productPins: wire.product_pins,
		productionAuthorizationId: wire.production_authorization_id,
		wire,
	};
}

type IdempotencyBusinessFields = Omit<
	MarketDataVendorBackfillRequest,
	"requestId" | "idempotencyKey"
>;

export function backfillBusinessFields(
	request: Omit<MarketDataVendorBackfillRequest, "idempotencyKey"> & {
		idempotencyKey?: string;
	},
): IdempotencyBusinessFields {
	const {
		requestId: _requestId,
		idempotencyKey: _idempotencyKey,
		...business
	} = request;
	return business;
}

export function createBackfillIdempotencyKey(
	request: Omit<MarketDataVendorBackfillRequest, "idempotencyKey"> & {
		idempotencyKey?: string;
	},
): string;
export function createBackfillIdempotencyKey(
	request: Omit<BackfillRequestWire, "idempotency_key"> & {
		idempotency_key?: string;
	},
): string;
export function createBackfillIdempotencyKey(
	request: Record<string, unknown>,
): string;
export function createBackfillIdempotencyKey(request: unknown): string {
	if (!request || typeof request !== "object") {
		throw new TypeError("backfill request must be an object");
	}
	if ("schema_id" in request) {
		return jcsSha256(
			wireIdempotencyBusinessFields(
				request as Omit<BackfillRequestWire, "idempotency_key"> & {
					idempotency_key?: string;
				},
			),
		);
	}
	return sha256Canonical(
		backfillBusinessFields(
			request as Omit<MarketDataVendorBackfillRequest, "idempotencyKey"> & {
				idempotencyKey?: string;
			},
		),
	);
}

export function parseBackfillRequest(
	value: unknown,
): MarketDataVendorBackfillRequest {
	const request = backfillRequestSchema.parse(value);
	if (createBackfillIdempotencyKey(request) !== request.idempotencyKey) {
		throw new Error("idempotencyKey does not match canonical business fields");
	}
	return request;
}

export const BACKFILL_STATUSES = [
	"already_covered",
	"promoted",
	"capability_unsupported",
	"credentials_missing",
	"vendor_fetch_failed",
	"archive_ingest_failed",
	"promotion_verification_failed",
	"post_backfill_coverage_insufficient",
] as const;

export type BackfillStatus = (typeof BACKFILL_STATUSES)[number];

export type ProviderCapability = {
	provider: "cryptohftdata";
	adapterVersion: string;
	providerExchangeId: string;
	resolvedSymbol: string;
};

export type ProviderObjectEvidence = {
	identity: string;
	checksum: string;
	bytes: number;
	rows: number;
};

const providerObjectEvidenceSchema = z
	.object({
		identity: nonEmpty,
		checksum: sha256,
		bytes: z.number().int().nonnegative(),
		rows: z.number().int().nonnegative(),
	})
	.strict();

export type BackfillArchiveRow = {
	table:
		| "market_data.cex_order_book_levels"
		| "market_data.cex_order_book_depth_summary"
		| "market_data.cex_order_book_capture_promotions"
		| "market_data.cex_order_book_capture_qualifications"
		| "market_data.cex_order_book_archive_selections";
	row: Record<string, unknown>;
};

export type ForwarderBatch = {
	source: typeof EXTERNAL_BACKFILL_SOURCE;
	deployment_id: string;
	batch_id: string;
	rows: BackfillArchiveRow[];
};

export type PromotionReceipt = {
	schemaVersion: typeof BACKFILL_PROMOTION_SCHEMA_VERSION;
	receiptId: string;
	requestId: string;
	idempotencyKey: string;
	status: "passing";
	source: typeof EXTERNAL_BACKFILL_SOURCE;
	provider: "cryptohftdata";
	adapterVersion: string;
	captureBundleId: string;
	exchange: string;
	tradingPair: string;
	marketType: "spot" | "swap" | "future";
	feed: "ORDERBOOK";
	startTimeMs: number;
	endTimeMs: number;
	depth: number;
	constructionMode: "sampled_top_n_snapshot" | "exact_l2_reconstruction";
	canonicalSchemaVersion: string;
	checksumAlgorithm: "sha256-canonical-json-v1";
	vendorSemanticDigest: string;
	canonicalSemanticDigest: string;
	prefixDigest: string;
	suffixDigest: string;
	seamVerified: true;
	coverageVerified: true;
	datasetObjects: ProviderObjectEvidence[];
	verificationTimeMs: number;
};

export const promotionReceiptSchema: z.ZodType<PromotionReceipt> = z
	.object({
		schemaVersion: z.literal(BACKFILL_PROMOTION_SCHEMA_VERSION),
		receiptId: sha256,
		requestId: nonEmpty,
		idempotencyKey: sha256,
		status: z.literal("passing"),
		source: z.literal(EXTERNAL_BACKFILL_SOURCE),
		provider: z.literal("cryptohftdata"),
		adapterVersion: nonEmpty,
		captureBundleId: sha256,
		exchange: nonEmpty,
		tradingPair: nonEmpty,
		marketType: z.enum(["spot", "swap", "future"]),
		feed: z.literal("ORDERBOOK"),
		startTimeMs: timestampMs,
		endTimeMs: timestampMs,
		depth: z.number().int().min(1).max(500),
		constructionMode: z.enum([
			"sampled_top_n_snapshot",
			"exact_l2_reconstruction",
		]),
		canonicalSchemaVersion: nonEmpty,
		checksumAlgorithm: z.literal("sha256-canonical-json-v1"),
		vendorSemanticDigest: sha256,
		canonicalSemanticDigest: sha256,
		prefixDigest: sha256,
		suffixDigest: sha256,
		seamVerified: z.literal(true),
		coverageVerified: z.literal(true),
		datasetObjects: z.array(providerObjectEvidenceSchema).min(1).max(10_000),
		verificationTimeMs: timestampMs,
	})
	.strict()
	.refine(({ endTimeMs, startTimeMs }) => endTimeMs > startTimeMs, {
		message: "promotion window must be increasing",
	});

export type BackfillResult = {
	schemaVersion: typeof BACKFILL_RESULT_SCHEMA_VERSION;
	requestId: string;
	idempotencyKey?: string;
	status: BackfillStatus;
	reasonCode: string;
	receipt?: PromotionReceipt;
	diagnostics?: Record<string, string | number | boolean>;
};
