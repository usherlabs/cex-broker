import { createHash } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { clickHouseRequestDeadline } from "./clickhouse-deadline";
import type { RowInserter } from "./insert";
import type { ArchiveBatchRequest, ArchiveRow } from "./types";

export const STREAM_HEALTH_ARCHIVE_SOURCE = "broker_write";
export const STREAM_HEALTH_TABLE = "broker_stream_health.snapshots";

const STREAM_HEALTH_SCHEMA_VERSION = "1";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,127}$/;
const DECIMAL_UINT_PATTERN = /^(0|[1-9]\d*)$/;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const MAX_UINT32 = 4_294_967_295n;

const STATES = new Set(["connecting", "connected", "disconnected", "error"]);
const FAILURE_KINDS = new Set([
	"none",
	"auth_failed",
	"transport_error",
	"remote_closed",
	"protocol_error",
	"backpressure",
	"unsupported_connector",
	"shutdown",
]);
const TRAFFIC_MODES = new Set(["event_driven", "continuous", "unknown"]);
const REGISTRY_STATUSES = new Set(["active", "retired"]);

const REQUIRED_FIELDS = [
	"producer_id",
	"producer_epoch",
	"run_id",
	"batch_sequence",
	"batch_snapshot_count",
	"batch_active_stream_count",
	"registry_revision",
	"registry_status",
	"retired_at",
	"exchange",
	"account_selector",
	"account_role",
	"stream_kind",
	"account_scope",
	"sequence",
	"state",
	"state_changed_at",
	"last_connected_at",
	"last_authenticated_at",
	"last_received_at",
	"heartbeat_at",
	"connect_attempt_count",
	"reconnect_count",
	"error_count",
	"last_failure_kind",
	"last_failure_reason",
	"traffic_mode",
	"source_watermark",
] as const;

type CanonicalStreamHealthRow = {
	schema_version: string;
	source: string;
	deployment_id: string;
	producer_id: string;
	producer_epoch: string;
	run_id: string;
	batch_id: string;
	batch_sequence: string;
	batch_snapshot_count: string;
	batch_active_stream_count: string;
	registry_revision: string;
	registry_status: string;
	retired_at: string | null;
	snapshot_id: string;
	stream_key: string;
	exchange: string;
	account_selector: string;
	account_role: string | null;
	stream_kind: string;
	account_scope: string;
	sequence: string;
	state: string;
	state_changed_at: string;
	last_connected_at: string | null;
	last_authenticated_at: string | null;
	last_received_at: string | null;
	heartbeat_at: string;
	connect_attempt_count: string;
	reconnect_count: string;
	error_count: string;
	last_failure_kind: string;
	last_failure_reason: string;
	traffic_mode: string;
	source_watermark: string | null;
	payload_sha256: string;
	payload_json: string;
};

type CanonicalPayload = Omit<
	CanonicalStreamHealthRow,
	"snapshot_id" | "batch_id" | "payload_sha256" | "payload_json"
>;

export type StreamHealthBatchClassification =
	| "stream_health"
	| "direct"
	| "invalid_stream_health_source"
	| "invalid_stream_health_mix";

export type StreamHealthContractValidation =
	| { ok: true; rows: CanonicalStreamHealthRow[]; batchId: string }
	| { ok: false; error: string };

export type ExistingStreamHealthSnapshot = {
	snapshotId: string;
	payloadSha256: string;
	payloadJson: string;
};

export type StreamHealthReplayConflict = {
	batchId: string;
	snapshotId: string;
	conflictKind:
		| "payload_mismatch"
		| "partial_batch"
		| "multiple_existing_hashes";
	existingPayloadSha256: string;
	incomingPayloadSha256: string;
	existingPayloadJson: string;
	incomingPayloadJson: string;
};

export type StreamHealthReplayStore = {
	findExistingSnapshots(
		snapshotIds: readonly string[],
	): Promise<ExistingStreamHealthSnapshot[]>;
	recordReplayConflicts(
		conflicts: readonly StreamHealthReplayConflict[],
	): Promise<void>;
};

export type StreamHealthInsertResult =
	| { ok: true; inserted: number; replayed: boolean; batchId: string }
	| { ok: false; status: 400 | 409 | 500 | 503; error: string };

