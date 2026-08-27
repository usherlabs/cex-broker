import { sha256Canonical } from "../market-data-archive/capture-contract";
import type {
	BackfillArchiveRow,
	MarketDataVendorBackfillRequest,
	PromotionReceiptWire,
} from "./contracts";
import { archiveSelectionCodec } from "./contracts";
import type {
	ArchivePreflightResolution,
	CandidateVerification,
	NormalizedBackfill,
	QualifiedCoverage,
} from "./core";
import { jcsCanonicalize } from "./identity";
import {
	promotionReceiptFromArchiveRow,
	promotionReceiptMatchesCurrentPolicies,
} from "./promotion";
import {
	type ArchiveBundleEvidence,
	resolveArchiveSelection,
} from "./selection";
import { verifySemanticPromotion } from "./semantic-verification";

export type ArchiveQueryValue = string | number | readonly string[];
export type ArchiveQueryClient = {
	query(
		sql: string,
		parameters?: Readonly<Record<string, ArchiveQueryValue>>,
	): Promise<Record<string, unknown>[]>;
};

export type QualifiedArchiveReaderOptions = { nowMs?: () => number };

const QUALIFIED_SUMMARY =
	"market_data.cex_order_book_depth_summary_replay_qualified";
const QUALIFIED_LEVELS = "market_data.cex_order_book_levels_replay_qualified";
const CANDIDATE_SUMMARY = "market_data.cex_order_book_depth_summary_canonical";
const CANDIDATE_LEVELS = "market_data.cex_order_book_levels_canonical";

class ArchiveReaderError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "ArchiveReaderError";
	}
}

async function archiveQuery(
	client: ArchiveQueryClient,
	reason: string,
	sql: string,
	parameters?: Readonly<Record<string, ArchiveQueryValue>>,
): Promise<Record<string, unknown>[]> {
	try {
		return await client.query(sql, parameters);
	} catch {
		throw new ArchiveReaderError(reason);
	}
}

function queryParameters(request: MarketDataVendorBackfillRequest) {
	return {
		exchange: request.scope.exchange,
		trading_pair: request.scope.tradingPair,
		start_time_ms: request.window.startTimeMs,
		end_time_ms: request.window.endTimeMs,
		depth_limit: request.depth,
		construction_mode: request.constructionMode,
		schema_version: request.expectedProduct.canonicalSchemaVersion,
	};
}

function scopeFilter(alias = "") {
	const prefix = alias ? `${alias}.` : "";
	return `
${prefix}exchange = {exchange:String}
AND ${prefix}trading_pair = {trading_pair:String}
AND ${prefix}depth_limit = {depth_limit:UInt16}
AND ${prefix}construction_mode = {construction_mode:String}
AND ${prefix}schema_version = {schema_version:String}`;
}

function numberField(row: Record<string, unknown>, field: string): number {
	const value = row[field];
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`Archive field ${field} is not a safe unsigned integer`);
	}
	return parsed;
}

function uint64Field(
	row: Record<string, unknown>,
	field: string,
): bigint | undefined {
	const value = row[field];
	if (value === null || value === undefined) return undefined;
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0
			? BigInt(value)
			: undefined;
	}
	if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
	const parsed = BigInt(value);
	return parsed <= 18_446_744_073_709_551_615n ? parsed : undefined;
}

function timelineDigest(rows: readonly Record<string, unknown>[]): string {
	return sha256Canonical(
		rows
			.map((row) => ({
				table: String(row.table ?? "summary"),
				snapshot_id: String(row.snapshot_id ?? ""),
				source_time_ms: numberField(row, "source_time_ms"),
				normalized_row_checksum: String(row.normalized_row_checksum ?? ""),
			}))
			.sort((left, right) =>
				left.source_time_ms === right.source_time_ms
					? left.normalized_row_checksum.localeCompare(
							right.normalized_row_checksum,
						)
					: left.source_time_ms - right.source_time_ms,
			),
	);
}

