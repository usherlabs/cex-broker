import { createHash } from "node:crypto";
import { decompress } from "fzstd";
import { parquetReadObjects } from "hyparquet";
import { buildCanonicalOrderBookRows } from "../market-data-archive/canonical-orderbook";
import {
	CHECKSUM_ALGORITHM,
	canonicalSerialize,
	MARKET_CAPTURE_SCHEMA_VERSION,
	sha256Canonical,
} from "../market-data-archive/capture-contract";
import type {
	MarketCaptureContext,
	RawCapture,
} from "../market-data-archive/types";
import {
	type BackfillArchiveRow,
	EXTERNAL_BACKFILL_SOURCE,
	HISTORICAL_VENDOR_SOURCE_MODE,
	type MarketDataVendorBackfillRequest,
	type ProviderCapability,
	type ProviderObjectEvidence,
	VENDOR_DATASET_RAW_CAPTURE_SCOPE,
} from "./contracts";
import type { NormalizedBackfill, ProviderDataset } from "./core";
import { semanticDigest } from "./semantic-verification";

export const CRYPTOHFTDATA_ADAPTER_VERSION =
	"cryptohftdata-orderbook/v2" as const;
export const CRYPTOHFTDATA_API_URL = "https://api.cryptohftdata.com" as const;
const CRYPTOHFTDATA_HISTORY_START_MS = Date.UTC(2025, 5, 28);
const HOUR_MS = 60 * 60 * 1_000;

export type CryptoHftDataCapabilityProfile = Readonly<{
	profileId: string;
	exchange: string;
	tradingPair: string;
	sourceSymbol: string;
	marketType: "spot" | "swap" | "future";
	providerExchangeId: string;
	historyStartMs: number;
	maxDepth: number;
	eventTimeUnit: "milliseconds";
	receivedTimeUnit: "nanoseconds";
	snapshotGrouping:
		| "event_time_last_update_id_object"
		| "event_time_final_update_id_object";
	sequenceSemantics: "binance_u_U_pu" | "okx_seq_id_prev_seq_id";
	constructionModes: readonly ["sampled_top_n_snapshot"];
	sourcePolicies: readonly ("authoritative_window" | "fill_gaps")[];
}>;

// This profile is exported for explicit enablement by a conformance-tested
// consumer. The adapter's default registry is deliberately empty: possession
// of a provider credential must never advertise an unverified data profile.
export const CRYPTOHFTDATA_BINANCE_SPOT_BTCUSDT_PROFILE: CryptoHftDataCapabilityProfile =
	Object.freeze({
		profileId: "cryptohftdata/binance_spot/BTCUSDT/v1",
		exchange: "binance",
		tradingPair: "BTC-USDT",
		sourceSymbol: "BTCUSDT",
		marketType: "spot",
		providerExchangeId: "binance_spot",
		historyStartMs: CRYPTOHFTDATA_HISTORY_START_MS,
		maxDepth: 500,
		eventTimeUnit: "milliseconds",
		receivedTimeUnit: "nanoseconds",
		snapshotGrouping: "event_time_last_update_id_object",
		sequenceSemantics: "binance_u_U_pu",
		constructionModes: ["sampled_top_n_snapshot"] as const,
		sourcePolicies: ["authoritative_window"] as const,
	});

// This profile is pinned to a live-proven object containing a complete OKX
// snapshot followed by a contiguous seqId/prevSeqId update chain.
export const CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE: CryptoHftDataCapabilityProfile =
	Object.freeze({
		profileId: "cryptohftdata/okx_spot/ARB-USDT/v1",
		exchange: "okx",
		tradingPair: "ARB-USDT",
		sourceSymbol: "ARB-USDT",
		marketType: "spot",
		providerExchangeId: "okx_spot",
		historyStartMs: CRYPTOHFTDATA_HISTORY_START_MS,
		maxDepth: 400,
		eventTimeUnit: "milliseconds",
		receivedTimeUnit: "nanoseconds",
		snapshotGrouping: "event_time_final_update_id_object",
		sequenceSemantics: "okx_seq_id_prev_seq_id",
		constructionModes: ["sampled_top_n_snapshot"] as const,
		sourcePolicies: ["authoritative_window", "fill_gaps"] as const,
	});

