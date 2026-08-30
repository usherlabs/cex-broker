import { createHash } from "node:crypto";
import path from "node:path";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import {
	SOURCE_FORENSICS_LEDGER_SCHEMA_ID,
	SOURCE_QUALIFICATION_RECORD_SCHEMA_ID,
} from "./market-data-preparation/contracts";
import {
	assertSidecarBasename,
	atomicWriteJsonResult,
	writeExclusiveDurableFile,
} from "./market-data-preparation/file-job";
import sourceForensicsLedgerSchema from "./market-data-preparation/schemas/source-forensics-ledger.schema.json" with {
	type: "json",
};
import sourceQualificationRecordSchema from "./market-data-preparation/schemas/source-qualification-record.schema.json" with {
	type: "json",
};
import type {
	CanonicalScopeWire,
	LowercaseUuid,
	Sha256Hex,
} from "./market-data-vendor-backfill/contracts";
import {
	assertDocumentSha256,
	documentSha256,
	jcsCanonicalize,
} from "./market-data-vendor-backfill/identity";
import type { PolicyPin } from "./market-data-vendor-backfill/manifests";

export const SOURCE_FORENSICS_MAX_RECORDS = 100_000;
export const SOURCE_FORENSICS_MAX_CANONICAL_JSON_BYTES = 67_108_864;
export const SOURCE_FORENSICS_RECORD_KINDS = [
	"sequence_discontinuity",
	"unanchored_target_interval",
	"stale_target_interval",
	"future_state_interval",
	"provider_object_checksum_conflict",
] as const;
export const SOURCE_FORENSICS_CLASSIFICATIONS = [
	"stable_object_corruption",
	"mutable_provider_bytes",
	"provider_row_loss",
	"object_boundary_order_defect",
	"valid_inactive_market_state",
	"unresolved",
] as const;

export type SourceForensicsRecordKind =
	(typeof SOURCE_FORENSICS_RECORD_KINDS)[number];
export type SourceForensicsClassification =
	(typeof SOURCE_FORENSICS_CLASSIFICATIONS)[number];
export type SourceObjectEvidence = {
	identity: string;
	checksums: Sha256Hex[];
	attempt_count: number;
	quarantined: boolean;
};
export type SourceAnchorEvidence = {
	event_time_ms: number;
	sequence: string;
	object_identity: string;
	object_checksum: Sha256Hex;
};
export type SourceTargetInterval = {
	start_target_time_ms: number;
	end_target_time_ms_exclusive: number;
	target_count: number;
};
export type SourceLagDistribution = {
	lag_1000_ms: number;
	lag_2000_ms: number;
	lag_5000_ms: number;
	lag_10000_ms: number;
	lag_30000_ms: number;
	lag_60000_ms: number;
};
export type SourceForensicsRecordWire = {
	record_sha256: Sha256Hex;
	kind: SourceForensicsRecordKind;
	scope: CanonicalScopeWire;
	provider_objects: SourceObjectEvidence[];
	previous_anchor: SourceAnchorEvidence | null;
	next_anchor: SourceAnchorEvidence | null;
	target_interval: SourceTargetInterval | null;
	lag_distribution: SourceLagDistribution | null;
	sequence: null | {
		expected_previous: string;
		observed_previous: string;
		observed_final: string;
		event_time_ms: number;
	};
	classification: SourceForensicsClassification | null;
	adapter_version: string;
};

export type SourceForensicsLedgerWire = {
	schema_id: typeof SOURCE_FORENSICS_LEDGER_SCHEMA_ID;
	ledger_sha256: Sha256Hex;
	request_id: LowercaseUuid;
	idempotency_key: Sha256Hex;
	scope: CanonicalScopeWire;
	required_clock: {
		clock_id: LowercaseUuid;
		clock_sha256: Sha256Hex;
		event_count: number;
	};
	effective_policies: {
		capability_policy: PolicyPin;
		resource_policy: PolicyPin;
		adapter_policy: PolicyPin;
		acquisition_policy: PolicyPin;
	};
	provider_objects: SourceObjectEvidence[];
	records: SourceForensicsRecordWire[];
	summary: {
		retained_record_count: number;
		total_record_count: number;
		omitted_record_count: number;
		affected_target_count: number;
		unresolved_record_count: number;
	};
	limits: {
		max_records: typeof SOURCE_FORENSICS_MAX_RECORDS;
		max_canonical_json_bytes: typeof SOURCE_FORENSICS_MAX_CANONICAL_JSON_BYTES;
	};
	complete: boolean;
	incomplete_reason: "forensics_evidence_bound_exceeded" | null;
};