function clocksCovered(
	request: MarketDataVendorBackfillRequest,
	rows: readonly Record<string, unknown>[],
): boolean {
	const times = rows
		.map((row) => numberField(row, "source_time_ms"))
		.sort((left, right) => left - right);
	return request.requiredClockTargetsMs.every((target) => {
		let prior: number | undefined;
		for (const sourceTime of times) {
			if (sourceTime > target) break;
			prior = sourceTime;
		}
		return prior !== undefined && target - prior <= request.maxPriorAsOfLagMs;
	});
}

function candidateRows(
	table:
		| "market_data.cex_order_book_levels"
		| "market_data.cex_order_book_depth_summary",
	rows: Record<string, unknown>[],
): BackfillArchiveRow[] {
	return rows.map((row) => ({ table, row }));
}

export class QualifiedOrderBookArchiveReader {
	constructor(
		private readonly client: ArchiveQueryClient,
		private readonly options?: QualifiedArchiveReaderOptions,
	) {}

	async resolveSelection(
		request: MarketDataVendorBackfillRequest,
	): Promise<ArchivePreflightResolution> {
		const identityRows = await archiveQuery(
			this.client,
			"archive_cluster_identity_query_failed",
			`SELECT environment, cluster
			 FROM market_data.cex_archive_cluster_identity FINAL
			 WHERE singleton_key = 'archive'
			 LIMIT 2`,
		);
		if (identityRows.length !== 1) {
			throw new Error(
				"archive cluster identity singleton is missing or conflicting",
			);
		}
		const readerIdentity = {
			environment: String(identityRows[0]?.environment ?? ""),
			cluster: String(identityRows[0]?.cluster ?? ""),
		};
		const conflictRows = await archiveQuery(
			this.client,
			"archive_selection_conflict_query_failed",
			`SELECT count() AS conflicts
			 FROM
			 (
			   SELECT conflict.capture_bundle_id, conflict.snapshot_id
			   FROM market_data.cex_order_book_levels_conflicts AS conflict
			   INNER JOIN
			   (
			     SELECT DISTINCT capture_bundle_id, snapshot_id
			     FROM market_data.cex_order_book_depth_summary
			     WHERE ${scopeFilter()}
			       AND source_time_ms >= {start_time_ms:UInt64}
			       AND source_time_ms < {end_time_ms:UInt64}
			   ) AS selected USING (capture_bundle_id, snapshot_id)
			   UNION ALL
			   SELECT conflict.capture_bundle_id, conflict.snapshot_id
			   FROM market_data.cex_order_book_depth_summary_conflicts AS conflict
			   INNER JOIN
			   (
			     SELECT DISTINCT capture_bundle_id, snapshot_id
			     FROM market_data.cex_order_book_depth_summary
			     WHERE ${scopeFilter()}
			       AND source_time_ms >= {start_time_ms:UInt64}
			       AND source_time_ms < {end_time_ms:UInt64}
			   ) AS selected USING (capture_bundle_id, snapshot_id)
			 )`,
			queryParameters(request),
		);
		if (
			conflictRows.length !== 1 ||
			!Number.isSafeInteger(Number(conflictRows[0]?.conflicts)) ||
			Number(conflictRows[0]?.conflicts) < 0
		) {
			throw new ArchiveReaderError("archive_selection_conflict_query_invalid");
		}
		if (Number(conflictRows[0]?.conflicts) > 0) {
			throw new ArchiveReaderError("archive_selection_checksum_conflict");
		}
		const storedRows = await archiveQuery(
			this.client,
			"archive_stored_selection_query_failed",
			`SELECT selection_sha256, selection_json
			 FROM market_data.cex_order_book_archive_selections
			 WHERE idempotency_key = {idempotency_key:String}
			 ORDER BY resolved_at_ms, selection_sha256`,
			{ idempotency_key: request.idempotencyKey },
		);
		if (storedRows.length > 0) {
			const selections = storedRows.map((row) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(String(row.selection_json));
				} catch {
					throw new Error("stored archive selection JSON is invalid");
				}
				const selection = archiveSelectionCodec.decode(parsed);
				if (selection.selection_sha256 !== row.selection_sha256) {
					throw new Error("stored archive selection row identity mismatch");
				}
				return selection;
			});
			const canonical = new Set(selections.map(jcsCanonicalize));
			if (canonical.size !== 1) {
				throw new Error("stored archive selection content conflicts");
			}
			const selection = resolveArchiveSelection({
				request,
				bundles: [],
				resolvedAtMs: this.options?.nowMs?.() ?? Date.now(),
				storedSelection: selections[0],
			});
			const receipts = await this.readReceipts(selection.receipt_ids);
			const currentReceiptIds = new Set(
				receipts
					.filter(promotionReceiptMatchesCurrentPolicies)
					.map((receipt) => receipt.receipt_id),
			);
			const storedSelectionIsCurrent = selection.bundles.every(
				(bundle) =>
					bundle.capture_origin === "production_capture" ||
					(bundle.qualification !== null &&
						currentReceiptIds.has(bundle.qualification.receipt_id)),
			);
			if (storedSelectionIsCurrent) {
				return {
					selection,
					receipts: receipts.filter(promotionReceiptMatchesCurrentPolicies),
					readerIdentity,
				};
			}
		}

		const parameters = {
			...queryParameters(request),
			coverage_start_ms: Math.max(
				0,
				request.window.startTimeMs - request.maxPriorAsOfLagMs,
			),
		};
		const summaries = await archiveQuery(
			this.client,
			"archive_qualified_summary_query_failed",
			`SELECT capture_bundle_id, raw_capture_id, snapshot_id,
			        source_time_ms, normalized_row_checksum, source
			 FROM ${QUALIFIED_SUMMARY}
			 WHERE ${scopeFilter()}
			   AND source_time_ms >= {coverage_start_ms:UInt64}
			   AND source_time_ms < {end_time_ms:UInt64}
			 ORDER BY source_time_ms, capture_bundle_id, snapshot_id`,
			parameters,
		);
		const bundleIds = [
			...new Set(summaries.map((row) => String(row.capture_bundle_id))),
		].filter(Boolean);
		const qualificationRows = await archiveQuery(
			this.client,
			"archive_qualification_query_failed",
			`SELECT capture_bundle_id, qualification_event_id, state, receipt_id,
			        promotion_identity_sha256, window_start_ms, window_end_ms
			 FROM market_data.cex_order_book_capture_qualifications
			 WHERE capture_bundle_id IN {capture_bundle_ids:Array(String)}
			 ORDER BY event_at_ms DESC
			 LIMIT 1 BY capture_bundle_id`,
			{ capture_bundle_ids: bundleIds },
		);
		const qualificationByBundle = new Map(
			qualificationRows.map((row) => [String(row.capture_bundle_id), row]),
		);
		const receiptIds = qualificationRows
			.map((row) => String(row.receipt_id ?? ""))
			.filter(Boolean);
		const receipts = await this.readReceipts(receiptIds);
		const currentReceipts = receipts.filter(
			promotionReceiptMatchesCurrentPolicies,
		);
		const receiptIdsSet = new Set(
			currentReceipts.map((receipt) => receipt.receipt_id),
		);
		const receiptById = new Map(
			currentReceipts.map((receipt) => [receipt.receipt_id, receipt]),
		);
		const grouped = new Map<string, ArchiveBundleEvidence>();
		for (const row of summaries) {
			const captureBundleId = String(row.capture_bundle_id);
			const captureOrigin =
				String(row.source) === "external_backfill"
					? "vendor_historical_backfill"
					: "production_capture";
			const qualificationRow = qualificationByBundle.get(captureBundleId);
			const receiptId = String(qualificationRow?.receipt_id ?? "");
			const receipt = receiptById.get(receiptId);
			const qualification =
				captureOrigin === "vendor_historical_backfill" && qualificationRow
					? {
							qualificationEventId: String(
								qualificationRow.qualification_event_id,
							),
							state: String(qualificationRow.state) as
								| "qualified"
								| "quarantined"
								| "revoked",
							receiptId,
							promotionIdentitySha256: String(
								qualificationRow.promotion_identity_sha256,
							),
							...(receipt
								? {
										requestId: receipt.request_id,
										idempotencyKey: receipt.idempotency_key,
									}
								: {}),
						}
					: null;
			if (
				captureOrigin === "vendor_historical_backfill" &&
				(!qualification || !receiptIdsSet.has(receiptId))
			) {
				continue;
			}
			const sourceTimeMs = numberField(row, "source_time_ms");
			const startTimeMs = qualificationRow
				? numberField(qualificationRow, "window_start_ms")
				: sourceTimeMs;
			const endTimeMs = qualificationRow
				? numberField(qualificationRow, "window_end_ms")
				: sourceTimeMs + 1;
			const existing = grouped.get(captureBundleId) ?? {
				captureBundleId,
				captureOrigin,
				startTimeMs,
				endTimeMs,
				qualification,
				supportAnchors: [],
			};
			existing.startTimeMs = Math.min(existing.startTimeMs, startTimeMs);
			existing.endTimeMs = Math.max(existing.endTimeMs, endTimeMs);
			existing.supportAnchors.push({
				captureBundleId,
				rawCaptureId: String(row.raw_capture_id),
				snapshotId: String(row.snapshot_id),
				sourceTimeMs,
				normalizedSummaryChecksum: String(row.normalized_row_checksum),
			});
			grouped.set(captureBundleId, existing);
		}
		const [prefix, suffix] = await Promise.all([
			this.boundaryRows(request, "prefix"),
			this.boundaryRows(request, "suffix"),
		]);
		const selection = resolveArchiveSelection({
			request,
			bundles: [...grouped.values()],
			resolvedAtMs: this.options?.nowMs?.() ?? Date.now(),
		});
		return {
			selection,
			receipts: currentReceipts,
			readerIdentity,
			verificationBaseline: {
				prefixDigest: timelineDigest(prefix),
				suffixDigest: timelineDigest(suffix),
			},
		};
	}

	private async readReceipts(
		receiptIds: readonly string[],
	): Promise<PromotionReceiptWire[]> {
		if (receiptIds.length === 0) return [];
		const rows = await archiveQuery(
			this.client,
			"archive_receipt_query_failed",
			`SELECT receipt_id, promotion_identity_sha256, receipt_json
			 FROM market_data.cex_order_book_capture_promotions
			 WHERE receipt_id IN {receipt_ids:Array(String)}
			 ORDER BY receipt_id`,
			{ receipt_ids: [...new Set(receiptIds)].sort() },
		);
		let receipts: Array<PromotionReceiptWire | object>;
		try {
			receipts = rows.map((row) => promotionReceiptFromArchiveRow(row));
		} catch {
			throw new ArchiveReaderError("archive_receipt_invalid");
		}
		if (receipts.some((receipt) => !("schema_id" in receipt))) {
			throw new Error(
				"provisional promotion receipt cannot qualify final-v1 data",
			);
		}
		return receipts as PromotionReceiptWire[];
	}

	async coverage(
		request: MarketDataVendorBackfillRequest,
	): Promise<QualifiedCoverage> {
		const parameters = queryParameters(request);
		const summaries = await this.client.query(
			`SELECT snapshot_id, source_time_ms, normalized_row_checksum
			 FROM ${QUALIFIED_SUMMARY}
			 WHERE ${scopeFilter()}
			   AND source_time_ms >= {coverage_start_ms:UInt64}
			   AND source_time_ms < {end_time_ms:UInt64}
			 ORDER BY source_time_ms, snapshot_id`,
			{
				...parameters,
				coverage_start_ms: Math.max(
					0,
					request.window.startTimeMs - request.maxPriorAsOfLagMs,
				),
			},
		);
		const [prefix, suffix] = await Promise.all([
			this.boundaryRows(request, "prefix"),
			this.boundaryRows(request, "suffix"),
		]);
		return {
			complete: clocksCovered(request, summaries),
			coverageDigest: timelineDigest(summaries),
			prefixDigest: timelineDigest(prefix),
			suffixDigest: timelineDigest(suffix),
		};
	}

	private boundaryRows(
		request: MarketDataVendorBackfillRequest,
		side: "prefix" | "suffix",
	): Promise<Record<string, unknown>[]> {
		const boundary =
			side === "prefix" ? request.window.startTimeMs : request.window.endTimeMs;
		const span = Math.max(
			request.maxPriorAsOfLagMs,
			request.budgets.maxBoundaryLookbackMs,
		);
		const boundaryStart =
			side === "prefix" ? Math.max(0, boundary - span) : boundary;
		const boundaryEnd =
			side === "prefix"
				? boundary
				: Math.min(Number.MAX_SAFE_INTEGER, boundary + span);
		return archiveQuery(
			this.client,
			"archive_boundary_query_failed",
			`SELECT 'level' AS table, snapshot_id, source_time_ms, sequence,
			        normalized_row_checksum
			 FROM ${QUALIFIED_LEVELS}
			 WHERE ${scopeFilter()}
			   AND source_time_ms >= {boundary_start_ms:UInt64}
			   AND source_time_ms < {boundary_end_ms:UInt64}
			 UNION ALL
			 SELECT 'summary' AS table, snapshot_id, source_time_ms, sequence,
			        normalized_row_checksum
			 FROM ${QUALIFIED_SUMMARY}
			 WHERE ${scopeFilter()}
			   AND source_time_ms >= {boundary_start_ms:UInt64}
			   AND source_time_ms < {boundary_end_ms:UInt64}
			 ORDER BY source_time_ms, table, snapshot_id, normalized_row_checksum`,
			{
				...queryParameters(request),
				boundary_start_ms: boundaryStart,
				boundary_end_ms: boundaryEnd,
			},
		);
	}

	async verifyCandidate(
		request: MarketDataVendorBackfillRequest,
		normalized: NormalizedBackfill,
		captureBundleId: string,
		baseline: ArchivePreflightResolution,
	): Promise<CandidateVerification> {
		if (!baseline.verificationBaseline) {
			throw new Error("qualified verification baseline is missing");
		}
		const parameters = {
			...queryParameters(request),
			capture_bundle_id: captureBundleId,
		};
		const [levels, summaries, conflicts, prefix, suffix] = await Promise.all([
			this.client.query(
				`SELECT * FROM ${CANDIDATE_LEVELS}
				 WHERE capture_bundle_id = {capture_bundle_id:String}
				   AND ${scopeFilter()}
				   AND source_time_ms >= {start_time_ms:UInt64}
				   AND source_time_ms < {end_time_ms:UInt64}`,
				parameters,
			),
			this.client.query(
				`SELECT * FROM ${CANDIDATE_SUMMARY}
				 WHERE capture_bundle_id = {capture_bundle_id:String}
				   AND ${scopeFilter()}
				   AND source_time_ms >= {start_time_ms:UInt64}
				   AND source_time_ms < {end_time_ms:UInt64}`,
				parameters,
			),
			this.client.query(
				`SELECT count() AS conflicts FROM
				 (
				   SELECT snapshot_id FROM market_data.cex_order_book_levels_conflicts
				   WHERE capture_bundle_id = {capture_bundle_id:String}
				   UNION ALL
				   SELECT snapshot_id FROM market_data.cex_order_book_depth_summary_conflicts
				   WHERE capture_bundle_id = {capture_bundle_id:String}
				 )`,
				parameters,
			),
			this.boundaryRows(request, "prefix"),
			this.boundaryRows(request, "suffix"),
		]);
		const queriedRows = [
			...candidateRows("market_data.cex_order_book_levels", levels),
			...candidateRows("market_data.cex_order_book_depth_summary", summaries),
		];
		const semantic = verifySemanticPromotion({
			request,
			normalizedRows: normalized.rows,
			candidateRows: queriedRows,
			conflictCount: Number(conflicts[0]?.conflicts ?? 0),
			prefixDigestBefore: baseline.verificationBaseline.prefixDigest,
			prefixDigestAfter: timelineDigest(prefix),
			suffixDigestBefore: baseline.verificationBaseline.suffixDigest,
			suffixDigestAfter: timelineDigest(suffix),
			seamVerified: this.seamIsOrdered(queriedRows),
			exporterCompatible: queriedRows.every(
				({ row }) =>
					typeof row.capture_bundle_id === "string" &&
					typeof row.normalized_row_checksum === "string",
			),
			...(request.sourcePolicy === "fill_gaps"
				? {
						coverageSourceTimesMs: [
							...baseline.selection.support_anchors.map((anchor) =>
								Date.parse(anchor.source_time),
							),
							...summaries.map((row) => numberField(row, "source_time_ms")),
						],
					}
				: {}),
		});
		return { ...semantic, captureBundleId };
	}

	private seamIsOrdered(rows: readonly BackfillArchiveRow[]): boolean {
		const summaries = rows
			.filter(({ table }) => table.endsWith("depth_summary"))
			.map(({ row }) => ({
				time: numberField(row, "source_time_ms"),
				sequence: uint64Field(row, "sequence"),
			}))
			.sort((left, right) => left.time - right.time);
		for (let index = 1; index < summaries.length; index += 1) {
			const previous = summaries[index - 1];
			const current = summaries[index];
			if (!previous || !current || current.time < previous.time) return false;
			if (
				previous.sequence !== undefined &&
				current.sequence !== undefined &&
				current.sequence < previous.sequence
			) {
				return false;
			}
		}
		return summaries.length > 0;
	}
}

