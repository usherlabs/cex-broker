import {
	CANDIDATE_C_INPUT_TAPE_CAPABILITY,
	CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE,
} from "../candidate-c-input-tape";
import {
	type CanonicalOrderBookExportQuerySegment,
	type CanonicalOrderBookExportRequestWire,
	canonicalOrderBookExportRequestCodec,
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION,
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
} from "../market-data-preparation/contracts";
import {
	type ArchiveSelectionWire,
	archiveSelectionCodec,
	type Sha256Hex,
} from "../market-data-vendor-backfill/contracts";
import { jcsSha256 } from "../market-data-vendor-backfill/identity";
import {
	CAPABILITY_POLICY,
	EFFECTIVE_ACQUISITION_POLICY_PIN,
	EFFECTIVE_ADAPTER_POLICY_PIN,
	RESOURCE_POLICY,
} from "../market-data-vendor-backfill/manifests";

export type ExactOrderBookQueryValue = string | number | readonly string[];

export type CompiledExactOrderBookExport = {
	request: CanonicalOrderBookExportRequestWire;
	segments: CanonicalOrderBookExportQuerySegment[];
	querySha256: Sha256Hex;
	parameters: Readonly<Record<string, ExactOrderBookQueryValue>>;
	predicateSql: string;
	physicalPredicateSql: string;
	levelsSql: string;
	summarySql: string;
	conflictsSql: string;
	rowCountsSql: string;
	promotionReceiptsSql: string;
};

export class ExactOrderBookExportError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "ExactOrderBookExportError";
	}
}

type Interval = { startAtMs: number; endAtMs: number };
type Candidate = CanonicalOrderBookExportQuerySegment & Interval;

function intervalMs(
	interval: { start_at: string; end_at: string },
	field: string,
): Interval {
	const startAtMs = Date.parse(interval.start_at);
	const endAtMs = Date.parse(interval.end_at);
	if (
		!Number.isSafeInteger(startAtMs) ||
		!Number.isSafeInteger(endAtMs) ||
		startAtMs < 0 ||
		endAtMs <= startAtMs
	) {
		throw new ExactOrderBookExportError(`${field}_invalid`);
	}
	return { startAtMs, endAtMs };
}

function contains(outer: Interval, inner: Interval): boolean {
	return outer.startAtMs <= inner.startAtMs && outer.endAtMs >= inner.endAtMs;
}

function expectedPrecedence(
	selection: ArchiveSelectionWire,
): ArchiveSelectionWire["precedence"] {
	return selection.source_policy === "fill_gaps"
		? ["archive", "vendor"]
		: ["vendor"];
}

function originPriority(
	selection: ArchiveSelectionWire,
	origin: CanonicalOrderBookExportQuerySegment["capture_origin"],
): number {
	if (selection.source_policy === "fill_gaps") {
		return origin === "production_capture" ? 0 : 1;
	}
	return origin === "vendor_historical_backfill" ? 0 : Number.MAX_SAFE_INTEGER;
}

function assertSelectionLinks(selection: ArchiveSelectionWire): Candidate[] {
	if (
		JSON.stringify(selection.precedence) !==
		JSON.stringify(expectedPrecedence(selection))
	) {
		throw new ExactOrderBookExportError("selection_precedence_invalid");
	}
	const bundleById = new Map(
		selection.bundles.map((bundle) => [bundle.capture_bundle_id, bundle]),
	);
	if (bundleById.size !== selection.bundles.length) {
		throw new ExactOrderBookExportError("selection_bundle_identity_duplicate");
	}
	const requested = selection.requested_intervals.map((interval, index) =>
		intervalMs(interval, `requested_interval_${index}`),
	);
	if (
		selection.source_policy === "authoritative_window" &&
		new Set(
			selection.selected_intervals.map((selected) => selected.capture_origin),
		).size > 1
	) {
		throw new ExactOrderBookExportError(
			"authoritative_selection_mixes_capture_origins",
		);
	}

	return selection.selected_intervals.map((selected, index) => {
		const selectedMs = intervalMs(selected, `selected_interval_${index}`);
		const bundle = bundleById.get(selected.capture_bundle_id);
		if (!bundle || bundle.capture_origin !== selected.capture_origin) {
			throw new ExactOrderBookExportError("selected_bundle_link_invalid");
		}
		if (
			!contains(
				intervalMs(bundle.interval, `bundle_interval_${index}`),
				selectedMs,
			)
		) {
			throw new ExactOrderBookExportError("selected_interval_outside_bundle");
		}
		if (!requested.some((interval) => contains(interval, selectedMs))) {
			throw new ExactOrderBookExportError("selected_interval_outside_request");
		}
		if (selected.capture_origin === "vendor_historical_backfill") {
			const qualification = bundle.qualification;
			if (
				qualification?.state !== "qualified" ||
				!selection.receipt_ids.includes(qualification.receipt_id) ||
				!selection.qualification_event_ids.includes(
					qualification.qualification_event_id,
				)
			) {
				throw new ExactOrderBookExportError(
					"vendor_selection_qualification_link_invalid",
				);
			}
		}
		return { ...selected, ...selectedMs };
	});
}

