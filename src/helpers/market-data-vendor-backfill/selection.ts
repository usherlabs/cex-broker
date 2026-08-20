import {
	ARCHIVE_SELECTION_SCHEMA_ID,
	type ArchiveSelectionWire,
	archiveSelectionCodec,
	type BackfillArchiveRow,
	type BackfillRequestWire,
	backfillRequestCodec,
	finalizeArchiveSelection,
	type MarketDataVendorBackfillRequest,
} from "./contracts";
import { jcsCanonicalize, jcsSha256 } from "./identity";

export type ArchiveQualificationEvidence = {
	qualificationEventId: string;
	state: "qualified" | "quarantined" | "revoked";
	receiptId: string;
	promotionIdentitySha256: string;
};

export type ArchiveSupportAnchorEvidence = {
	captureBundleId: string;
	rawCaptureId: string;
	snapshotId: string;
	sourceTimeMs: number;
	normalizedSummaryChecksum: string;
};

export type ArchiveBundleEvidence = {
	captureBundleId: string;
	captureOrigin: "production_capture" | "vendor_historical_backfill";
	startTimeMs: number;
	endTimeMs: number;
	qualification: ArchiveQualificationEvidence | null;
	supportAnchors: ArchiveSupportAnchorEvidence[];
};

function fixedTimestamp(timestampMs: number, field: string): string {
	if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
	return new Date(timestampMs).toISOString();
}

function assertStoredSelectionMatchesRequest(
	request: MarketDataVendorBackfillRequest,
	selection: ArchiveSelectionWire,
): void {
	if (!request.requiredClock || !request.coveragePolicy) {
		throw new Error("decoded request is missing final-v1 selection context");
	}
	const expectedScope = {
		exchange: request.scope.exchange,
		trading_pair: request.scope.tradingPair,
		market_type: request.scope.marketType,
		feed: request.scope.feed,
	};
	if (
		jcsSha256(selection.scope) !== jcsSha256(expectedScope) ||
		selection.required_clock.clock_id !== request.requiredClock.clock_id ||
		selection.required_clock.clock_sha256 !==
			request.requiredClock.clock_sha256 ||
		selection.required_clock.event_count !==
			request.requiredClock.targets.length ||
		jcsSha256(selection.coverage_policy) !==
			jcsSha256(request.coveragePolicy) ||
		selection.source_policy !== request.sourcePolicy
	) {
		throw new Error("stored archive selection conflicts with request content");
	}
}

function eligibleBundles(
	request: MarketDataVendorBackfillRequest,
	bundles: readonly ArchiveBundleEvidence[],
): ArchiveBundleEvidence[] {
	return bundles.filter((bundle) => {
		if (bundle.captureOrigin === "production_capture") {
			return request.sourcePolicy === "fill_gaps";
		}
		return bundle.qualification?.state === "qualified";
	});
}

function originPriority(
	request: MarketDataVendorBackfillRequest,
	origin: ArchiveBundleEvidence["captureOrigin"],
): number {
	if (request.sourcePolicy === "fill_gaps") {
		return origin === "production_capture" ? 0 : 1;
	}
	return 0;
}

function chooseSupport(
	request: MarketDataVendorBackfillRequest,
	bundles: readonly ArchiveBundleEvidence[],
): Array<{
	bundle: ArchiveBundleEvidence;
	anchor: ArchiveSupportAnchorEvidence;
}> {
	return request.requiredClockTargetsMs.flatMap((targetTimeMs) => {
		const candidates = bundles.flatMap((bundle) =>
			bundle.supportAnchors
				.filter(
					(anchor) =>
						anchor.captureBundleId === bundle.captureBundleId &&
						anchor.sourceTimeMs <= targetTimeMs &&
						targetTimeMs - anchor.sourceTimeMs <= request.maxPriorAsOfLagMs,
				)
				.map((anchor) => ({ bundle, anchor })),
		);
		candidates.sort((left, right) => {
			const origin =
				originPriority(request, left.bundle.captureOrigin) -
				originPriority(request, right.bundle.captureOrigin);
			if (origin !== 0) return origin;
			if (left.anchor.sourceTimeMs !== right.anchor.sourceTimeMs) {
				return right.anchor.sourceTimeMs - left.anchor.sourceTimeMs;
			}
			return left.bundle.captureBundleId.localeCompare(
				right.bundle.captureBundleId,
			);
		});
		return candidates[0] ? [candidates[0]] : [];
	});
}