// This profile uses the same live-proven OKX sequence and timestamp semantics
// as ARB-USDT. Provider discovery and conformance evidence pin ARB-USDC as a
// distinct source symbol; venue identity must never imply quote substitution.
export const CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE: CryptoHftDataCapabilityProfile =
	Object.freeze({
		profileId: "cryptohftdata/okx_spot/ARB-USDC/v1",
		exchange: "okx",
		tradingPair: "ARB-USDC",
		sourceSymbol: "ARB-USDC",
		marketType: "spot",
		providerExchangeId: "okx_spot",
		historyStartMs: CRYPTOHFTDATA_HISTORY_START_MS,
		maxDepth: 400,
		eventTimeUnit: "milliseconds",
		receivedTimeUnit: "nanoseconds",
		snapshotGrouping: "event_time_final_update_id_object",
		sequenceSemantics: "okx_seq_id_prev_seq_id",
		constructionModes: ["sampled_top_n_snapshot"] as const,
		sourcePolicies: ["authoritative_window", "fill_gaps"] as const,
	});

export class CryptoHftDataError extends Error {
	constructor(
		readonly reason: string,
		readonly diagnostics: Readonly<
			Record<string, string | number | boolean>
		> = {},
	) {
		super(`CryptoHFTData backfill failed: ${reason}`);
		this.name = "CryptoHftDataError";
	}
}

export type CryptoHftDataOrderBookRow = {
	received_time: string | number | bigint;
	event_time: string | number | bigint;
	transaction_time?: string | number | bigint | null;
	symbol: string;
	event_type: "snapshot" | "update";
	first_update_id?: string | number | bigint | null;
	final_update_id?: string | number | bigint | null;
	prev_final_update_id?: string | number | bigint | null;
	last_update_id?: string | number | bigint | null;
	side: "bid" | "ask";
	price: string;
	quantity: string;
	order_count?: string | number | bigint | null;
	dataset_object_identity: string;
	dataset_object_checksum: string;
};

export type ReconstructedCryptoHftBook = {
	targetTimeMs: number;
	sourceTimeMs: number;
	receivedTimeMs: number;
	sequence: string;
	bids: number[][];
	asks: number[][];
	datasetObjectIdentity: string;
	datasetObjectChecksum: string;
};

export function cryptoHftDataCapabilityFor(
	request: MarketDataVendorBackfillRequest,
	profiles: readonly CryptoHftDataCapabilityProfile[] = [],
): ProviderCapability | undefined {
	if (
		request.providerPolicy.provider !== "cryptohftdata" ||
		request.scope.feed !== "ORDERBOOK" ||
		request.scope.exchange.trim().toLowerCase() === "mexc"
	) {
		return undefined;
	}
	const profile = profiles.find(
		(candidate) =>
			candidate.exchange === request.scope.exchange.trim().toLowerCase() &&
			candidate.tradingPair === request.scope.tradingPair &&
			candidate.sourceSymbol === request.scope.sourceSymbol &&
			candidate.marketType === request.scope.marketType &&
			candidate.constructionModes.includes(request.constructionMode as never) &&
			candidate.sourcePolicies.includes(request.sourcePolicy as never) &&
			request.window.startTimeMs >= candidate.historyStartMs &&
			request.depth <= candidate.maxDepth,
	);
	if (!profile) return undefined;
	return {
		provider: "cryptohftdata",
		adapterVersion: CRYPTOHFTDATA_ADAPTER_VERSION,
		providerExchangeId: profile.providerExchangeId,
		resolvedSymbol: profile.sourceSymbol,
	};
}

function utcHourPath(hourMs: number): { date: string; hour: string } {
	const date = new Date(hourMs);
	return {
		date: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
		hour: String(date.getUTCHours()).padStart(2, "0"),
	};
}

export function enumerateCryptoHftDataObjects(
	request: MarketDataVendorBackfillRequest,
	providerExchangeId: string,
	resolvedSymbol: string,
): string[] {
	if (request.sourcePolicy === "fill_gaps") {
		const hours = new Set<number>();
		for (const targetTimeMs of request.requiredClockTargetsMs) {
			const firstHour =
				Math.floor(
					Math.max(0, targetTimeMs - request.budgets.maxBoundaryLookbackMs) /
						HOUR_MS,
				) * HOUR_MS;
			const lastHour = Math.floor(targetTimeMs / HOUR_MS) * HOUR_MS;
			for (let hourMs = firstHour; hourMs <= lastHour; hourMs += HOUR_MS) {
				hours.add(hourMs);
			}
		}
		return [...hours]
			.sort((left, right) => left - right)
			.map((hourMs) => {
				const utc = utcHourPath(hourMs);
				return `${providerExchangeId}/${utc.date}/${utc.hour}/${resolvedSymbol}_orderbook.parquet.zst`;
			});
	}
	const firstHour =
		Math.floor(
			(request.window.startTimeMs - request.budgets.maxBoundaryLookbackMs) /
				HOUR_MS,
		) * HOUR_MS;
	const objects: string[] = [];
	for (
		let hourMs = Math.max(0, firstHour);
		hourMs < request.window.endTimeMs;
		hourMs += HOUR_MS
	) {
		const utc = utcHourPath(hourMs);
		objects.push(
			`${providerExchangeId}/${utc.date}/${utc.hour}/${resolvedSymbol}_orderbook.parquet.zst`,
		);
	}
	return objects;
}