export type SourceQualificationRecordWire = {
	schema_id: typeof SOURCE_QUALIFICATION_RECORD_SCHEMA_ID;
	record_sha256: Sha256Hex;
	created_at: string;
	request_id: LowercaseUuid;
	scope: CanonicalScopeWire;
	ledger: {
		schema_id: typeof SOURCE_FORENSICS_LEDGER_SCHEMA_ID;
		file_name: string;
		sha256: Sha256Hex;
		bytes: number;
		retained_record_count: number;
		total_record_count: number;
		omitted_record_count: number;
		complete: boolean;
	};
	qualified: boolean;
};

function describeAjvErrors(errors: ErrorObject[] | null | undefined): string {
	return (errors ?? [])
		.map((error) => `${error.instancePath || "/"} ${error.message}`)
		.join("; ");
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateLedger = ajv.compile(sourceForensicsLedgerSchema);
const validateQualification = ajv.compile(sourceQualificationRecordSchema);

function assertSecretFree(value: unknown): void {
	const serialized = JSON.stringify(value).toLowerCase();
	for (const forbidden of [
		"api_key",
		"apikey",
		"authorization",
		"bearer ",
		"response_body",
		"provider_rows",
		"clickhouse_password",
		"archive_forwarder_token",
	]) {
		if (serialized.includes(forbidden)) {
			throw new Error("source-forensics evidence contains forbidden material");
		}
	}
}

export const sourceForensicsLedgerCodec = {
	decode(value: unknown): SourceForensicsLedgerWire {
		if (!validateLedger(value)) {
			throw new Error(
				`source-forensics ledger validation failed: ${describeAjvErrors(validateLedger.errors)}`,
			);
		}
		const ledger = value as SourceForensicsLedgerWire;
		assertDocumentSha256(ledger, "ledger_sha256");
		for (const record of ledger.records) {
			assertDocumentSha256(record, "record_sha256");
		}
		const ordered = [...ledger.records].sort((left, right) =>
			jcsCanonicalize(left).localeCompare(jcsCanonicalize(right)),
		);
		if (JSON.stringify(ordered) !== JSON.stringify(ledger.records)) {
			throw new Error("source-forensics records are not deterministic");
		}
		if (
			ledger.summary.retained_record_count !== ledger.records.length ||
			ledger.summary.total_record_count !==
				ledger.summary.retained_record_count +
					ledger.summary.omitted_record_count ||
			ledger.complete === (ledger.incomplete_reason !== null)
		) {
			throw new Error("source-forensics summary is inconsistent");
		}
		if (
			new TextEncoder().encode(jcsCanonicalize(ledger)).byteLength >
			SOURCE_FORENSICS_MAX_CANONICAL_JSON_BYTES
		) {
			throw new Error(
				"source-forensics ledger exceeds its canonical byte limit",
			);
		}
		assertSecretFree(ledger);
		return ledger;
	},
};

export const sourceQualificationRecordCodec = {
	decode(value: unknown): SourceQualificationRecordWire {
		if (!validateQualification(value)) {
			throw new Error(
				`source qualification validation failed: ${describeAjvErrors(validateQualification.errors)}`,
			);
		}
		const record = value as SourceQualificationRecordWire;
		assertDocumentSha256(record, "record_sha256");
		assertSidecarBasename(record.ledger.file_name);
		if (record.qualified && !record.ledger.complete) {
			throw new Error("incomplete ledger cannot qualify");
		}
		assertSecretFree(record);
		return record;
	},
};

function finalizeRecord(
	content: Omit<SourceForensicsRecordWire, "record_sha256">,
): SourceForensicsRecordWire {
	return {
		...content,
		record_sha256: documentSha256(content, "record_sha256"),
	};
}

export function finalizeSourceForensicsLedger(
	content: Omit<SourceForensicsLedgerWire, "ledger_sha256">,
): SourceForensicsLedgerWire {
	return sourceForensicsLedgerCodec.decode({
		...content,
		ledger_sha256: documentSha256(content, "ledger_sha256"),
	});
}

export function finalizeSourceQualificationRecord(
	content: Omit<SourceQualificationRecordWire, "record_sha256">,
): SourceQualificationRecordWire {
	return sourceQualificationRecordCodec.decode({
		...content,
		record_sha256: documentSha256(content, "record_sha256"),
	});
}

export type ReconstructionObservation =
	| { type: "provider_object_boundary"; object: SourceObjectEvidence }
	| { type: "snapshot_anchor" | "reanchor"; anchor: SourceAnchorEvidence }
	| {
			type: "sequence_discontinuity";
			sequence: NonNullable<SourceForensicsRecordWire["sequence"]>;
			object: SourceObjectEvidence;
	  }
	| {
			type: "required_clock_sample";
			target_time_ms: number;
			source_time_ms: number | null;
			lag_ms: number | null;
			status: "covered" | "unanchored" | "stale" | "future";
			object: SourceObjectEvidence | null;
	  }
	| { type: "invalidation"; event_time_ms: number; reason: string }
	| {
			type: "provider_object_checksum_conflict";
			object: SourceObjectEvidence;
			affected_target_times_ms: readonly number[];
	  };

export interface ReconstructionObservationSink {
	observe(observation: ReconstructionObservation): void;
}

export const NOOP_RECONSTRUCTION_OBSERVER: ReconstructionObservationSink =
	Object.freeze({ observe() {} });

type LedgerContext = Omit<
	SourceForensicsLedgerWire,
	| "ledger_sha256"
	| "provider_objects"
	| "records"
	| "summary"
	| "limits"
	| "complete"
	| "incomplete_reason"
> & {
	adapter_version: string;
	required_clock_target_times_ms: readonly number[];
	redact_values?: ReadonlySet<string>;
};

function lagDistribution(lagMs: number | null): SourceLagDistribution {
	return {
		lag_1000_ms: lagMs !== null && lagMs <= 1_000 ? 1 : 0,
		lag_2000_ms: lagMs !== null && lagMs <= 2_000 ? 1 : 0,
		lag_5000_ms: lagMs !== null && lagMs <= 5_000 ? 1 : 0,
		lag_10000_ms: lagMs !== null && lagMs <= 10_000 ? 1 : 0,
		lag_30000_ms: lagMs !== null && lagMs <= 30_000 ? 1 : 0,
		lag_60000_ms: lagMs !== null && lagMs <= 60_000 ? 1 : 0,
	};
}

function mergeObjects(objects: SourceObjectEvidence[]): SourceObjectEvidence[] {
	const byIdentity = new Map<string, SourceObjectEvidence>();
	for (const object of objects) {
		const existing = byIdentity.get(object.identity);
		byIdentity.set(object.identity, {
			identity: object.identity,
			checksums: [
				...new Set([...(existing?.checksums ?? []), ...object.checksums]),
			].sort(),
			attempt_count: Math.max(
				existing?.attempt_count ?? 0,
				object.attempt_count,
			),
			quarantined: Boolean(existing?.quarantined || object.quarantined),
		});
	}
	return [...byIdentity.values()].sort((left, right) =>
		left.identity.localeCompare(right.identity),
	);
}

type PendingSourceForensicsRecord = Omit<
	SourceForensicsRecordWire,
	"record_sha256"
>;

/**
 * Streaming qualification sink. It coalesces target intervals as observations
 * arrive and never retains more derived records than the configured cap.
 */
export class BoundedSourceForensicsSink
	implements ReconstructionObservationSink
{
	private readonly records: PendingSourceForensicsRecord[] = [];
	private readonly providerObjects = new Map<string, SourceObjectEvidence>();
	private readonly affectedTargets = new Set<number>();
	private readonly classifications = new Map<
		string,
		SourceForensicsClassification
	>();
	private previousAnchor: SourceAnchorEvidence | null = null;
	private pendingGapRecord: PendingSourceForensicsRecord | null = null;
	private lastOmittedRecord: PendingSourceForensicsRecord | null = null;
	private totalRecordCount = 0;
	private omittedRecordCount = 0;

	constructor(
		private readonly context: LedgerContext,
		private readonly testingLimits: {
			maxRetainedRecords?: number;
			maxCanonicalJsonBytes?: number;
		} = {},
	) {}

	observe(observation: ReconstructionObservation): void {
		try {
			this.accept(observation);
		} catch {
			// Observer faults must never affect production reconstruction.
			this.totalRecordCount += 1;
			this.omittedRecordCount += 1;
		}
	}

	classifyObject(
		objectIdentity: string,
		classification: SourceForensicsClassification,
	): void {
		if (!SOURCE_FORENSICS_CLASSIFICATIONS.includes(classification)) return;
		this.classifications.set(this.sanitize(objectIdentity), classification);
	}

	private get retainedLimit(): number {
		return Math.min(
			SOURCE_FORENSICS_MAX_RECORDS,
			this.testingLimits.maxRetainedRecords ?? SOURCE_FORENSICS_MAX_RECORDS,
		);
	}

	private sanitize(value: string): string {
		let result = value;
		for (const secret of this.context.redact_values ?? []) {
			if (secret) result = result.replaceAll(secret, "[REDACTED]");
		}
		return result.slice(0, 1024);
	}

	private retainObject(input: SourceObjectEvidence): SourceObjectEvidence {
		const object = {
			...input,
			identity: this.sanitize(input.identity),
			checksums: [...new Set(input.checksums)].sort(),
		};
		const existing = this.providerObjects.get(object.identity);
		const merged = mergeObjects(existing ? [existing, object] : [object]);
		this.providerObjects.set(
			object.identity,
			merged[0] as SourceObjectEvidence,
		);
		return object;
	}

	private sanitizeAnchor(input: SourceAnchorEvidence): SourceAnchorEvidence {
		return {
			...input,
			object_identity: this.sanitize(input.object_identity),
		};
	}

	private interval(
		targetTimes: readonly number[],
	): SourceTargetInterval | null {
		const targets = [...new Set(targetTimes)]
			.filter((target) =>
				this.context.required_clock_target_times_ms.includes(target),
			)
			.sort((left, right) => left - right);
		const first = targets[0];
		const last = targets.at(-1);
		if (first === undefined || last === undefined) return null;
		const lastIndex = this.context.required_clock_target_times_ms.indexOf(last);
		return {
			start_target_time_ms: first,
			end_target_time_ms_exclusive:
				this.context.required_clock_target_times_ms[lastIndex + 1] ?? last + 1,
			target_count: targets.length,
		};
	}

	private markAffected(interval: SourceTargetInterval | null): void {
		if (!interval) return;
		for (const target of this.context.required_clock_target_times_ms) {
			if (
				target >= interval.start_target_time_ms &&
				target < interval.end_target_time_ms_exclusive
			) {
				this.affectedTargets.add(target);
			}
		}
	}

	private mergeAdjacent(
		previous: PendingSourceForensicsRecord,
		record: PendingSourceForensicsRecord,
	): boolean {
		const interval = record.target_interval;
		if (
			!interval ||
			!previous.target_interval ||
			previous.kind !== record.kind ||
			previous.target_interval.end_target_time_ms_exclusive !==
				interval.start_target_time_ms
		) {
			return false;
		}
		previous.target_interval = {
			...previous.target_interval,
			end_target_time_ms_exclusive: interval.end_target_time_ms_exclusive,
			target_count:
				previous.target_interval.target_count + interval.target_count,
		};
		previous.provider_objects = mergeObjects([
			...previous.provider_objects,
			...record.provider_objects,
		]);
		if (previous.lag_distribution && record.lag_distribution) {
			for (const key of Object.keys(previous.lag_distribution) as Array<
				keyof SourceLagDistribution
			>) {
				previous.lag_distribution[key] += record.lag_distribution[key];
			}
		}
		return true;
	}

	private append(
		record: PendingSourceForensicsRecord,
	): PendingSourceForensicsRecord {
		const previous = this.lastOmittedRecord ?? this.records.at(-1);
		if (previous && this.mergeAdjacent(previous, record)) return previous;
		this.totalRecordCount += 1;
		if (this.records.length < this.retainedLimit) {
			this.records.push(record);
			return record;
		}
		this.omittedRecordCount += 1;
		this.lastOmittedRecord = record;
		return record;
	}

	private accept(observation: ReconstructionObservation): void {
		if (observation.type === "provider_object_boundary") {
			this.retainObject(observation.object);
			return;
		}
		if (
			observation.type === "snapshot_anchor" ||
			observation.type === "reanchor"
		) {
			const anchor = this.sanitizeAnchor(observation.anchor);
			if (this.pendingGapRecord) this.pendingGapRecord.next_anchor = anchor;
			this.pendingGapRecord = null;
			this.previousAnchor = anchor;
			return;
		}
		if (observation.type === "sequence_discontinuity") {
			this.pendingGapRecord = this.append({
				kind: "sequence_discontinuity",
				scope: this.context.scope,
				provider_objects: [this.retainObject(observation.object)],
				previous_anchor: this.previousAnchor,
				next_anchor: null,
				target_interval: null,
				lag_distribution: null,
				sequence: observation.sequence,
				classification: "unresolved",
				adapter_version: this.context.adapter_version,
			});
			this.previousAnchor = null;
			return;
		}
		if (observation.type === "provider_object_checksum_conflict") {
			const object = this.retainObject(observation.object);
			const interval = this.interval(observation.affected_target_times_ms);
			this.markAffected(interval);
			this.append({
				kind: "provider_object_checksum_conflict",
				scope: this.context.scope,
				provider_objects: [object],
				previous_anchor: this.previousAnchor,
				next_anchor: null,
				target_interval: interval,
				lag_distribution: null,
				sequence: null,
				classification:
					object.checksums.length > 1 ? "mutable_provider_bytes" : "unresolved",
				adapter_version: this.context.adapter_version,
			});
			return;
		}
		if (
			observation.type !== "required_clock_sample" ||
			observation.status === "covered"
		) {
			return;
		}

		const interval = this.interval([observation.target_time_ms]);
		if (!interval) throw new Error("observed target is outside required clock");
		this.markAffected(interval);
		const kind =
			observation.status === "unanchored"
				? "unanchored_target_interval"
				: observation.status === "stale"
					? "stale_target_interval"
					: "future_state_interval";
		this.append({
			kind,
			scope: this.context.scope,
			provider_objects: observation.object
				? [this.retainObject(observation.object)]
				: [],
			previous_anchor: this.previousAnchor,
			next_anchor: null,
			target_interval: interval,
			lag_distribution: lagDistribution(observation.lag_ms),
			sequence: null,
			classification: "unresolved",
			adapter_version: this.context.adapter_version,
		});
		if (this.pendingGapRecord) {
			this.pendingGapRecord.target_interval = this.pendingGapRecord
				.target_interval
				? {
						...this.pendingGapRecord.target_interval,
						end_target_time_ms_exclusive: interval.end_target_time_ms_exclusive,
						target_count:
							this.pendingGapRecord.target_interval.target_count + 1,
					}
				: interval;
		}
	}

	finish(): SourceForensicsLedgerWire {
		const pendingRecords = structuredClone(this.records);
		for (const record of pendingRecords) {
			const classification = record.provider_objects
				.map((object) => this.classifications.get(object.identity))
				.find((value) => value !== undefined);
			if (classification) record.classification = classification;
		}
		const finalized = pendingRecords
			.map(finalizeRecord)
			.sort((left, right) =>
				jcsCanonicalize(left).localeCompare(jcsCanonicalize(right)),
			);
		let retained = finalized;
		let retainedProviderObjects = mergeObjects([
			...this.providerObjects.values(),
		]);
		let total = this.totalRecordCount;
		let omitted = this.omittedRecordCount;
		let unresolved =
			finalized.filter((record) => record.classification === "unresolved")
				.length + this.omittedRecordCount;
		const byteLimit = Math.min(
			SOURCE_FORENSICS_MAX_CANONICAL_JSON_BYTES,
			this.testingLimits.maxCanonicalJsonBytes ??
				SOURCE_FORENSICS_MAX_CANONICAL_JSON_BYTES,
		);

		const build = (): SourceForensicsLedgerWire => {
			const incomplete = omitted > 0;
			const content = {
				schema_id: SOURCE_FORENSICS_LEDGER_SCHEMA_ID,
				request_id: this.context.request_id,
				idempotency_key: this.context.idempotency_key,
				scope: this.context.scope,
				required_clock: this.context.required_clock,
				effective_policies: this.context.effective_policies,
				provider_objects: retainedProviderObjects,
				records: retained,
				summary: {
					retained_record_count: retained.length,
					total_record_count: total,
					omitted_record_count: omitted,
					affected_target_count: this.affectedTargets.size,
					unresolved_record_count: unresolved,
				},
				limits: {
					max_records: 100_000 as const,
					max_canonical_json_bytes: 67_108_864 as const,
				},
				complete: !incomplete,
				incomplete_reason: incomplete
					? ("forensics_evidence_bound_exceeded" as const)
					: null,
			};
			return {
				...content,
				ledger_sha256: documentSha256(content, "ledger_sha256"),
			};
		};

		let ledger = build();
		const size = () =>
			new TextEncoder().encode(jcsCanonicalize(ledger)).byteLength;
		while (size() > byteLimit && retained.length > 0) {
			retained = retained.slice(0, -1);
			omitted += 1;
			ledger = build();
		}
		let providerEvidenceOmitted = false;
		while (size() > byteLimit && retainedProviderObjects.length > 0) {
			retainedProviderObjects = retainedProviderObjects.slice(0, -1);
			providerEvidenceOmitted = true;
			ledger = build();
		}
		if (providerEvidenceOmitted || size() > byteLimit) {
			total += 1;
			omitted += 1;
			unresolved += 1;
			ledger = build();
		}
		return sourceForensicsLedgerCodec.decode(ledger);
	}
}

export function classifySourceObjectEvidence(input: {
	checksums: readonly string[];
	schemaValid: boolean;
	sequenceValid: boolean;
	missingRows: boolean;
	completeSnapshotDefect: boolean;
	alternateOrderingClosesGap: boolean;
	staleWithValidPriorState: boolean;
}): SourceForensicsClassification {
	if (new Set(input.checksums).size > 1) return "mutable_provider_bytes";
	if (!input.schemaValid || input.completeSnapshotDefect) {
		return "stable_object_corruption";
	}
	if (input.missingRows) return "provider_row_loss";
	if (input.alternateOrderingClosesGap) return "object_boundary_order_defect";
	if (input.sequenceValid && input.staleWithValidPriorState) {
		return "valid_inactive_market_state";
	}
	return "unresolved";
}

export type SourceObjectInspection = {
	checksum: Sha256Hex;
	schemaValid: boolean;
	sequenceValid: boolean;
	missingRows: boolean;
	completeSnapshotDefect: boolean;
	alternateOrderingClosesGap: boolean;
	staleWithValidPriorState: boolean;
};

/**
 * Runs the qualification-only, bounded source inspection. The callback may
 * inspect licensed bytes, but this return value deliberately retains only safe
 * identities, checksums and closed predicates. It cannot repair reconstruction
 * or make an interval acceptance-eligible.
 */
export async function classifyImplicatedSourceObjects(input: {
	originalIdentity: string;
	adjacentIdentities: readonly string[];
	maxAttempts: number;
	inspect(
		identity: string,
		attempt: number,
	): SourceObjectInspection | Promise<SourceObjectInspection>;
}): Promise<{
	classification: SourceForensicsClassification;
	objects: SourceObjectEvidence[];
	acceptanceEligible: false;
}> {
	if (
		!input.originalIdentity ||
		input.adjacentIdentities.length > 2 ||
		!Number.isSafeInteger(input.maxAttempts) ||
		input.maxAttempts < 1 ||
		input.maxAttempts > 3
	) {
		throw new Error("implicated source inspection bounds are invalid");
	}
	const identities = [input.originalIdentity, ...input.adjacentIdentities];
	if (new Set(identities).size !== identities.length) {
		throw new Error("implicated source inspection identities must be unique");
	}

	const inspections = new Map<string, SourceObjectInspection[]>();
	for (const identity of identities) {
		const attempts: SourceObjectInspection[] = [];
		for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
			const inspected = await input.inspect(identity, attempt);
			if (!/^[a-f0-9]{64}$/u.test(inspected.checksum)) {
				throw new Error("source inspection checksum is invalid");
			}
			attempts.push(inspected);
		}
		inspections.set(identity, attempts);
	}

	const mutable = [...inspections.values()].some(
		(attempts) => new Set(attempts.map(({ checksum }) => checksum)).size > 1,
	);
	const all = [...inspections.values()].flat();
	const classification = mutable
		? "mutable_provider_bytes"
		: classifySourceObjectEvidence({
				checksums: all.map(({ checksum }) => checksum),
				schemaValid: all.every(({ schemaValid }) => schemaValid),
				sequenceValid: all.every(({ sequenceValid }) => sequenceValid),
				missingRows: all.some(({ missingRows }) => missingRows),
				completeSnapshotDefect: all.some(
					({ completeSnapshotDefect }) => completeSnapshotDefect,
				),
				alternateOrderingClosesGap: all.some(
					({ alternateOrderingClosesGap }) => alternateOrderingClosesGap,
				),
				staleWithValidPriorState: all.some(
					({ staleWithValidPriorState }) => staleWithValidPriorState,
				),
			});

	return {
		classification,
		objects: identities.map((identity) => {
			const attempts = inspections.get(identity) as SourceObjectInspection[];
			return {
				identity,
				checksums: [
					...new Set(attempts.map(({ checksum }) => checksum)),
				].sort(),
				attempt_count: attempts.length,
				quarantined:
					classification === "mutable_provider_bytes" ||
					classification === "stable_object_corruption",
			};
		}),
		acceptanceEligible: false,
	};
}