function effectiveSegments(
	selection: ArchiveSelectionWire,
): CanonicalOrderBookExportQuerySegment[] {
	const candidates = assertSelectionLinks(selection);
	const segments: Candidate[] = [];
	for (const [
		requestIndex,
		requestedWire,
	] of selection.requested_intervals.entries()) {
		const requested = intervalMs(
			requestedWire,
			`requested_interval_${requestIndex}`,
		);
		const relevant = candidates.filter(
			(candidate) =>
				candidate.startAtMs < requested.endAtMs &&
				candidate.endAtMs > requested.startAtMs,
		);
		const boundaries = [
			...new Set([
				requested.startAtMs,
				requested.endAtMs,
				...relevant.flatMap((candidate) => [
					Math.max(candidate.startAtMs, requested.startAtMs),
					Math.min(candidate.endAtMs, requested.endAtMs),
				]),
			]),
		].sort((left, right) => left - right);
		for (let index = 0; index < boundaries.length - 1; index += 1) {
			const startAtMs = boundaries[index];
			const endAtMs = boundaries[index + 1];
			if (
				startAtMs === undefined ||
				endAtMs === undefined ||
				endAtMs <= startAtMs
			) {
				continue;
			}
			const covering = relevant.filter(
				(candidate) =>
					candidate.startAtMs <= startAtMs && candidate.endAtMs >= endAtMs,
			);
			if (covering.length === 0) {
				throw new ExactOrderBookExportError("complete_selection_has_gap");
			}
			const priority = Math.min(
				...covering.map((candidate) =>
					originPriority(selection, candidate.capture_origin),
				),
			);
			const preferred = covering.filter(
				(candidate) =>
					originPriority(selection, candidate.capture_origin) === priority,
			);
			const identities = new Set(
				preferred.map(
					(candidate) =>
						`${candidate.capture_bundle_id}:${candidate.capture_origin}`,
				),
			);
			if (identities.size !== 1 || !preferred[0]) {
				throw new ExactOrderBookExportError("ambiguous_selection_overlap");
			}
			segments.push({ ...preferred[0], startAtMs, endAtMs });
		}
	}

	const merged: Candidate[] = [];
	for (const segment of segments.sort(
		(left, right) =>
			left.startAtMs - right.startAtMs ||
			left.endAtMs - right.endAtMs ||
			left.capture_bundle_id.localeCompare(right.capture_bundle_id),
	)) {
		const previous = merged.at(-1);
		if (
			previous &&
			previous.endAtMs === segment.startAtMs &&
			previous.capture_bundle_id === segment.capture_bundle_id &&
			previous.capture_origin === segment.capture_origin
		) {
			previous.endAtMs = segment.endAtMs;
			previous.end_at = new Date(segment.endAtMs).toISOString();
		} else {
			merged.push({
				...segment,
				start_at: new Date(segment.startAtMs).toISOString(),
				end_at: new Date(segment.endAtMs).toISOString(),
			});
		}
	}
	return merged.map(
		({ startAtMs: _startAtMs, endAtMs: _endAtMs, ...segment }) => segment,
	);
}

function queryIdentity(
	request: CanonicalOrderBookExportRequestWire,
	segments: CanonicalOrderBookExportQuerySegment[],
): Sha256Hex {
	return jcsSha256({
		selection_sha256: request.selection.selection_sha256,
		target: request.target,
		scope: request.selection.scope,
		depth: request.depth,
		construction_mode: request.construction_mode,
		canonical_schema_version: request.canonical_schema_version,
		checksum_algorithm: request.checksum_algorithm,
		source_policy: request.selection.source_policy,
		precedence: request.selection.precedence,
		segments,
		projection_schemas: {
			levels: {
				schema_id: ORDER_BOOK_LEVELS_PARQUET_PROJECTION.$id,
				schema_sha256: ORDER_BOOK_LEVELS_PARQUET_PROJECTION_SCHEMA_SHA256,
			},
			summary: {
				schema_id: ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION.$id,
				schema_sha256:
					ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION_SCHEMA_SHA256,
			},
		},
	});
}