function initialArchiveCoversTarget(
	request: MarketDataVendorBackfillRequest,
	targetTimeMs: number,
): boolean {
	return (request.initialSelection?.support_anchors ?? []).some((anchor) => {
		const sourceTimeMs = Date.parse(anchor.source_time);
		return (
			Number.isSafeInteger(sourceTimeMs) &&
			sourceTimeMs <= targetTimeMs &&
			targetTimeMs - sourceTimeMs <= request.maxPriorAsOfLagMs
		);
	});
}

export function providerAcquisitionRequest(
	request: MarketDataVendorBackfillRequest,
): MarketDataVendorBackfillRequest {
	if (request.sourcePolicy !== "fill_gaps") return request;
	const requiredClockTargetsMs = request.requiredClockTargetsMs.filter(
		(targetTimeMs) => !initialArchiveCoversTarget(request, targetTimeMs),
	);
	if (requiredClockTargetsMs.length === 0) {
		throw new CryptoHftDataError("fill_gaps_has_no_uncovered_clock_targets");
	}
	return { ...request, requiredClockTargetsMs };
}

function unsignedString(
	value: string | number | bigint | null | undefined,
	field: string,
	required = false,
): string | undefined {
	if (value === null || value === undefined) {
		if (required) throw new CryptoHftDataError(`schema_${field}_missing`);
		return undefined;
	}
	const rendered = String(value);
	if (!/^\d+$/.test(rendered)) {
		throw new CryptoHftDataError(`schema_${field}_invalid`);
	}
	const parsed = BigInt(rendered);
	if (parsed > 18_446_744_073_709_551_615n) {
		throw new CryptoHftDataError(`schema_${field}_exceeds_uint64`);
	}
	return parsed.toString(10);
}

function timestampMs(
	value: string | number | bigint,
	field: "received_time" | "event_time",
): number {
	const rendered = String(value);
	if (!/^\d+$/.test(rendered)) {
		throw new CryptoHftDataError(`schema_${field}_invalid`);
	}
	const raw = BigInt(rendered);
	const milliseconds = field === "received_time" ? raw / 1_000_000n : raw;
	if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new CryptoHftDataError(`schema_${field}_unsafe`);
	}
	return Number(milliseconds);
}

function decimal(value: string, field: string, allowZero: boolean): number {
	if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
		throw new CryptoHftDataError(`schema_${field}_invalid`);
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
		throw new CryptoHftDataError(`schema_${field}_invalid`);
	}
	return parsed;
}

function validatedRow(
	request: MarketDataVendorBackfillRequest,
	row: CryptoHftDataOrderBookRow,
): CryptoHftDataOrderBookRow & {
	eventTimeMs: number;
	receivedTimeMs: number;
} {
	if (row.symbol !== request.scope.sourceSymbol) {
		throw new CryptoHftDataError("schema_symbol_mismatch");
	}
	if (row.event_type !== "snapshot" && row.event_type !== "update") {
		throw new CryptoHftDataError("schema_event_type_invalid");
	}
	if (row.side !== "bid" && row.side !== "ask") {
		throw new CryptoHftDataError("schema_side_invalid");
	}
	decimal(row.price, "price", false);
	decimal(row.quantity, "quantity", true);
	if (!/^[a-f0-9]{64}$/.test(row.dataset_object_checksum)) {
		throw new CryptoHftDataError("schema_object_checksum_invalid");
	}
	const eventTimeMs = timestampMs(row.event_time, "event_time");
	const receivedTimeMs = timestampMs(row.received_time, "received_time");
	if (receivedTimeMs < eventTimeMs) {
		throw new CryptoHftDataError("received_time_precedes_event_time");
	}
	return { ...row, eventTimeMs, receivedTimeMs };
}

function groupKey(
	row: ReturnType<typeof validatedRow>,
	profile: CryptoHftDataCapabilityProfile,
): string {
	const sequence =
		row.event_type === "snapshot"
			? profile.snapshotGrouping === "event_time_final_update_id_object"
				? unsignedString(row.final_update_id, "final_update_id", true)
				: unsignedString(row.last_update_id, "last_update_id", true)
			: unsignedString(row.final_update_id, "final_update_id", true);
	return [
		row.event_type,
		row.eventTimeMs,
		sequence,
		row.dataset_object_identity,
	].join("\u0000");
}

function absent(value: string | number | bigint | null | undefined): boolean {
	return value === null || value === undefined;
}