export function createClickHouseArchiveQueryClient(input: {
	url: string;
	username?: string;
	password?: string;
	fetch?: typeof fetch;
}): ArchiveQueryClient {
	const request = input.fetch ?? fetch;
	const parameterValue = (value: ArchiveQueryValue): string => {
		if (!Array.isArray(value)) return String(value);
		return `[${value
			.map((entry) => {
				const jsonString = JSON.stringify(entry);
				return `'${jsonString.slice(1, -1).replaceAll("'", "\\'")}'`;
			})
			.join(",")}]`;
	};
	return {
		async query(sql, parameters = {}) {
			const endpoint = new URL(input.url);
			const embeddedUsername = decodeURIComponent(endpoint.username);
			const embeddedPassword = decodeURIComponent(endpoint.password);
			endpoint.username = "";
			endpoint.password = "";
			endpoint.searchParams.set("database", "market_data");
			for (const [key, value] of Object.entries(parameters)) {
				endpoint.searchParams.set(`param_${key}`, parameterValue(value));
			}
			const response = await request(endpoint, {
				method: "POST",
				headers: {
					"X-ClickHouse-User": input.username || embeddedUsername || "default",
					"X-ClickHouse-Key": input.password ?? embeddedPassword,
				},
				body: `${sql.trim()}\nFORMAT JSONEachRow`,
			});
			if (!response.ok) {
				throw new Error(`qualified_archive_query_failed:${response.status}`);
			}
			const text = (await response.text()).trim();
			return text
				? text
						.split("\n")
						.map((line) => JSON.parse(line) as Record<string, unknown>)
				: [];
		},
	};
}