export async function commitSourceQualificationEvidence(input: {
	outputDirectory: string;
	ledgerFileName: string;
	qualificationFileName: string;
	ledger: SourceForensicsLedgerWire;
	createdAt: string;
	cleanupLicensedPayloads?: () => void | Promise<void>;
}): Promise<SourceQualificationRecordWire> {
	assertSidecarBasename(input.ledgerFileName);
	assertSidecarBasename(input.qualificationFileName);
	const ledger = sourceForensicsLedgerCodec.decode(input.ledger);
	const ledgerBytes = new TextEncoder().encode(jcsCanonicalize(ledger));
	const ledgerPath = path.join(input.outputDirectory, input.ledgerFileName);
	const qualificationPath = path.join(
		input.outputDirectory,
		input.qualificationFileName,
	);
	try {
		await writeExclusiveDurableFile(ledgerPath, ledgerBytes);
		const qualification = finalizeSourceQualificationRecord({
			schema_id: SOURCE_QUALIFICATION_RECORD_SCHEMA_ID,
			created_at: input.createdAt,
			request_id: ledger.request_id,
			scope: ledger.scope,
			ledger: {
				schema_id: SOURCE_FORENSICS_LEDGER_SCHEMA_ID,
				file_name: input.ledgerFileName,
				sha256: createHash("sha256").update(ledgerBytes).digest("hex"),
				bytes: ledgerBytes.byteLength,
				retained_record_count: ledger.summary.retained_record_count,
				total_record_count: ledger.summary.total_record_count,
				omitted_record_count: ledger.summary.omitted_record_count,
				complete: ledger.complete,
			},
			qualified:
				ledger.complete &&
				ledger.summary.affected_target_count === 0 &&
				ledger.summary.unresolved_record_count === 0,
		});
		await atomicWriteJsonResult(qualificationPath, qualification, {
			validate: (value) => sourceQualificationRecordCodec.decode(value),
		});
		return qualification;
	} finally {
		await input.cleanupLicensedPayloads?.();
	}
}