export function resolveArchiveSelection(input: {
	request: MarketDataVendorBackfillRequest;
	bundles: readonly ArchiveBundleEvidence[];
	resolvedAtMs: number;
	storedSelection?: unknown;
}): ArchiveSelectionWire {
	if (input.storedSelection !== undefined) {
		const stored = archiveSelectionCodec.decode(input.storedSelection);
		assertStoredSelectionMatchesRequest(input.request, stored);
		return stored;
	}
	const { request } = input;
	if (!request.requiredClock || !request.coveragePolicy) {
		throw new Error("decoded request is missing final-v1 selection context");
	}
	const eligible = eligibleBundles(request, input.bundles);
	const chosenSupport = chooseSupport(request, eligible);
	const selectedBundleIds = new Set(
		chosenSupport.map(({ bundle }) => bundle.captureBundleId),
	);
	const selectedBundles = eligible
		.filter((bundle) => selectedBundleIds.has(bundle.captureBundleId))
		.sort((left, right) => {
			const origin =
				originPriority(request, left.captureOrigin) -
				originPriority(request, right.captureOrigin);
			return (
				origin || left.captureBundleId.localeCompare(right.captureBundleId)
			);
		});
	const supportByIdentity = new Map<string, (typeof chosenSupport)[number]>();
	for (const support of chosenSupport) {
		const identity = `${support.bundle.captureBundleId}:${support.anchor.rawCaptureId}:${support.anchor.snapshotId}:${support.anchor.sourceTimeMs}`;
		supportByIdentity.set(identity, support);
	}
	const supportAnchors = [...supportByIdentity.values()]
		.sort(
			(left, right) =>
				left.anchor.sourceTimeMs - right.anchor.sourceTimeMs ||
				left.bundle.captureBundleId.localeCompare(right.bundle.captureBundleId),
		)
		.map(({ bundle, anchor }) => ({
			capture_bundle_id: bundle.captureBundleId,
			raw_capture_id: anchor.rawCaptureId,
			snapshot_id: anchor.snapshotId,
			source_time: fixedTimestamp(anchor.sourceTimeMs, "support anchor time"),
			normalized_summary_checksum: anchor.normalizedSummaryChecksum,
			metadata_ref: {
				capture_origin: bundle.captureOrigin,
				qualification_event_id:
					bundle.qualification?.qualificationEventId ?? null,
				receipt_id: bundle.qualification?.receiptId ?? null,
			},
		}));
	const coverageClass =
		chosenSupport.length === request.requiredClockTargetsMs.length
			? "complete"
			: eligible.length === 0
				? "missing"
				: "partial";
	const requestStart = request.window.startTimeMs;
	const requestEnd = request.window.endTimeMs;
	return finalizeArchiveSelection({
		schema_id: ARCHIVE_SELECTION_SCHEMA_ID,
		scope: {
			exchange: request.scope.exchange,
			trading_pair: request.scope.tradingPair,
			market_type: request.scope.marketType,
			feed: request.scope.feed,
		},
		required_clock: {
			clock_id: request.requiredClock.clock_id,
			clock_sha256: request.requiredClock.clock_sha256,
			event_count: request.requiredClock.targets.length,
		},
		coverage_policy: request.coveragePolicy,
		source_policy: request.sourcePolicy,
		coverage_class: coverageClass,
		requested_intervals: [
			{
				start_at: fixedTimestamp(requestStart, "window start"),
				end_at: fixedTimestamp(requestEnd, "window end"),
			},
		],
		selected_intervals: selectedBundles.map((bundle) => ({
			start_at: fixedTimestamp(
				Math.max(requestStart, bundle.startTimeMs),
				"selected interval start",
			),
			end_at: fixedTimestamp(
				Math.min(requestEnd, bundle.endTimeMs),
				"selected interval end",
			),
			capture_bundle_id: bundle.captureBundleId,
			capture_origin: bundle.captureOrigin,
		})),
		precedence:
			request.sourcePolicy === "fill_gaps" ? ["archive", "vendor"] : ["vendor"],
		bundles: selectedBundles.map((bundle) => ({
			capture_bundle_id: bundle.captureBundleId,
			capture_origin: bundle.captureOrigin,
			interval: {
				start_at: fixedTimestamp(bundle.startTimeMs, "bundle interval start"),
				end_at: fixedTimestamp(bundle.endTimeMs, "bundle interval end"),
			},
			qualification: bundle.qualification
				? {
						qualification_event_id: bundle.qualification.qualificationEventId,
						state: "qualified" as const,
						receipt_id: bundle.qualification.receiptId,
						promotion_identity_sha256:
							bundle.qualification.promotionIdentitySha256,
					}
				: null,
		})),
		support_anchors: supportAnchors,
		receipt_ids: [
			...new Set(
				selectedBundles.flatMap((bundle) =>
					bundle.qualification ? [bundle.qualification.receiptId] : [],
				),
			),
		].sort(),
		qualification_event_ids: [
			...new Set(
				selectedBundles.flatMap((bundle) =>
					bundle.qualification
						? [bundle.qualification.qualificationEventId]
						: [],
				),
			),
		].sort(),
		resolved_at: fixedTimestamp(input.resolvedAtMs, "resolved_at"),
	});
}