function projectionSql(projection: {
	columns: Array<{ name: string }>;
}): string {
	return projection.columns.map(({ name }) => `\`${name}\``).join(", ");
}

function buildPredicate(
	request: CanonicalOrderBookExportRequestWire,
	segments: CanonicalOrderBookExportQuerySegment[],
): {
	parameters: Record<string, ExactOrderBookQueryValue>;
	predicateSql: string;
	segmentPredicateSql: string[];
} {
	const parameters: Record<string, ExactOrderBookQueryValue> = {
		exchange: request.selection.scope.exchange,
		trading_pair: request.selection.scope.trading_pair,
		depth_limit: request.depth,
		construction_mode: request.construction_mode,
		schema_version: request.canonical_schema_version,
		checksum_algorithm: request.checksum_algorithm,
	};
	const segmentPredicates = segments.map((segment, index) => {
		const prefix = `segment_${index}`;
		const sources =
			segment.capture_origin === "production_capture"
				? ["broker_read", "broker_write"]
				: ["external_backfill"];
		parameters[`${prefix}_bundle`] = segment.capture_bundle_id;
		parameters[`${prefix}_start_ms`] = Date.parse(segment.start_at);
		parameters[`${prefix}_end_ms`] = Date.parse(segment.end_at);
		parameters[`${prefix}_origin`] =
			segment.capture_origin === "production_capture"
				? "production_capture"
				: "vendor_historical_backfill";
		parameters[`${prefix}_sources`] = sources;
		return `(capture_bundle_id = {${prefix}_bundle:String}
	AND capture_origin = {${prefix}_origin:String}
	AND source IN {${prefix}_sources:Array(String)}
	AND source_time_ms >= {${prefix}_start_ms:UInt64}
	AND source_time_ms < {${prefix}_end_ms:UInt64})`;
	});
	const scopePredicateSql = `exchange = {exchange:String}
	AND trading_pair = {trading_pair:String}
	AND feed = 'ORDERBOOK'
	AND depth_limit = {depth_limit:UInt16}
	AND construction_mode = {construction_mode:String}
	AND schema_version = {schema_version:String}
	AND checksum_algorithm = {checksum_algorithm:String}`;
	return {
		parameters,
		predicateSql: `${scopePredicateSql}
	AND (${segmentPredicates.join("\n\tOR ")})`,
		segmentPredicateSql: segmentPredicates.map(
			(segmentPredicate) => `${scopePredicateSql}\n\tAND ${segmentPredicate}`,
		),
	};
}

