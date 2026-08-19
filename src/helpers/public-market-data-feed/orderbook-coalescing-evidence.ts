import { createHash } from "node:crypto";
import { canonicalSerialize } from "../market-data-archive/capture-contract";
import type { OrderBookBandCoverage } from "./orderbook-profile";

export const CEX_ORDERBOOK_COALESCING_EVIDENCE_SCHEMA =
	"cex-orderbook-coalescing-evidence/v1" as const;

export type CexOrderBookEvidenceVenue = "binance" | "mexc";

export type CexPolicyVisibleOrderBookSnapshot = {
	bids: number[][];
	asks: number[][];
	timestamp: number;
	exchange: CexOrderBookEvidenceVenue;
	symbol: string;
	depthLimit: number;
};

export type CexOrderBookObservationEvidence = {
	index: number;
	conservative: {
		live: CexPolicyVisibleOrderBookSnapshot;
		rehydrated: CexPolicyVisibleOrderBookSnapshot;
	};
	coalesced: {
		live: CexPolicyVisibleOrderBookSnapshot;
		rehydrated: CexPolicyVisibleOrderBookSnapshot;
	};
	coverage: {
		conservativeLive: OrderBookBandCoverage[];
		conservativeRehydrated: OrderBookBandCoverage[];
		coalescedLive: OrderBookBandCoverage[];
		coalescedRehydrated: OrderBookBandCoverage[];
	};
	snapshotHashes: {
		conservativeLive: string;
		conservativeRehydrated: string;
		coalescedLive: string;
		coalescedRehydrated: string;
	};
};

export type CexOrderBookPhysicalWorkEvidence = {
	workers: number;
	watchIterations: number;
	frames: number;
	archiveDecisions: number;
};

export type CexOrderBookCoalescingCaseEvidence = {
	venue: CexOrderBookEvidenceVenue;
	profileId: string;
	observations: CexOrderBookObservationEvidence[];
	cexVerdicts: {
		logicalPayloadsEqual: true;
		canonicalArchiveEqual: true;
		liveReplayInputsEqual: true;
		bandCoverageComplete: true;
		reducedPhysicalWork: true;
		physicalWork: {
			conservative: CexOrderBookPhysicalWorkEvidence;
			coalesced: CexOrderBookPhysicalWorkEvidence;
		};
	};
	insufficientReplayCase: {
		archiveDepth: number;
		policyDepth: number;
		rejected: true;
		observations: Array<{
			index: number;
			coverage: OrderBookBandCoverage[];
			diagnostics: string[];
		}>;
	};
};

export type CexOrderBookCoalescingEvidence = {
	schemaVersion: typeof CEX_ORDERBOOK_COALESCING_EVIDENCE_SCHEMA;
	policyDepth: number;
	archiveDepth: number;
	bandsBps: number[];
	cases: [
		CexOrderBookCoalescingCaseEvidence,
		CexOrderBookCoalescingCaseEvidence,
	];
};

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
		throw new Error(`${label} uses an invalid field set`);
	}
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return Number(value);
}

