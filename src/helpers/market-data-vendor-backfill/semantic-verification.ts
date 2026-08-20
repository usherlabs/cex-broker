import { sha256Canonical } from "../market-data-archive/capture-contract";
import type {
	BackfillArchiveRow,
	MarketDataVendorBackfillRequest,
} from "./contracts";

const LOGICAL_KEYS = {
	"market_data.cex_order_book_levels": [
		"capture_bundle_id",
		"exchange",
		"trading_pair",
		"raw_capture_id",
		"snapshot_id",
		"schema_version",
		"side",
		"level_index",
	],
	"market_data.cex_order_book_depth_summary": [
		"capture_bundle_id",
		"exchange",
		"trading_pair",
		"raw_capture_id",
		"snapshot_id",
		"schema_version",
	],
} as const;

function logicalIdentity(row: BackfillArchiveRow): {
	key: string;
	checksum: string;
} {
	if (row.table === "market_data.cex_order_book_capture_promotions") {
		throw new Error("promotion rows are not candidate semantic evidence");
	}
	const keys = LOGICAL_KEYS[row.table];
	const checksum = row.row.normalized_row_checksum;
	if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) {
		throw new Error("candidate normalized checksum is invalid");
	}
	const values = keys.map((key) => row.row[key]);
	if (
		values.some(
			(value) =>
				typeof value !== "string" &&
				typeof value !== "number" &&
				value !== null,
		)
	) {
		throw new Error("candidate logical identity is incomplete");
	}
	return {
		key: `${row.table}\u0000${JSON.stringify(values)}`,
		checksum,
	};
}

export function semanticDigest(rows: readonly BackfillArchiveRow[]): string {
	const identities = rows
		.map(logicalIdentity)
		.sort((left, right) =>
			left.key === right.key
				? left.checksum.localeCompare(right.checksum)
				: left.key.localeCompare(right.key),
		);
	return sha256Canonical(identities);
}

function exactCandidateMatch(
	expected: readonly BackfillArchiveRow[],
	actual: readonly BackfillArchiveRow[],
): boolean {
	if (expected.length !== actual.length) return false;
	const expectedIdentities = expected
		.map(logicalIdentity)
		.map(({ key, checksum }) => `${key}\u0000${checksum}`)
		.sort();
	const actualIdentities = actual
		.map(logicalIdentity)
		.map(({ key, checksum }) => `${key}\u0000${checksum}`)
		.sort();
	return expectedIdentities.every(
		(identity, index) => identity === actualIdentities[index],
	);
}

function requestedShapeMatches(
	request: MarketDataVendorBackfillRequest,
	rows: readonly BackfillArchiveRow[],
): boolean {
	return rows.every(
		({ row }) =>
			row.depth_limit === request.depth &&
			row.construction_mode === request.constructionMode &&
			row.schema_version === request.expectedProduct.canonicalSchemaVersion,
	);
}

function requiredClockCoverage(
	request: MarketDataVendorBackfillRequest,
	rows: readonly BackfillArchiveRow[],
): boolean {
	const summaryTimes = rows
		.filter(({ table }) => table === "market_data.cex_order_book_depth_summary")
		.map(({ row }) => {
			const value = row.source_time_ms;
			if (
				typeof value !== "number" &&
				(typeof value !== "string" || !/^\d+$/.test(value))
			) {
				return undefined;
			}
			const parsed = Number(value);
			return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
		})
		.filter((value): value is number => value !== undefined)
		.sort((left, right) => left - right);
	return request.requiredClockTargetsMs.every((target) => {
		let prior: number | undefined;
		for (const sourceTime of summaryTimes) {
			if (sourceTime > target) break;
			prior = sourceTime;
		}
		return (
			prior !== undefined &&
			target - prior >= 0 &&
			target - prior <= request.maxPriorAsOfLagMs
		);
	});
}

export type SemanticPromotionEvidence = {
	request: MarketDataVendorBackfillRequest;
	normalizedRows: readonly BackfillArchiveRow[];
	candidateRows: readonly BackfillArchiveRow[];
	conflictCount: number;
	prefixDigestBefore: string;
	prefixDigestAfter: string;
	suffixDigestBefore: string;
	suffixDigestAfter: string;
	seamVerified: boolean;
	exporterCompatible: boolean;
};

export type SemanticPromotionResult = {
	passed: boolean;
	reasonCode: string;
	canonicalSemanticDigest: string;
	prefixDigest: string;
	suffixDigest: string;
	seamVerified: boolean;
	coverageVerified: boolean;
};

export function verifySemanticPromotion(
	evidence: SemanticPromotionEvidence,
): SemanticPromotionResult {
	const canonicalSemanticDigest = semanticDigest(evidence.candidateRows);
	const base = {
		canonicalSemanticDigest,
		prefixDigest: evidence.prefixDigestAfter,
		suffixDigest: evidence.suffixDigestAfter,
		seamVerified: evidence.seamVerified,
	};
	if (!exactCandidateMatch(evidence.normalizedRows, evidence.candidateRows)) {
		return {
			...base,
			passed: false,
			reasonCode: "candidate_semantic_mismatch",
			coverageVerified: false,
		};
	}
	if (evidence.conflictCount !== 0) {
		return {
			...base,
			passed: false,
			reasonCode: "candidate_checksum_conflict",
			coverageVerified: false,
		};
	}
	if (
		evidence.prefixDigestBefore !== evidence.prefixDigestAfter ||
		evidence.suffixDigestBefore !== evidence.suffixDigestAfter
	) {
		return {
			...base,
			passed: false,
			reasonCode: "qualified_timeline_changed",
			coverageVerified: false,
		};
	}
	if (!evidence.seamVerified) {
		return {
			...base,
			passed: false,
			reasonCode: "timeline_seam_invalid",
			coverageVerified: false,
		};
	}
	if (!requestedShapeMatches(evidence.request, evidence.candidateRows)) {
		return {
			...base,
			passed: false,
			reasonCode: "candidate_shape_mismatch",
			coverageVerified: false,
		};
	}
	if (!evidence.exporterCompatible) {
		return {
			...base,
			passed: false,
			reasonCode: "canonical_export_incompatible",
			coverageVerified: false,
		};
	}
	const coverageVerified = requiredClockCoverage(
		evidence.request,
		evidence.candidateRows,
	);
	if (!coverageVerified) {
		return {
			...base,
			passed: false,
			reasonCode: "required_clock_coverage_insufficient",
			coverageVerified: false,
		};
	}
	return {
		...base,
		passed: true,
		reasonCode: "semantic_promotion_verified",
		coverageVerified: true,
	};
}
