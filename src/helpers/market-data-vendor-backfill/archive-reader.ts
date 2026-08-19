import { sha256Canonical } from "../market-data-archive/capture-contract";
import type {
	BackfillArchiveRow,
	MarketDataVendorBackfillRequest,
} from "./contracts";
import type {
	CandidateVerification,
	NormalizedBackfill,
	QualifiedCoverage,
} from "./core";
import { verifySemanticPromotion } from "./semantic-verification";

export type ArchiveQueryValue = string | number | readonly string[];
export type ArchiveQueryClient = {
	query(
		sql: string,
		parameters?: Readonly<Record<string, ArchiveQueryValue>>,
	): Promise<Record<string, unknown>[]>;
};

const QUALIFIED_SUMMARY =
	"market_data.cex_order_book_depth_summary_replay_qualified";
const QUALIFIED_LEVELS = "market_data.cex_order_book_levels_replay_qualified";
const CANDIDATE_SUMMARY = "market_data.cex_order_book_depth_summary_canonical";
const CANDIDATE_LEVELS = "market_data.cex_order_book_levels_canonical";

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
	constructor(private readonly client: ArchiveQueryClient) {}

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
		return this.client.query(
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
		baseline: QualifiedCoverage,
	): Promise<CandidateVerification> {
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
			prefixDigestBefore: baseline.prefixDigest ?? sha256Canonical([]),
			prefixDigestAfter: timelineDigest(prefix),
			suffixDigestBefore: baseline.suffixDigest ?? sha256Canonical([]),
			suffixDigestAfter: timelineDigest(suffix),
			seamVerified: this.seamIsOrdered(queriedRows),
			exporterCompatible: queriedRows.every(
				({ row }) =>
					typeof row.capture_bundle_id === "string" &&
					typeof row.normalized_row_checksum === "string",
			),
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
	return {
		async query(sql, parameters = {}) {
			const endpoint = new URL(input.url);
			const embeddedUsername = decodeURIComponent(endpoint.username);
			const embeddedPassword = decodeURIComponent(endpoint.password);
			endpoint.username = "";
			endpoint.password = "";
			endpoint.searchParams.set("database", "market_data");
			for (const [key, value] of Object.entries(parameters)) {
				endpoint.searchParams.set(
					`param_${key}`,
					Array.isArray(value) ? JSON.stringify(value) : String(value),
				);
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