function snapshotSequence(
	row: ReturnType<typeof validatedRow>,
	profile: CryptoHftDataCapabilityProfile,
): string {
	if (profile.sequenceSemantics === "okx_seq_id_prev_seq_id") {
		if (String(row.last_update_id) !== "-1") {
			throw new CryptoHftDataError("schema_last_update_id_snapshot_sentinel");
		}
		if (!absent(row.first_update_id) || !absent(row.prev_final_update_id)) {
			throw new CryptoHftDataError("ambiguous_snapshot_group");
		}
		return unsignedString(
			row.final_update_id,
			"final_update_id",
			true,
		) as string;
	}
	return unsignedString(row.last_update_id, "last_update_id", true) as string;
}

type BookState = {
	bids: Map<string, number>;
	asks: Map<string, number>;
	sequence: string;
	sourceTimeMs: number;
	receivedTimeMs: number;
	datasetObjectIdentity: string;
	datasetObjectChecksum: string;
};

function sortedSide(
	levels: ReadonlyMap<string, number>,
	side: "bid" | "ask",
): number[][] {
	return [...levels.entries()]
		.map(([price, quantity]) => [Number(price), quantity])
		.sort((left, right) =>
			side === "bid"
				? (right[0] as number) - (left[0] as number)
				: (left[0] as number) - (right[0] as number),
		);
}

function applyRows(
	state: BookState,
	rows: ReturnType<typeof validatedRow>[],
): void {
	for (const row of rows) {
		const levels = row.side === "bid" ? state.bids : state.asks;
		const quantity = decimal(row.quantity, "quantity", true);
		if (quantity === 0) levels.delete(row.price);
		else levels.set(row.price, quantity);
	}
}

class StreamingBookReconstructor {
	private readonly targets: readonly number[];
	private readonly samples: ReconstructedCryptoHftBook[] = [];
	private readonly missingSamples: Array<{
		targetTimeMs: number;
		sourceTimeMs?: number;
		asofLagMs?: number;
	}> = [];
	private targetIndex = 0;
	private state: BookState | undefined;
	private previousFinalUpdateId: bigint | undefined;

	constructor(
		private readonly request: MarketDataVendorBackfillRequest,
		private readonly profile: CryptoHftDataCapabilityProfile,
	) {
		this.targets = [...request.requiredClockTargetsMs];
	}

	push(inputRows: readonly CryptoHftDataOrderBookRow[]): void {
		const rows = inputRows
			.map((row, index) => ({
				...validatedRow(this.request, row),
				originalIndex: index,
			}))
			.sort(
				(left, right) =>
					left.eventTimeMs - right.eventTimeMs ||
					left.originalIndex - right.originalIndex,
			);
		const groups: Array<ReturnType<typeof validatedRow>[]> = [];
		for (const row of rows) {
			const current = groups.at(-1);
			if (
				!current ||
				groupKey(
					current[0] as ReturnType<typeof validatedRow>,
					this.profile,
				) !== groupKey(row, this.profile)
			) {
				groups.push([row]);
			} else {
				current.push(row);
			}
		}
		for (const group of groups) {
			const first = group[0] as ReturnType<typeof validatedRow>;
			this.sampleBefore(first.eventTimeMs);
			if (this.targetIndex >= this.targets.length) return;
			if (first.event_type === "snapshot") this.applySnapshot(group);
			else if (this.state) this.applyUpdate(group);
		}
	}

	finish(): ReconstructedCryptoHftBook[] {
		this.sampleBefore(Number.POSITIVE_INFINITY);
		if (this.missingSamples.length > 0) {
			throw new CryptoHftDataError(
				this.missingSamples.some((sample) => sample.asofLagMs !== undefined)
					? "required_clock_coverage_insufficient"
					: "update_before_snapshot",
				this.missingClockDiagnostics(),
			);
		}
		return this.samples;
	}

	private missingClockDiagnostics(): Record<string, string | number | boolean> {
		if (this.missingSamples.length === 0) return {};
		const first = this
			.missingSamples[0] as (typeof this.missingSamples)[number];
		const last = this.missingSamples.at(
			-1,
		) as (typeof this.missingSamples)[number];
		const observedLags = this.missingSamples.flatMap((sample) =>
			sample.asofLagMs === undefined ? [] : [sample.asofLagMs],
		);
		const missingDates = [
			...new Set(
				this.missingSamples.map((sample) =>
					new Date(sample.targetTimeMs).toISOString().slice(0, 10),
				),
			),
		].join(",");
		return {
			target_time_ms: first.targetTimeMs,
			...(first.sourceTimeMs === undefined
				? {}
				: { source_time_ms: first.sourceTimeMs }),
			...(first.asofLagMs === undefined
				? {}
				: { asof_lag_ms: first.asofLagMs }),
			max_prior_asof_lag_ms: this.request.maxPriorAsOfLagMs,
			missing_target_count: this.missingSamples.length,
			covered_target_count: this.samples.length,
			first_missing_target_time_ms: first.targetTimeMs,
			last_missing_target_time_ms: last.targetTimeMs,
			...(observedLags.length === 0
				? {}
				: { max_observed_asof_lag_ms: Math.max(...observedLags) }),
			missing_target_dates_utc: missingDates,
		};
	}