export function archiveSelectionToArchiveRow(
	request: BackfillRequestWire,
	selectionInput: ArchiveSelectionWire,
): BackfillArchiveRow {
	const selection = archiveSelectionCodec.decode(selectionInput);
	if (
		selection.required_clock.clock_sha256 !==
			request.required_clock.clock_sha256 ||
		selection.source_policy !== request.source_policy ||
		jcsSha256(selection.scope) !== jcsSha256(request.scope) ||
		jcsSha256(selection.coverage_policy) !== jcsSha256(request.coverage_policy)
	) {
		throw new Error("archive selection does not match request");
	}
	return {
		table: "market_data.cex_order_book_archive_selections",
		row: {
			source: "external_backfill",
			deployment_id: "market-data-vendor-backfill",
			request_id: request.request_id,
			idempotency_key: request.idempotency_key,
			selection_sha256: selection.selection_sha256,
			coverage_class: selection.coverage_class,
			receipt_ids: selection.receipt_ids,
			request_json: jcsCanonicalize(request),
			selection_json: jcsCanonicalize(selection),
			resolved_at_ms: Date.parse(selection.resolved_at),
		},
	};
}

export function archiveSelectionFromArchiveRow(
	row: Record<string, unknown>,
): ArchiveSelectionWire {
	let parsed: unknown;
	let parsedRequest: unknown;
	try {
		parsed = JSON.parse(String(row.selection_json));
		parsedRequest = JSON.parse(String(row.request_json));
	} catch {
		throw new Error("archive selection or request JSON is invalid");
	}
	const selection = archiveSelectionCodec.decode(parsed);
	const request = backfillRequestCodec.decode(parsedRequest).wire;
	archiveSelectionToArchiveRow(request, selection);
	if (
		row.source !== "external_backfill" ||
		row.deployment_id !== "market-data-vendor-backfill" ||
		row.request_id !== request.request_id ||
		row.idempotency_key !== request.idempotency_key ||
		row.selection_sha256 !== selection.selection_sha256 ||
		row.coverage_class !== selection.coverage_class ||
		jcsCanonicalize(row.receipt_ids) !==
			jcsCanonicalize(selection.receipt_ids) ||
		row.resolved_at_ms !== Date.parse(selection.resolved_at)
	) {
		throw new Error("archive selection row does not match selection JSON");
	}
	return selection;
}