export function compileExactOrderBookExport(
	requestInput: CanonicalOrderBookExportRequestWire,
): CompiledExactOrderBookExport {
	const request = canonicalOrderBookExportRequestCodec.decode(requestInput);
	archiveSelectionCodec.decode(request.selection);
	const segments = effectiveSegments(request.selection);
	if (segments.length === 0) {
		throw new ExactOrderBookExportError("selection_has_no_effective_segments");
	}
	const { parameters, predicateSql, segmentPredicateSql } = buildPredicate(
		request,
		segments,
	);
	const currentCapability =
		request.construction_mode === CANDIDATE_C_INPUT_TAPE_CONSTRUCTION_MODE
			? CANDIDATE_C_INPUT_TAPE_CAPABILITY
			: CAPABILITY_POLICY;
	parameters.current_capability_policy_id = currentCapability.policy_id;
	parameters.current_capability_policy_sha256 = currentCapability.policy_sha256;
	parameters.current_resource_policy_id = RESOURCE_POLICY.policy_id;
	parameters.current_resource_policy_sha256 = RESOURCE_POLICY.policy_sha256;
	parameters.current_adapter_policy_id = EFFECTIVE_ADAPTER_POLICY_PIN.policy_id;
	parameters.current_adapter_policy_sha256 =
		EFFECTIVE_ADAPTER_POLICY_PIN.policy_sha256;
	parameters.current_acquisition_policy_id =
		EFFECTIVE_ACQUISITION_POLICY_PIN.policy_id;
	parameters.current_acquisition_policy_sha256 =
		EFFECTIVE_ACQUISITION_POLICY_PIN.policy_sha256;
	const physicalPredicateSql = predicateSql;
	const levelsSql = `SELECT ${projectionSql(ORDER_BOOK_LEVELS_PARQUET_PROJECTION)}
	FROM market_data.cex_order_book_levels_replay_qualified
	WHERE ${predicateSql}
	ORDER BY source_time_ms, snapshot_id, side, level_index`;
	const summarySql = `SELECT ${projectionSql(ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION)}
	FROM market_data.cex_order_book_depth_summary_replay_qualified
	WHERE ${predicateSql}
	ORDER BY source_time_ms, snapshot_id`;
	const conflictsSql = `SELECT count() AS conflicts
	FROM
	(
		SELECT conflict.capture_bundle_id, conflict.snapshot_id
		FROM market_data.cex_order_book_levels_conflicts AS conflict
		INNER JOIN
		(
			SELECT DISTINCT capture_bundle_id, snapshot_id
			FROM market_data.cex_order_book_depth_summary
			WHERE ${physicalPredicateSql}
		) AS selected USING (capture_bundle_id, snapshot_id)
		UNION ALL
		SELECT conflict.capture_bundle_id, conflict.snapshot_id
		FROM market_data.cex_order_book_depth_summary_conflicts AS conflict
		INNER JOIN
		(
			SELECT DISTINCT capture_bundle_id, snapshot_id
			FROM market_data.cex_order_book_depth_summary
			WHERE ${physicalPredicateSql}
		) AS selected USING (capture_bundle_id, snapshot_id)
	)`;
	const segmentRowCountsSql = segmentPredicateSql.flatMap(
		(segmentPredicate, index) => [
			`(SELECT count() FROM market_data.cex_order_book_levels_replay_qualified WHERE ${segmentPredicate}) AS segment_${index}_level_rows`,
			`(SELECT count() FROM market_data.cex_order_book_depth_summary_replay_qualified WHERE ${segmentPredicate}) AS segment_${index}_summary_rows`,
		],
	);
	const rowCountsSql = `SELECT
		(SELECT count() FROM market_data.cex_order_book_levels_replay_qualified WHERE ${predicateSql}) AS level_rows,
		(SELECT count() FROM market_data.cex_order_book_depth_summary_replay_qualified WHERE ${predicateSql}) AS summary_rows,
		${segmentRowCountsSql.join(",\n\t\t")}`;
	const promotionReceiptsSql = `SELECT DISTINCT promotion.receipt_id AS receipt_id
	FROM market_data.cex_order_book_capture_promotions AS promotion
	INNER JOIN
	(
		SELECT DISTINCT capture_bundle_id
		FROM market_data.cex_order_book_depth_summary_replay_qualified
		WHERE ${predicateSql}
	) AS selected USING (capture_bundle_id)
	INNER JOIN
	(
		SELECT capture_bundle_id, receipt_id, promotion_identity_sha256, state
		FROM market_data.cex_order_book_capture_qualifications
		ORDER BY event_at_ms DESC
		LIMIT 1 BY capture_bundle_id
	) AS latest
	ON promotion.capture_bundle_id = latest.capture_bundle_id
	AND promotion.receipt_id = latest.receipt_id
	AND promotion.promotion_identity_sha256 = latest.promotion_identity_sha256
	WHERE latest.state = 'qualified'
	AND promotion.status = 'passing'
	AND promotion.seam_verified = 1
	AND promotion.coverage_verified = 1
	AND promotion.capability_policy_id = {current_capability_policy_id:String}
	AND promotion.capability_policy_sha256 = {current_capability_policy_sha256:String}
	AND promotion.resource_policy_id = {current_resource_policy_id:String}
	AND promotion.resource_policy_sha256 = {current_resource_policy_sha256:String}
	AND promotion.adapter_policy_id = {current_adapter_policy_id:String}
	AND promotion.adapter_policy_sha256 = {current_adapter_policy_sha256:String}
	AND promotion.acquisition_policy_id = {current_acquisition_policy_id:String}
	AND promotion.acquisition_policy_sha256 = {current_acquisition_policy_sha256:String}
	ORDER BY promotion.receipt_id`;
	return {
		request,
		segments,
		querySha256: queryIdentity(request, segments),
		parameters,
		predicateSql,
		physicalPredicateSql,
		levelsSql,
		summarySql,
		conflictsSql,
		rowCountsSql,
		promotionReceiptsSql,
	};
}