	private sampleBefore(nextEventTimeMs: number): void {
		while (
			this.targetIndex < this.targets.length &&
			(this.targets[this.targetIndex] as number) < nextEventTimeMs
		) {
			this.sample(this.targets[this.targetIndex] as number);
			this.targetIndex += 1;
		}
	}

	private sample(targetTimeMs: number): void {
		const state = this.state;
		if (
			!state ||
			state.sourceTimeMs > targetTimeMs ||
			targetTimeMs - state.sourceTimeMs > this.request.maxPriorAsOfLagMs
		) {
			this.missingSamples.push({
				targetTimeMs,
				...(state
					? {
							sourceTimeMs: state.sourceTimeMs,
							asofLagMs: Math.abs(targetTimeMs - state.sourceTimeMs),
						}
					: {}),
			});
			return;
		}
		const bids = sortedSide(state.bids, "bid").slice(0, this.request.depth);
		const asks = sortedSide(state.asks, "ask").slice(0, this.request.depth);
		if (bids.length === 0 || asks.length === 0) {
			throw new CryptoHftDataError("book_side_missing");
		}
		if ((bids[0]?.[0] as number) >= (asks[0]?.[0] as number)) {
			throw new CryptoHftDataError("book_crossed_or_locked");
		}
		this.samples.push({
			targetTimeMs,
			sourceTimeMs: state.sourceTimeMs,
			receivedTimeMs: state.receivedTimeMs,
			sequence: state.sequence,
			bids,
			asks,
			datasetObjectIdentity: state.datasetObjectIdentity,
			datasetObjectChecksum: state.datasetObjectChecksum,
		});
	}

	private applySnapshot(group: ReturnType<typeof validatedRow>[]): void {
		const first = group[0] as ReturnType<typeof validatedRow>;
		const sequence = snapshotSequence(first, this.profile);
		if (group.some((row) => snapshotSequence(row, this.profile) !== sequence)) {
			throw new CryptoHftDataError("ambiguous_snapshot_group");
		}
		if (
			this.profile.sequenceSemantics === "binance_u_U_pu" &&
			this.previousFinalUpdateId !== undefined &&
			BigInt(sequence) < this.previousFinalUpdateId
		) {
			throw new CryptoHftDataError("snapshot_sequence_regression");
		}
		this.state = {
			bids: new Map(),
			asks: new Map(),
			sequence,
			sourceTimeMs: first.eventTimeMs,
			receivedTimeMs: Math.max(...group.map((row) => row.receivedTimeMs)),
			datasetObjectIdentity: first.dataset_object_identity,
			datasetObjectChecksum: first.dataset_object_checksum,
		};
		applyRows(this.state, group);
		this.previousFinalUpdateId = BigInt(sequence);
	}

	private applyUpdate(group: ReturnType<typeof validatedRow>[]): void {
		const first = group[0] as ReturnType<typeof validatedRow>;
		const state = this.state as BookState;
		const previousFinalUpdateId = this.previousFinalUpdateId as bigint;
		const finalUpdate = BigInt(
			unsignedString(first.final_update_id, "final_update_id", true) as string,
		);
		if (this.profile.sequenceSemantics === "okx_seq_id_prev_seq_id") {
			if (
				!absent(first.first_update_id) ||
				!absent(first.prev_final_update_id)
			) {
				throw new CryptoHftDataError("ambiguous_update_group");
			}
			const previous = unsignedString(
				first.last_update_id,
				"last_update_id",
				true,
			) as string;
			if (
				group.some(
					(row) =>
						!absent(row.first_update_id) ||
						!absent(row.prev_final_update_id) ||
						unsignedString(row.final_update_id, "final_update_id", true) !==
							finalUpdate.toString() ||
						unsignedString(row.last_update_id, "last_update_id", true) !==
							previous,
				)
			) {
				throw new CryptoHftDataError("ambiguous_update_group");
			}
			if (BigInt(previous) !== previousFinalUpdateId) {
				throw new CryptoHftDataError("update_chain_gap", {
					event_time_ms: first.eventTimeMs,
					expected_previous_sequence: previousFinalUpdateId.toString(),
					observed_previous_sequence: previous,
					observed_final_sequence: finalUpdate.toString(),
					...this.missingClockDiagnostics(),
				});
			}
		} else {
			const firstUpdate = BigInt(
				unsignedString(
					first.first_update_id,
					"first_update_id",
					true,
				) as string,
			);
			const previous = unsignedString(
				first.prev_final_update_id,
				"prev_final_update_id",
			);
			if (
				group.some(
					(row) =>
						unsignedString(row.first_update_id, "first_update_id", true) !==
							firstUpdate.toString() ||
						unsignedString(row.final_update_id, "final_update_id", true) !==
							finalUpdate.toString() ||
						unsignedString(row.prev_final_update_id, "prev_final_update_id") !==
							previous,
				)
			) {
				throw new CryptoHftDataError("ambiguous_update_group");
			}
			const expected = previousFinalUpdateId + 1n;
			if (
				firstUpdate > expected ||
				finalUpdate < expected ||
				(previous !== undefined && BigInt(previous) !== previousFinalUpdateId)
			) {
				throw new CryptoHftDataError("update_chain_gap");
			}
		}
		applyRows(state, group);
		state.sequence = finalUpdate.toString();
		state.sourceTimeMs = first.eventTimeMs;
		state.receivedTimeMs = Math.max(...group.map((row) => row.receivedTimeMs));
		state.datasetObjectIdentity = first.dataset_object_identity;
		state.datasetObjectChecksum = first.dataset_object_checksum;
		this.previousFinalUpdateId = finalUpdate;
	}
}