function hash(value: unknown, label: string): void {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256`);
	}
}

function validateSnapshot(
	value: unknown,
	venue: CexOrderBookEvidenceVenue,
	policyDepth: number,
	label: string,
): void {
	const snapshot = record(value, label);
	exactKeys(
		snapshot,
		["bids", "asks", "timestamp", "exchange", "symbol", "depthLimit"],
		label,
	);
	if (snapshot.exchange !== venue || snapshot.depthLimit !== policyDepth) {
		throw new Error(`${label} identity or policy depth is invalid`);
	}
	if (
		!Array.isArray(snapshot.bids) ||
		!Array.isArray(snapshot.asks) ||
		!Number.isSafeInteger(snapshot.timestamp) ||
		typeof snapshot.symbol !== "string" ||
		!snapshot.symbol
	) {
		throw new Error(`${label} payload is invalid`);
	}
	for (const [side, levels] of [
		["bids", snapshot.bids],
		["asks", snapshot.asks],
	] as const) {
		if (levels.length < 1 || levels.length > policyDepth) {
			throw new Error(`${label}.${side} retained depth is invalid`);
		}
		for (const level of levels) {
			if (
				!Array.isArray(level) ||
				level.length < 2 ||
				!Number.isFinite(level[0]) ||
				!Number.isFinite(level[1])
			) {
				throw new Error(`${label}.${side} contains an invalid L2 level`);
			}
		}
	}
}

function validateCoverage(
	value: unknown,
	bandsBps: number[],
	label: string,
): void {
	if (!Array.isArray(value) || value.length !== bandsBps.length) {
		throw new Error(`${label} must cover every configured band`);
	}
	for (let index = 0; index < value.length; index += 1) {
		const coverage = record(value[index], `${label}[${index}]`);
		exactKeys(
			coverage,
			["covered", "mid", "bandBps", "bid", "ask", "diagnostics"],
			`${label}[${index}]`,
		);
		if (
			coverage.bandBps !== bandsBps[index] ||
			typeof coverage.covered !== "boolean" ||
			!Number.isFinite(coverage.mid) ||
			!Array.isArray(coverage.diagnostics) ||
			coverage.diagnostics.some((entry) => typeof entry !== "string")
		) {
			throw new Error(`${label}[${index}] is invalid`);
		}
		for (const side of ["bid", "ask"] as const) {
			const sideCoverage = record(coverage[side], `${label}[${index}].${side}`);
			exactKeys(
				sideCoverage,
				[
					"covered",
					"boundaryPrice",
					"farthestPrice",
					"retainedCount",
					"exhausted",
				],
				`${label}[${index}].${side}`,
			);
			if (
				typeof sideCoverage.covered !== "boolean" ||
				typeof sideCoverage.exhausted !== "boolean" ||
				!Number.isFinite(sideCoverage.boundaryPrice) ||
				!Number.isFinite(sideCoverage.farthestPrice)
			) {
				throw new Error(`${label}[${index}].${side} is invalid`);
			}
			nonNegativeInteger(
				sideCoverage.retainedCount,
				`${label}[${index}].${side}.retainedCount`,
			);
		}
	}
}

function validatePhysicalWork(value: unknown, label: string): void {
	const work = record(value, label);
	exactKeys(
		work,
		["workers", "watchIterations", "frames", "archiveDecisions"],
		label,
	);
	for (const key of [
		"workers",
		"watchIterations",
		"frames",
		"archiveDecisions",
	] as const) {
		positiveInteger(work[key], `${label}.${key}`);
	}
}

function validateCase(
	value: unknown,
	venue: CexOrderBookEvidenceVenue,
	policyDepth: number,
	bandsBps: number[],
): void {
	const label = `cases.${venue}`;
	const item = record(value, label);
	exactKeys(
		item,
		[
			"venue",
			"profileId",
			"observations",
			"cexVerdicts",
			"insufficientReplayCase",
		],
		label,
	);
	if (item.venue !== venue || item.profileId !== `${venue}:l2-diff:500`) {
		throw new Error(`${label} venue or profile identity is invalid`);
	}
	if (!Array.isArray(item.observations) || item.observations.length < 5) {
		throw new Error(`${label}.observations must contain at least five frames`);
	}
	for (let index = 0; index < item.observations.length; index += 1) {
		const observationLabel = `${label}.observations[${index}]`;
		const observation = record(item.observations[index], observationLabel);
		exactKeys(
			observation,
			["index", "conservative", "coalesced", "coverage", "snapshotHashes"],
			observationLabel,
		);
		if (observation.index !== index) {
			throw new Error(`${observationLabel}.index is not ordered`);
		}
		for (const composition of ["conservative", "coalesced"] as const) {
			const snapshots = record(
				observation[composition],
				`${observationLabel}.${composition}`,
			);
			exactKeys(
				snapshots,
				["live", "rehydrated"],
				`${observationLabel}.${composition}`,
			);
			validateSnapshot(
				snapshots.live,
				venue,
				policyDepth,
				`${observationLabel}.${composition}.live`,
			);
			validateSnapshot(
				snapshots.rehydrated,
				venue,
				policyDepth,
				`${observationLabel}.${composition}.rehydrated`,
			);
		}
		const coverages = record(
			observation.coverage,
			`${observationLabel}.coverage`,
		);
		const coverageKeys = [
			"conservativeLive",
			"conservativeRehydrated",
			"coalescedLive",
			"coalescedRehydrated",
		] as const;
		exactKeys(coverages, coverageKeys, `${observationLabel}.coverage`);
		for (const key of coverageKeys) {
			validateCoverage(
				coverages[key],
				bandsBps,
				`${observationLabel}.coverage.${key}`,
			);
		}
		const hashes = record(
			observation.snapshotHashes,
			`${observationLabel}.snapshotHashes`,
		);
		exactKeys(hashes, coverageKeys, `${observationLabel}.snapshotHashes`);
		for (const key of coverageKeys) {
			hash(hashes[key], `${observationLabel}.snapshotHashes.${key}`);
		}
	}

	const verdicts = record(item.cexVerdicts, `${label}.cexVerdicts`);
	exactKeys(
		verdicts,
		[
			"logicalPayloadsEqual",
			"canonicalArchiveEqual",
			"liveReplayInputsEqual",
			"bandCoverageComplete",
			"reducedPhysicalWork",
			"physicalWork",
		],
		`${label}.cexVerdicts`,
	);
	for (const key of [
		"logicalPayloadsEqual",
		"canonicalArchiveEqual",
		"liveReplayInputsEqual",
		"bandCoverageComplete",
		"reducedPhysicalWork",
	] as const) {
		if (verdicts[key] !== true) {
			throw new Error(`${label}.cexVerdicts.${key} did not pass`);
		}
	}
	const physicalWork = record(
		verdicts.physicalWork,
		`${label}.cexVerdicts.physicalWork`,
	);
	exactKeys(
		physicalWork,
		["conservative", "coalesced"],
		`${label}.cexVerdicts.physicalWork`,
	);
	validatePhysicalWork(
		physicalWork.conservative,
		`${label}.cexVerdicts.physicalWork.conservative`,
	);
	validatePhysicalWork(
		physicalWork.coalesced,
		`${label}.cexVerdicts.physicalWork.coalesced`,
	);

	const insufficient = record(
		item.insufficientReplayCase,
		`${label}.insufficientReplayCase`,
	);
	exactKeys(
		insufficient,
		["archiveDepth", "policyDepth", "rejected", "observations"],
		`${label}.insufficientReplayCase`,
	);
	if (
		positiveInteger(
			insufficient.archiveDepth,
			`${label}.insufficientReplayCase.archiveDepth`,
		) >= policyDepth ||
		insufficient.policyDepth !== policyDepth ||
		insufficient.rejected !== true ||
		!Array.isArray(insufficient.observations) ||
		insufficient.observations.length < 1
	) {
		throw new Error(`${label}.insufficientReplayCase is invalid`);
	}
	for (let index = 0; index < insufficient.observations.length; index += 1) {
		const observationLabel = `${label}.insufficientReplayCase.observations[${index}]`;
		const observation = record(
			insufficient.observations[index],
			observationLabel,
		);
		exactKeys(
			observation,
			["index", "coverage", "diagnostics"],
			observationLabel,
		);
		if (
			observation.index !== index ||
			!Array.isArray(observation.diagnostics) ||
			observation.diagnostics.length < 1 ||
			observation.diagnostics.some((entry) => typeof entry !== "string")
		) {
			throw new Error(`${observationLabel} is invalid`);
		}
		validateCoverage(
			observation.coverage,
			bandsBps,
			`${observationLabel}.coverage`,
		);
		if (
			!(observation.coverage as Array<{ covered?: unknown }>).some(
				(entry) => entry.covered === false,
			)
		) {
			throw new Error(`${observationLabel} does not demonstrate insufficiency`);
		}
	}
}

export function validateCexOrderBookCoalescingEvidence(
	value: unknown,
): CexOrderBookCoalescingEvidence {
	const evidence = record(value, "CEX Proof A");
	exactKeys(
		evidence,
		["schemaVersion", "policyDepth", "archiveDepth", "bandsBps", "cases"],
		"CEX Proof A",
	);
	if (evidence.schemaVersion !== CEX_ORDERBOOK_COALESCING_EVIDENCE_SCHEMA) {
		throw new Error("CEX Proof A schema is unsupported");
	}
	const policyDepth = positiveInteger(evidence.policyDepth, "policyDepth");
	if (policyDepth !== 100)
		throw new Error("CEX Proof A policyDepth must be 100");
	if (positiveInteger(evidence.archiveDepth, "archiveDepth") < policyDepth) {
		throw new Error("CEX Proof A archiveDepth is below policyDepth");
	}
	if (
		!Array.isArray(evidence.bandsBps) ||
		evidence.bandsBps.length < 1 ||
		evidence.bandsBps.some(
			(band) => !Number.isFinite(band) || Number(band) <= 0,
		)
	) {
		throw new Error("CEX Proof A bandsBps is invalid");
	}
	if (
		!Array.isArray(evidence.cases) ||
		evidence.cases.length !== 2 ||
		(evidence.cases[0] as { venue?: unknown })?.venue !== "binance" ||
		(evidence.cases[1] as { venue?: unknown })?.venue !== "mexc"
	) {
		throw new Error("CEX Proof A cases must be ordered Binance then MEXC");
	}
	const bandsBps = evidence.bandsBps.map(Number);
	validateCase(evidence.cases[0], "binance", policyDepth, bandsBps);
	validateCase(evidence.cases[1], "mexc", policyDepth, bandsBps);
	return evidence as CexOrderBookCoalescingEvidence;
}

export function serializeCexOrderBookCoalescingEvidence(
	value: unknown,
): Uint8Array {
	const evidence = validateCexOrderBookCoalescingEvidence(value);
	return Buffer.from(`${canonicalSerialize(evidence)}\n`, "utf8");
}

export function sha256CexOrderBookCoalescingEvidence(value: unknown): string {
	return createHash("sha256")
		.update(serializeCexOrderBookCoalescingEvidence(value))
		.digest("hex");
}