// The operational contract is one active forwarder deployment. Within that
// process, the gate makes replay lookup, conflict persistence, and candidate
// insert one critical section; a second request cannot pass lookup before the
// first request's candidate is visible to it.
let streamHealthBatchTail: Promise<void> = Promise.resolve();

async function serializeStreamHealthBatch<T>(
	operation: () => Promise<T>,
): Promise<T> {
	let release: (() => void) | undefined;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	const previous = streamHealthBatchTail;
	streamHealthBatchTail = next;
	await previous;
	try {
		return await operation();
	} finally {
		release?.();
	}
}

function rawRows(value: unknown): unknown[] {
	if (!value || typeof value !== "object") return [];
	const rows = (value as { rows?: unknown }).rows;
	return Array.isArray(rows) ? rows : [];
}

function rawSource(value: unknown): unknown {
	return value && typeof value === "object"
		? (value as { source?: unknown }).source
		: undefined;
}

function entryTable(entry: unknown): unknown {
	return entry && typeof entry === "object"
		? (entry as { table?: unknown }).table
		: undefined;
}

export function isStreamHealthArchiveTable(
	table: unknown,
): table is typeof STREAM_HEALTH_TABLE {
	return table === STREAM_HEALTH_TABLE;
}

export function classifyStreamHealthArchiveBatch(
	value: unknown,
): StreamHealthBatchClassification {
	const rows = rawRows(value);
	const source = rawSource(value);
	const hasHealthRows = rows.some((entry) =>
		isStreamHealthArchiveTable(entryTable(entry)),
	);

	if (source === STREAM_HEALTH_ARCHIVE_SOURCE && hasHealthRows) {
		return rows.length > 0 && rows.every((entry) =>
			isStreamHealthArchiveTable(entryTable(entry)),
		)
			? "stream_health"
			: "invalid_stream_health_mix";
	}
	return hasHealthRows ? "invalid_stream_health_source" : "direct";
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function identityHash(namespace: string, fields: readonly string[]): string {
	return hash(`${namespace}\u0000${fields.join("\u0000")}`);
}

function normalizeIdentifier(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (!IDENTIFIER_PATTERN.test(normalized)) return undefined;
	return normalized;
}

function normalizeUuid(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeHash(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return HASH_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeUnsigned(
	value: unknown,
	maximum: bigint = MAX_UINT64,
): string | undefined {
	const text =
		typeof value === "string"
			? value
			: typeof value === "number" && Number.isSafeInteger(value)
				? String(value)
				: undefined;
	if (!text || !DECIMAL_UINT_PATTERN.test(text)) return undefined;
	const numeric = BigInt(text);
	if (numeric > maximum) return undefined;
	return numeric.toString();
}

function normalizeTimestamp(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
	) {
		return undefined;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function normalizeNullableTimestamp(value: unknown): string | null | undefined {
	if (value === null) return null;
	return normalizeTimestamp(value);
}

function redactDiagnostic(value: string): string {
	return value
		.replace(
			/\b(authorization|api[_-]?key|secret|token|signature|password)\s*([=:])\s*(?:bearer\s+)?[^\s,;]+/gi,
			"$1$2[redacted]",
		)
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replace(/:\/\/[^\s/@]+@/g, "://[redacted]@");
}

function normalizeDiagnostic(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return redactDiagnostic(value.trim()).slice(0, 256);
}

function normalizeNullableText(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== "string") return undefined;
	return value.trim().slice(0, 512);
}

function requireRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function normalizeOptionalIdentifier(
	value: unknown,
): string | null | undefined {
	if (value === null) return null;
	return normalizeIdentifier(value);
}

function deriveStreamKey(
	exchange: string,
	accountSelector: string,
	streamKind: string,
	accountScope: string,
): string {
	return `exchange:${exchange}|account:${accountSelector}|stream:${streamKind}|scope:${accountScope}`;
}

export function deriveStreamHealthSnapshotId(fields: {
	producerId: string;
	producerEpoch: string;
	runId: string;
	streamKey: string;
	sequence: string;
}): string {
	return identityHash("broker-stream-health-snapshot-v1", [
		fields.producerId,
		fields.producerEpoch,
		fields.runId,
		fields.streamKey,
		fields.sequence,
	]);
}

export function deriveStreamHealthBatchId(fields: {
	producerId: string;
	producerEpoch: string;
	runId: string;
	batchSequence: string;
	registryRevision: string;
}): string {
	return identityHash("broker-stream-health-batch-v1", [
		fields.producerId,
		fields.producerEpoch,
		fields.runId,
		fields.batchSequence,
		fields.registryRevision,
	]);
}

function normalizeStreamHealthRow(
	entry: ArchiveRow,
	envelope: ArchiveBatchRequest,
): CanonicalStreamHealthRow | { error: string } {
	const row = requireRecord(entry.row);
	if (!row) return { error: "Malformed stream health row" };
	for (const field of REQUIRED_FIELDS) {
		if (!(field in row)) return { error: `Missing stream health field: ${field}` };
	}
	if (row.source !== undefined && row.source !== envelope.source) {
		return { error: "Row source does not match stream health envelope" };
	}
	if (
		row.deployment_id !== undefined &&
		row.deployment_id !== envelope.deployment_id
	) {
		return { error: "Row deployment does not match stream health envelope" };
	}

	const producerId = normalizeIdentifier(row.producer_id);
	const producerEpoch = normalizeUnsigned(row.producer_epoch);
	const runId = normalizeUuid(row.run_id);
	const batchSequence = normalizeUnsigned(row.batch_sequence);
	const batchSnapshotCount = normalizeUnsigned(
		row.batch_snapshot_count,
		MAX_UINT32,
	);
	const batchActiveStreamCount = normalizeUnsigned(
		row.batch_active_stream_count,
		MAX_UINT32,
	);
	const registryRevision = normalizeHash(row.registry_revision);
	const registryStatus =
		typeof row.registry_status === "string" &&
		REGISTRY_STATUSES.has(row.registry_status)
			? row.registry_status
			: undefined;
	const retiredAt = normalizeNullableTimestamp(row.retired_at);
	const exchange = normalizeIdentifier(row.exchange);
	const accountSelector = normalizeIdentifier(row.account_selector);
	const accountRole = normalizeOptionalIdentifier(row.account_role);
	const streamKind = normalizeIdentifier(row.stream_kind);
	const accountScope = normalizeIdentifier(row.account_scope);
	const sequence = normalizeUnsigned(row.sequence);
	const state =
		typeof row.state === "string" && STATES.has(row.state)
			? row.state
			: undefined;
	const stateChangedAt = normalizeTimestamp(row.state_changed_at);
	const lastConnectedAt = normalizeNullableTimestamp(row.last_connected_at);
	const lastAuthenticatedAt = normalizeNullableTimestamp(
		row.last_authenticated_at,
	);
	const lastReceivedAt = normalizeNullableTimestamp(row.last_received_at);
	const heartbeatAt = normalizeTimestamp(row.heartbeat_at);
	const connectAttemptCount = normalizeUnsigned(
		row.connect_attempt_count,
	);
	const reconnectCount = normalizeUnsigned(row.reconnect_count);
	const errorCount = normalizeUnsigned(row.error_count);
	const lastFailureKind =
		typeof row.last_failure_kind === "string" &&
		FAILURE_KINDS.has(row.last_failure_kind)
			? row.last_failure_kind
			: undefined;
	const lastFailureReason = normalizeDiagnostic(row.last_failure_reason);
	const trafficMode =
		typeof row.traffic_mode === "string" && TRAFFIC_MODES.has(row.traffic_mode)
			? row.traffic_mode
			: undefined;
	const sourceWatermark = normalizeNullableText(row.source_watermark);

	if (
		!producerId ||
		producerEpoch === undefined ||
		!runId ||
		batchSequence === undefined ||
		batchSnapshotCount === undefined ||
		batchActiveStreamCount === undefined ||
		!registryRevision ||
		!registryStatus ||
		retiredAt === undefined ||
		!exchange ||
		!accountSelector ||
		accountRole === undefined ||
		!streamKind ||
		!accountScope ||
		sequence === undefined ||
		!state ||
		!stateChangedAt ||
		lastConnectedAt === undefined ||
		lastAuthenticatedAt === undefined ||
		lastReceivedAt === undefined ||
		!heartbeatAt ||
		connectAttemptCount === undefined ||
		reconnectCount === undefined ||
		errorCount === undefined ||
		!lastFailureKind ||
		lastFailureReason === undefined ||
		!trafficMode ||
		sourceWatermark === undefined
	) {
		return { error: "Invalid stream health field" };
	}
	if (
		(registryStatus === "active" && retiredAt !== null) ||
		(registryStatus === "retired" && retiredAt === null)
	) {
		return { error: "Registry status and retired_at disagree" };
	}
	if (lastFailureKind === "none" && lastFailureReason.length > 0) {
		return { error: "last_failure_reason requires a failure kind" };
	}

	const deploymentId = normalizeIdentifier(envelope.deployment_id);
	if (!deploymentId) return { error: "Invalid stream health deployment id" };
	const streamKey = deriveStreamKey(
		exchange,
		accountSelector,
		streamKind,
		accountScope,
	);
	if (row.stream_key !== undefined && row.stream_key !== streamKey) {
		return { error: "stream_key does not match normalized stream identity" };
	}
	const snapshotId = deriveStreamHealthSnapshotId({
		producerId,
		producerEpoch,
		runId,
		streamKey,
		sequence,
	});
	const batchId = deriveStreamHealthBatchId({
		producerId,
		producerEpoch,
		runId,
		batchSequence,
		registryRevision,
	});
	if (row.snapshot_id !== undefined && normalizeHash(row.snapshot_id) !== snapshotId) {
		return { error: "snapshot_id does not match normalized stream identity" };
	}
	if (row.batch_id !== undefined && normalizeHash(row.batch_id) !== batchId) {
		return { error: "batch_id does not match normalized batch identity" };
	}

	const payload: CanonicalPayload = {
		schema_version: STREAM_HEALTH_SCHEMA_VERSION,
		source: STREAM_HEALTH_ARCHIVE_SOURCE,
		deployment_id: deploymentId,
		producer_id: producerId,
		producer_epoch: producerEpoch,
		run_id: runId,
		batch_sequence: batchSequence,
		batch_snapshot_count: batchSnapshotCount,
		batch_active_stream_count: batchActiveStreamCount,
		registry_revision: registryRevision,
		registry_status: registryStatus,
		retired_at: retiredAt,
		stream_key: streamKey,
		exchange,
		account_selector: accountSelector,
		account_role: accountRole,
		stream_kind: streamKind,
		account_scope: accountScope,
		sequence,
		state,
		state_changed_at: stateChangedAt,
		last_connected_at: lastConnectedAt,
		last_authenticated_at: lastAuthenticatedAt,
		last_received_at: lastReceivedAt,
		heartbeat_at: heartbeatAt,
		connect_attempt_count: connectAttemptCount,
		reconnect_count: reconnectCount,
		error_count: errorCount,
		last_failure_kind: lastFailureKind,
		last_failure_reason: lastFailureReason,
		traffic_mode: trafficMode,
		source_watermark: sourceWatermark,
	};
	const payloadJson = JSON.stringify(payload);
	const payloadSha256 = hash(payloadJson);
	if (
		row.payload_sha256 !== undefined &&
		normalizeHash(row.payload_sha256) !== payloadSha256
	) {
		return { error: "payload_sha256 does not match canonical stream health payload" };
	}

	return {
		...payload,
		batch_id: batchId,
		snapshot_id: snapshotId,
		payload_sha256: payloadSha256,
		payload_json: payloadJson,
	};
}

export function validateStreamHealthArchiveBatch(
	value: unknown,
): StreamHealthContractValidation {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, error: "Malformed stream health envelope" };
	}
	const envelope = value as Partial<ArchiveBatchRequest>;
	if (envelope.source !== STREAM_HEALTH_ARCHIVE_SOURCE) {
		return { ok: false, error: "Invalid stream health archive source" };
	}
	if (typeof envelope.deployment_id !== "string") {
		return { ok: false, error: "Missing stream health deployment id" };
	}
	if (!Array.isArray(envelope.rows) || envelope.rows.length === 0) {
		return { ok: false, error: "Stream health envelope rows must be non-empty" };
	}
	if (envelope.rows.length > 1_000) {
		return { ok: false, error: "Too many stream health rows" };
	}
	if (classifyStreamHealthArchiveBatch(envelope) !== "stream_health") {
		return { ok: false, error: "Invalid stream health source or table mix" };
	}

	const rows: CanonicalStreamHealthRow[] = [];
	const streamKeys = new Set<string>();
	let batchId: string | undefined;
	let batchSequence: string | undefined;
	let batchSnapshotCount: string | undefined;
	let batchActiveStreamCount: string | undefined;
	let registryRevision: string | undefined;
	for (const entry of envelope.rows) {
		const normalized = normalizeStreamHealthRow(entry, envelope as ArchiveBatchRequest);
		if ("error" in normalized) return { ok: false, error: normalized.error };
		if (streamKeys.has(normalized.stream_key)) {
			return { ok: false, error: "Duplicate stream_key in stream health batch" };
		}
		streamKeys.add(normalized.stream_key);
		if (batchId === undefined) {
			batchId = normalized.batch_id;
			batchSequence = normalized.batch_sequence;
			batchSnapshotCount = normalized.batch_snapshot_count;
			batchActiveStreamCount = normalized.batch_active_stream_count;
			registryRevision = normalized.registry_revision;
		} else if (
			batchId !== normalized.batch_id ||
			batchSequence !== normalized.batch_sequence ||
			batchSnapshotCount !== normalized.batch_snapshot_count ||
			batchActiveStreamCount !== normalized.batch_active_stream_count ||
			registryRevision !== normalized.registry_revision
		) {
			return { ok: false, error: "Inconsistent stream health batch semantics" };
		}
		rows.push(normalized);
	}
	if (batchSnapshotCount !== String(rows.length)) {
		return { ok: false, error: "batch_snapshot_count does not match stream health rows" };
	}
	const activeStreamCount = rows.filter(
		(row) => row.registry_status === "active",
	).length;
	if (batchActiveStreamCount !== String(activeStreamCount)) {
		return { ok: false, error: "batch_active_stream_count does not match active streams" };
	}
	return { ok: true, rows, batchId: batchId as string };
}

function existingBySnapshot(
	existing: readonly ExistingStreamHealthSnapshot[],
): Map<string, ExistingStreamHealthSnapshot[]> {
	const grouped = new Map<string, ExistingStreamHealthSnapshot[]>();
	for (const row of existing) {
		const rows = grouped.get(row.snapshotId) ?? [];
		rows.push(row);
		grouped.set(row.snapshotId, rows);
	}
	return grouped;
}

function replayConflicts(
	rows: readonly CanonicalStreamHealthRow[],
	existing: readonly ExistingStreamHealthSnapshot[],
): StreamHealthReplayConflict[] {
	const grouped = existingBySnapshot(existing);
	const existingIds = new Set(grouped.keys());
	const hasExisting = existingIds.size > 0;
	const hasNew = rows.some((row) => !existingIds.has(row.snapshot_id));
	const conflicts: StreamHealthReplayConflict[] = [];
	for (const row of rows) {
		const priorRows = grouped.get(row.snapshot_id) ?? [];
		const priorHashes = [...new Set(priorRows.map((prior) => prior.payloadSha256))].sort();
		const existingPayloadJson = JSON.stringify(
			priorRows
				.map((prior) => ({
					payload_sha256: prior.payloadSha256,
					payload_json: prior.payloadJson,
				}))
				.sort((left, right) =>
					left.payload_sha256.localeCompare(right.payload_sha256),
				),
		);
		if (priorHashes.length > 1) {
			conflicts.push({
				batchId: row.batch_id,
				snapshotId: row.snapshot_id,
				conflictKind: "multiple_existing_hashes",
				existingPayloadSha256: priorHashes.join(","),
				incomingPayloadSha256: row.payload_sha256,
				existingPayloadJson,
				incomingPayloadJson: row.payload_json,
			});
			continue;
		}
		if (priorHashes.length === 1 && priorHashes[0] !== row.payload_sha256) {
			conflicts.push({
				batchId: row.batch_id,
				snapshotId: row.snapshot_id,
				conflictKind: "payload_mismatch",
				existingPayloadSha256: priorHashes[0] ?? "",
				incomingPayloadSha256: row.payload_sha256,
				existingPayloadJson,
				incomingPayloadJson: row.payload_json,
			});
			continue;
		}
		if (hasExisting && hasNew) {
			conflicts.push({
				batchId: row.batch_id,
				snapshotId: row.snapshot_id,
				conflictKind: "partial_batch",
				existingPayloadSha256: priorHashes.join(","),
				incomingPayloadSha256: row.payload_sha256,
				existingPayloadJson,
				incomingPayloadJson: row.payload_json,
			});
		}
	}
	return conflicts;
}

export async function insertStreamHealthArchiveBatch(
	inserter: RowInserter,
	store: StreamHealthReplayStore,
	validation: Extract<StreamHealthContractValidation, { ok: true }>,
): Promise<StreamHealthInsertResult> {
	return serializeStreamHealthBatch(async () => {
		let existing: ExistingStreamHealthSnapshot[];
		try {
			existing = await store.findExistingSnapshots(
				validation.rows.map((row) => row.snapshot_id),
			);
		} catch (error) {
			console.error("Stream health replay lookup failed:", error);
			return {
				ok: false,
				status: 503,
				error: "Stream health replay lookup failed",
			};
		}

		const conflicts = replayConflicts(validation.rows, existing);
		if (conflicts.length > 0) {
			try {
				await store.recordReplayConflicts(conflicts);
			} catch (error) {
				console.error("Stream health replay conflict persistence failed:", error);
				return {
					ok: false,
					status: 500,
					error: "Stream health replay conflict persistence failed",
				};
			}
			return { ok: false, status: 409, error: "Stream health replay conflict" };
		}

		if (existing.length > 0) {
			return {
				ok: true,
				inserted: 0,
				replayed: true,
				batchId: validation.batchId,
			};
		}

		try {
			await inserter(STREAM_HEALTH_TABLE, validation.rows, {
				deduplicationToken: validation.batchId,
			});
			return {
				ok: true,
				inserted: validation.rows.length,
				replayed: false,
				batchId: validation.batchId,
			};
		} catch (error) {
			console.error("Stream health archive insert failed:", error);
			return {
				ok: false,
				status: 500,
				error: "Stream health archive insert failed",
			};
		}
	});
}

export function createClickHouseStreamHealthReplayStore(
	client: ClickHouseClient,
): StreamHealthReplayStore {
	return {
		async findExistingSnapshots(snapshotIds) {
			if (snapshotIds.length === 0) return [];
			const result = await client.query({
				query:
					"SELECT snapshot_id, payload_sha256, payload_json FROM broker_stream_health.snapshots WHERE snapshot_id IN ({snapshot_ids:Array(String)})",
				query_params: { snapshot_ids: [...snapshotIds] },
				format: "JSONEachRow",
				abort_signal: clickHouseRequestDeadline(),
			});
			const rows = (await result.json()) as Array<{
				snapshot_id: string;
				payload_sha256: string;
				payload_json: string;
			}>;
			return rows.map((row) => ({
				snapshotId: row.snapshot_id,
				payloadSha256: row.payload_sha256,
				payloadJson: row.payload_json,
			}));
		},
		async recordReplayConflicts(conflicts) {
			if (conflicts.length === 0) return;
			await client.insert({
				table: "broker_stream_health.replay_conflicts",
				values: conflicts.map((conflict) => ({
					batch_id: conflict.batchId,
					snapshot_id: conflict.snapshotId,
					conflict_kind: conflict.conflictKind,
					existing_payload_sha256: conflict.existingPayloadSha256,
					incoming_payload_sha256: conflict.incomingPayloadSha256,
					existing_payload_json: conflict.existingPayloadJson,
					incoming_payload_json: conflict.incomingPayloadJson,
				})),
				format: "JSONEachRow",
				abort_signal: clickHouseRequestDeadline(),
			});
		},
	};
}