export function reconstructCryptoHftDataOrderBooks(
	request: MarketDataVendorBackfillRequest,
	inputRows: readonly CryptoHftDataOrderBookRow[],
	profile: CryptoHftDataCapabilityProfile = CRYPTOHFTDATA_BINANCE_SPOT_BTCUSDT_PROFILE,
): ReconstructedCryptoHftBook[] {
	const reconstructor = new StreamingBookReconstructor(request, profile);
	reconstructor.push(inputRows);
	return reconstructor.finish();
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function decodeCryptoHftParquetZstd(
	bytes: Uint8Array,
): Promise<Record<string, unknown>[]> {
	const parquet = decompress(bytes);
	const buffer = parquet.buffer.slice(
		parquet.byteOffset,
		parquet.byteOffset + parquet.byteLength,
	) as ArrayBuffer;
	return parquetReadObjects({ file: buffer });
}

type CryptoHftDataAdapterOptions = {
	baseUrl?: string;
	fetch?: typeof fetch;
	nowMs?: () => number;
	decode?: (bytes: Uint8Array) => Promise<Record<string, unknown>[]>;
	profiles?: readonly CryptoHftDataCapabilityProfile[];
};

function parsedDatasetRow(
	value: Record<string, unknown>,
	object: ProviderObjectEvidence,
): CryptoHftDataOrderBookRow {
	return {
		received_time: value.received_time as string | number | bigint,
		event_time: value.event_time as string | number | bigint,
		transaction_time: value.transaction_time as
			| string
			| number
			| bigint
			| null
			| undefined,
		symbol: value.symbol as string,
		event_type: value.event_type as "snapshot" | "update",
		first_update_id: value.first_update_id as
			| string
			| number
			| bigint
			| null
			| undefined,
		final_update_id: value.final_update_id as
			| string
			| number
			| bigint
			| null
			| undefined,
		prev_final_update_id: value.prev_final_update_id as
			| string
			| number
			| bigint
			| null
			| undefined,
		last_update_id: value.last_update_id as
			| string
			| number
			| bigint
			| null
			| undefined,
		side: value.side as "bid" | "ask",
		price: value.price as string,
		quantity: value.quantity as string,
		order_count: value.order_count as
			| string
			| number
			| bigint
			| null
			| undefined,
		dataset_object_identity: object.identity,
		dataset_object_checksum: object.checksum,
	};
}

async function readBoundedObject(
	response: Response,
	remainingBytes: number,
): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > remainingBytes) {
			await reader.cancel();
			throw new CryptoHftDataError("budget_max_bytes_exceeded");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export class CryptoHftDataAdapter {
	private readonly baseUrl: string;
	private readonly request: typeof fetch;
	private readonly nowMs: () => number;
	private readonly decode: (
		bytes: Uint8Array,
	) => Promise<Record<string, unknown>[]>;
	private readonly profiles: readonly CryptoHftDataCapabilityProfile[];

	constructor(options: CryptoHftDataAdapterOptions = {}) {
		this.baseUrl = options.baseUrl ?? CRYPTOHFTDATA_API_URL;
		this.request = options.fetch ?? fetch;
		this.nowMs = options.nowMs ?? Date.now;
		this.decode = options.decode ?? decodeCryptoHftParquetZstd;
		this.profiles = options.profiles ?? [];
	}

	capabilityFor(
		request: MarketDataVendorBackfillRequest,
	): ProviderCapability | undefined {
		return cryptoHftDataCapabilityFor(request, this.profiles);
	}

	private findProfile(
		request: MarketDataVendorBackfillRequest,
		capability: ProviderCapability,
	): CryptoHftDataCapabilityProfile | undefined {
		return this.profiles.find(
			(candidate) =>
				candidate.exchange === request.scope.exchange.trim().toLowerCase() &&
				candidate.tradingPair === request.scope.tradingPair &&
				candidate.sourceSymbol === request.scope.sourceSymbol &&
				candidate.marketType === request.scope.marketType &&
				candidate.providerExchangeId === capability.providerExchangeId,
		);
	}

	private profileFor(
		request: MarketDataVendorBackfillRequest,
		capability: ProviderCapability,
	): CryptoHftDataCapabilityProfile {
		const profile = this.findProfile(request, capability);
		if (!profile) {
			throw new CryptoHftDataError("profile_semantics_unavailable");
		}
		return profile;
	}

	async discoverSymbols(providerExchangeId: string): Promise<string[]> {
		if (!/^[a-z0-9_]+$/.test(providerExchangeId)) {
			throw new CryptoHftDataError("symbol_discovery_exchange_invalid");
		}
		const endpoint = new URL("/symbols", this.baseUrl);
		endpoint.searchParams.set("exchange", providerExchangeId);
		endpoint.searchParams.set("data_type", "orderbook");
		let response: Response;
		try {
			response = await this.request(endpoint);
		} catch {
			throw new CryptoHftDataError("symbol_discovery_failed");
		}
		if (!response.ok) {
			throw new CryptoHftDataError("symbol_discovery_failed");
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new CryptoHftDataError("symbol_discovery_response_invalid");
		}
		const record = body as Record<string, unknown>;
		if (
			!body ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			String(record.exchange).toLowerCase() !== providerExchangeId ||
			String(record.data_type).toLowerCase() !== "orderbook" ||
			!Array.isArray(record.symbols) ||
			!record.symbols.every(
				(symbol) => typeof symbol === "string" && /^[A-Z0-9_-]+$/.test(symbol),
			)
		) {
			throw new CryptoHftDataError("symbol_discovery_response_invalid");
		}
		return [...new Set(record.symbols as string[])].sort();
	}

	async acquire(
		request: MarketDataVendorBackfillRequest,
		capability: ProviderCapability,
		credential: unknown,
	): Promise<ProviderDataset<CryptoHftDataOrderBookRow>> {
		const profile = this.findProfile(request, capability);
		const apiKey =
			credential && typeof credential === "object"
				? (credential as { apiKey?: unknown }).apiKey
				: undefined;
		if (typeof apiKey !== "string" || apiKey.length === 0) {
			throw new CryptoHftDataError("credentials_invalid");
		}
		const paths = enumerateCryptoHftDataObjects(
			request,
			capability.providerExchangeId,
			capability.resolvedSymbol,
		);
		if (paths.length > request.budgets.maxFiles) {
			throw new CryptoHftDataError("budget_max_files_exceeded");
		}
		const started = this.nowMs();
		const tokenResponse = await this.request(`${this.baseUrl}/jwt-token`, {
			method: "POST",
			headers: { "content-type": "application/json", "X-API-Key": apiKey },
		});
		if (!tokenResponse.ok) throw new CryptoHftDataError("jwt_issuance_failed");
		const tokenBody = (await tokenResponse.json()) as { jwt_token?: unknown };
		if (typeof tokenBody.jwt_token !== "string" || !tokenBody.jwt_token) {
			throw new CryptoHftDataError("jwt_response_invalid");
		}

		let totalBytes = 0;
		let totalRows = 0;
		const objects: ProviderObjectEvidence[] = [];
		const rows: CryptoHftDataOrderBookRow[] = [];
		const reconstructor =
			profile?.sequenceSemantics === "okx_seq_id_prev_seq_id"
				? new StreamingBookReconstructor(request, profile)
				: undefined;
		const semanticHash = createHash("sha256");
		let firstSemanticRow = true;
		semanticHash.update("[");
		for (const path of paths) {
			if (this.nowMs() - started > request.budgets.maxDurationMs) {
				throw new CryptoHftDataError("budget_max_duration_exceeded");
			}
			const endpoint = new URL("/download", this.baseUrl);
			endpoint.searchParams.set("file", path);
			const response = await this.request(endpoint, {
				headers: { Authorization: `Bearer ${tokenBody.jwt_token}` },
			});
			if (!response.ok) throw new CryptoHftDataError("object_download_failed");
			const declaredBytes = Number(response.headers.get("content-length"));
			if (
				Number.isFinite(declaredBytes) &&
				totalBytes + declaredBytes > request.budgets.maxBytes
			) {
				throw new CryptoHftDataError("budget_max_bytes_exceeded");
			}
			const bytes = await readBoundedObject(
				response,
				request.budgets.maxBytes - totalBytes,
			);
			totalBytes += bytes.byteLength;
			if (totalBytes > request.budgets.maxBytes) {
				throw new CryptoHftDataError("budget_max_bytes_exceeded");
			}
			const decoded = await this.decode(bytes);
			totalRows += decoded.length;
			if (totalRows > request.budgets.maxRows) {
				throw new CryptoHftDataError("budget_max_rows_exceeded");
			}
			const object = {
				identity: path,
				checksum: sha256Bytes(bytes),
				bytes: bytes.byteLength,
				rows: decoded.length,
			};
			objects.push(object);
			const parsedRows: CryptoHftDataOrderBookRow[] = [];
			for (const decodedRow of decoded) {
				const parsed = parsedDatasetRow(decodedRow, object);
				validatedRow(request, parsed);
				semanticHash.update(firstSemanticRow ? "" : ",");
				semanticHash.update(canonicalSerialize(parsed));
				firstSemanticRow = false;
				parsedRows.push(parsed);
			}
			if (reconstructor) reconstructor.push(parsedRows);
			else rows.push(...parsedRows);
		}
		if (this.nowMs() - started > request.budgets.maxDurationMs) {
			throw new CryptoHftDataError("budget_max_duration_exceeded");
		}
		semanticHash.update("]");
		return {
			objects,
			rows,
			reconstructedBooks: reconstructor?.finish(),
			vendorSemanticDigest: semanticHash.digest("hex"),
		};
	}

	async normalize(
		request: MarketDataVendorBackfillRequest,
		capability: ProviderCapability,
		dataset: ProviderDataset,
		captureBundleId: string,
	): Promise<NormalizedBackfill> {
		const profile = this.profileFor(request, capability);
		const samples = dataset.reconstructedBooks
			? (dataset.reconstructedBooks as ReconstructedCryptoHftBook[])
			: reconstructCryptoHftDataOrderBooks(
					request,
					dataset.rows as CryptoHftDataOrderBookRow[],
					profile,
				);
		const context: MarketCaptureContext = {
			source: EXTERNAL_BACKFILL_SOURCE,
			deploymentId: "market-data-vendor-backfill",
			captureBundleId,
			exchange: request.scope.exchange,
			symbol: request.scope.tradingPair,
			tradingPair: request.scope.tradingPair,
			sourceSymbol: request.scope.sourceSymbol,
			assetType: request.scope.marketType,
			feed: "ORDERBOOK",
			provider: "cryptohftdata",
			sourceMode: HISTORICAL_VENDOR_SOURCE_MODE,
			schemaVersion: MARKET_CAPTURE_SCHEMA_VERSION,
			checksumAlgorithm: CHECKSUM_ALGORITHM,
			provenanceComplete: true,
		};
		const rows = samples.flatMap((sample) => {
			const rawCapture: RawCapture = {
				rawCaptureId: sha256Canonical({
					capture_bundle_id: captureBundleId,
					dataset_object_identity: sample.datasetObjectIdentity,
					dataset_object_checksum: sample.datasetObjectChecksum,
					source_time_ms: sample.sourceTimeMs,
					target_time_ms: sample.targetTimeMs,
				}),
				rawCaptureScope: VENDOR_DATASET_RAW_CAPTURE_SCOPE,
				rawChecksum: sample.datasetObjectChecksum,
				redactedPayload: {
					dataset_object_identity: sample.datasetObjectIdentity,
					dataset_object_checksum: sample.datasetObjectChecksum,
				},
				eventTimeMs: sample.sourceTimeMs,
				receivedTimeMs: sample.receivedTimeMs,
				checksumAlgorithm: CHECKSUM_ALGORITHM,
			};
			const canonical = buildCanonicalOrderBookRows({
				context,
				rawCapture,
				depthLimit: request.depth,
				constructionMode: request.constructionMode,
				snapshot: {
					bids: sample.bids,
					asks: sample.asks,
					timestamp: sample.sourceTimeMs,
					receivedTimestamp: sample.receivedTimeMs,
					exchange: request.scope.exchange,
					symbol: request.scope.tradingPair,
					depthLimit: request.depth,
					sequence: sample.sequence,
				},
			});
			return [...canonical.levels, canonical.summary];
		}) as BackfillArchiveRow[];
		return {
			captureBundleId,
			objects: dataset.objects,
			rows,
			vendorSemanticDigest: dataset.vendorSemanticDigest,
			canonicalSemanticDigest: semanticDigest(rows),
		};
	}
}
