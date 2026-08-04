import { describe, expect, test } from "bun:test";
import { handleArchiveRequest } from "../services/archive-forwarder/request";
import {
	deriveStreamHealthBatchId,
	deriveStreamHealthSnapshotId,
	type ExistingStreamHealthSnapshot,
	insertStreamHealthArchiveBatch,
	type StreamHealthReplayConflict,
	type StreamHealthReplayStore,
	validateStreamHealthArchiveBatch,
} from "../services/archive-forwarder/stream-health-contract";
import {
	ArchiveForwarderTelemetry,
	type ArchiveMetricsRecorder,
} from "../services/archive-forwarder/telemetry";

const noopRecorder: ArchiveMetricsRecorder = {
	recordCounter: () => {},
	setObservableGauge: () => {},
};

const producerId = "broker-a";
const producerEpoch = "7";
const runId = "11111111-1111-4111-8111-111111111111";
const registryRevision = "a".repeat(64);
const batchSequence = "12";

function streamKey(accountSelector: string): string {
	return `exchange:binance|account:${accountSelector}|stream:user_data|scope:spot`;
}

function entry(
	accountSelector: string,
	sequence: string,
): {
	table: "broker_stream_health.snapshots";
	row: Record<string, unknown>;
} {
	return {
		table: "broker_stream_health.snapshots",
		row: {
			source: "broker_write",
			deployment_id: "deploy-a",
			producer_id: producerId,
			producer_epoch: producerEpoch,
			run_id: runId,
			batch_sequence: batchSequence,
			batch_snapshot_count: "0",
			batch_active_stream_count: "0",
			registry_revision: registryRevision,
			registry_status: "active",
			retired_at: null,
			exchange: "Binance",
			account_selector: accountSelector,
			account_role: null,
			stream_kind: "user_data",
			account_scope: "spot",
			sequence,
			state: "connected",
			state_changed_at: "2026-08-03T18:52:21.181Z",
			last_connected_at: "2026-08-03T18:50:21.181Z",
			last_authenticated_at: "2026-08-03T18:50:22.181Z",
			last_received_at: null,
			heartbeat_at: "2026-08-03T18:52:21.181Z",
			connect_attempt_count: "1",
			reconnect_count: "0",
			error_count: "0",
			last_failure_kind: "none",
			last_failure_reason: "",
			traffic_mode: "event_driven",
			source_watermark: null,
		},
	};
}

function healthBatch(
	accounts: readonly string[] = ["primary", "secondary:1"],
): Record<string, unknown> {
	const rows = accounts.map((account, index) =>
		entry(account, String(index + 1)),
	);
	const batchId = deriveStreamHealthBatchId({
		producerId,
		producerEpoch,
		runId,
		batchSequence,
		registryRevision,
	});
	for (const row of rows) {
		const fields = row.row;
		fields.batch_snapshot_count = String(rows.length);
		fields.batch_active_stream_count = String(rows.length);
		const accountSelector = String(fields.account_selector).toLowerCase();
		const sequence = String(fields.sequence);
		fields.stream_key = streamKey(accountSelector);
		fields.snapshot_id = deriveStreamHealthSnapshotId({
			producerId,
			producerEpoch,
			runId,
			streamKey: streamKey(accountSelector),
			sequence,
		});
		fields.batch_id = batchId;
	}
	return { source: "broker_write", deployment_id: "deploy-a", rows };
}

function post(body: unknown): Request {
	return new Request("http://localhost/archive", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function replayStore(
	existing: ExistingStreamHealthSnapshot[] = [],
	options: { failConflictPersistence?: boolean } = {},
): {
	store: StreamHealthReplayStore;
	conflicts: StreamHealthReplayConflict[];
} {
	const conflicts: StreamHealthReplayConflict[] = [];
	return {
		store: {
			findExistingSnapshots: async (snapshotIds) =>
				existing.filter((row) => snapshotIds.includes(row.snapshotId)),
			recordReplayConflicts: async (rows) => {
				if (options.failConflictPersistence) {
					throw new Error("conflict table unavailable");
				}
				conflicts.push(...rows);
			},
		},
		conflicts,
	};
}

function validated(body: Record<string, unknown>) {
	const result = validateStreamHealthArchiveBatch(body);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result;
}

function firstRawRow(body: Record<string, unknown>): Record<string, unknown> {
	const rows = body.rows as Array<{ row: Record<string, unknown> }>;
	const first = rows[0];
	if (!first) throw new Error("Expected a stream health row");
	return first.row;
}

function firstValidatedRow(body: Record<string, unknown>) {
	const first = validated(body).rows[0];
	if (!first) throw new Error("Expected a validated stream health row");
	return first;
}

describe("broker stream health archive contract", () => {
	test("normalizes all active configured accounts and performs one dedicated insert", async () => {
		const body = healthBatch();
		const { store } = replayStore();
		const inserts: Array<{
			table: string;
			rows: Record<string, unknown>[];
			deduplicationToken?: string;
		}> = [];
		const response = await handleArchiveRequest(post(body), {
			inserter: async (table, rows, options) => {
				inserts.push({
					table,
					rows,
					deduplicationToken: options?.deduplicationToken,
				});
			},
			streamHealthStore: store,
			telemetry: new ArchiveForwarderTelemetry(noopRecorder),
		});

		expect(response.status).toBe(200);
		expect(inserts).toHaveLength(1);
		expect(inserts[0]?.table).toBe("broker_stream_health.snapshots");
		expect(inserts[0]?.rows).toHaveLength(2);
		expect(inserts[0]?.deduplicationToken).toBe(
			deriveStreamHealthBatchId({
				producerId,
				producerEpoch,
				runId,
				batchSequence,
				registryRevision,
			}),
		);
		const first = inserts[0]?.rows[0];
		expect(first?.exchange).toBe("binance");
		expect(first?.last_received_at).toBeNull();
		expect(first?.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(first?.payload_json).toContain('"traffic_mode":"event_driven"');
	});

	test("rejects duplicate streams, incomplete active-account batches, invalid enum values, and table/source mixes", () => {
		const duplicate = healthBatch(["primary", "primary"]);
		expect(validateStreamHealthArchiveBatch(duplicate)).toMatchObject({
			ok: false,
			error: "Duplicate stream_key in stream health batch",
		});

		const incomplete = healthBatch(["primary"]);
		firstRawRow(incomplete).batch_active_stream_count = "2";
		expect(validateStreamHealthArchiveBatch(incomplete).ok).toBe(false);

		const invalidEnum = healthBatch(["primary"]);
		firstRawRow(invalidEnum).state = "healthy";
		expect(validateStreamHealthArchiveBatch(invalidEnum).ok).toBe(false);

		const mixed = healthBatch(["primary"]);
		(mixed.rows as unknown[]).push({
			table: "market_data.cex_trades",
			row: { source: "broker_write" },
		});
		expect(validateStreamHealthArchiveBatch(mixed).ok).toBe(false);
	});

	test("derives and validates batch and snapshot ids without trusting producer hashes", () => {
		const body = healthBatch(["primary"]);
		const row = firstRawRow(body);
		row.snapshot_id = "b".repeat(64);
		expect(validateStreamHealthArchiveBatch(body)).toMatchObject({
			ok: false,
			error: "snapshot_id does not match normalized stream identity",
		});

		const hashBody = healthBatch(["primary"]);
		const hashRow = firstRawRow(hashBody);
		hashRow.payload_sha256 = "b".repeat(64);
		expect(validateStreamHealthArchiveBatch(hashBody)).toMatchObject({
			ok: false,
			error: "payload_sha256 does not match canonical stream health payload",
		});
	});

	test("redacts and bounds failure diagnostics before they reach ClickHouse", () => {
		const body = healthBatch(["primary"]);
		const row = firstRawRow(body);
		row.state = "error";
		row.last_failure_kind = "auth_failed";
		row.last_failure_reason =
			"Authorization: Bearer never-store-this apiKey=also-never-store-this";
		const result = firstValidatedRow(body);
		expect(result.last_failure_reason).toContain("[redacted]");
		expect(result.last_failure_reason).not.toContain("never-store-this");
		expect(result.last_failure_reason.length).toBeLessThanOrEqual(256);
	});

	test("keeps retired registry entries and disconnected state distinct from active quiet streams", () => {
		const body = healthBatch();
		const rows = body.rows as Array<{ row: Record<string, unknown> }>;
		const retired = rows[1]?.row;
		if (!retired) throw new Error("Expected a retired stream health row");
		retired.registry_status = "retired";
		retired.retired_at = "2026-08-03T18:51:21.181Z";
		retired.state = "disconnected";
		retired.last_failure_kind = "remote_closed";
		retired.last_failure_reason = "remote close";
		for (const row of rows) {
			row.row.batch_active_stream_count = "1";
		}

		const result = validated(body);
		expect(result.rows).toHaveLength(2);
		expect(result.rows[0]?.last_received_at).toBeNull();
		expect(result.rows[1]).toMatchObject({
			registry_status: "retired",
			state: "disconnected",
			last_failure_kind: "remote_closed",
		});
	});

	test("treats an entire exact replay as success without another candidate insert", async () => {
		const validation = validated(healthBatch());
		const { store } = replayStore(
			validation.rows.map((row) => ({
				snapshotId: row.snapshot_id,
				payloadSha256: row.payload_sha256,
				payloadJson: row.payload_json,
			})),
		);
		let insertCount = 0;
		const result = await insertStreamHealthArchiveBatch(
			async () => {
				insertCount += 1;
			},
			store,
			validation,
		);

		expect(result).toMatchObject({ ok: true, inserted: 0, replayed: true });
		expect(insertCount).toBe(0);
	});

	test("dedupes exact race duplicates but fails closed when any existing snapshot has multiple hashes", async () => {
		const validation = validated(healthBatch(["primary"]));
		const snapshot = firstValidatedRow(healthBatch(["primary"]));
		const duplicateStore = replayStore([
			{
				snapshotId: snapshot.snapshot_id,
				payloadSha256: snapshot.payload_sha256,
				payloadJson: snapshot.payload_json,
			},
			{
				snapshotId: snapshot.snapshot_id,
				payloadSha256: snapshot.payload_sha256,
				payloadJson: snapshot.payload_json,
			},
		]);
		expect(
			await insertStreamHealthArchiveBatch(
				async () => {},
				duplicateStore.store,
				validation,
			),
		).toMatchObject({ ok: true, replayed: true });

		const conflictingStore = replayStore([
			{
				snapshotId: snapshot.snapshot_id,
				payloadSha256: snapshot.payload_sha256,
				payloadJson: snapshot.payload_json,
			},
			{
				snapshotId: snapshot.snapshot_id,
				payloadSha256: "c".repeat(64),
				payloadJson: "{}",
			},
		]);
		let inserted = false;
		const result = await insertStreamHealthArchiveBatch(
			async () => {
				inserted = true;
			},
			conflictingStore.store,
			validation,
		);
		expect(result).toMatchObject({ ok: false, status: 409 });
		expect(conflictingStore.conflicts[0]?.conflictKind).toBe(
			"multiple_existing_hashes",
		);
		expect(inserted).toBe(false);
	});

	test("does not insert a partial replay or a same-id different payload", async () => {
		const validation = validated(healthBatch());
		const first = firstValidatedRow(healthBatch());
		const partialStore = replayStore([
			{
				snapshotId: first.snapshot_id,
				payloadSha256: first.payload_sha256,
				payloadJson: first.payload_json,
			},
		]);
		let inserted = false;
		const partial = await insertStreamHealthArchiveBatch(
			async () => {
				inserted = true;
			},
			partialStore.store,
			validation,
		);
		expect(partial).toMatchObject({ ok: false, status: 409 });
		expect(partialStore.conflicts).toHaveLength(2);
		expect(inserted).toBe(false);

		const mismatchStore = replayStore([
			{
				snapshotId: first.snapshot_id,
				payloadSha256: "d".repeat(64),
				payloadJson: '{"other":true}',
			},
		]);
		const mismatch = await insertStreamHealthArchiveBatch(
			async () => {},
			mismatchStore.store,
			validated(healthBatch(["primary"])),
		);
		expect(mismatch).toMatchObject({ ok: false, status: 409 });
		expect(mismatchStore.conflicts[0]?.conflictKind).toBe("payload_mismatch");
	});

	test("serializes lookup and insertion so a concurrent conflicting delivery cannot pass", async () => {
		const first = validated(healthBatch(["primary"]));
		const conflictingBody = healthBatch(["primary"]);
		const conflictingRow = firstRawRow(conflictingBody);
		conflictingRow.state = "error";
		conflictingRow.last_failure_kind = "transport_error";
		conflictingRow.last_failure_reason = "socket closed";
		const conflicting = validated(conflictingBody);
		const existing: ExistingStreamHealthSnapshot[] = [];
		const { store, conflicts } = replayStore(existing);
		const inserter = async (
			_table: string,
			rows: Record<string, unknown>[],
		) => {
			for (const row of rows) {
				existing.push({
					snapshotId: String(row.snapshot_id),
					payloadSha256: String(row.payload_sha256),
					payloadJson: String(row.payload_json),
				});
			}
		};

		const [firstResult, conflictingResult] = await Promise.all([
			insertStreamHealthArchiveBatch(inserter, store, first),
			insertStreamHealthArchiveBatch(inserter, store, conflicting),
		]);

		expect(firstResult).toMatchObject({ ok: true, inserted: 1 });
		expect(conflictingResult).toMatchObject({ ok: false, status: 409 });
		expect(existing).toHaveLength(1);
		expect(conflicts[0]?.conflictKind).toBe("payload_mismatch");
	});

	test("fails closed when recording a replay conflict fails", async () => {
		const validation = validated(healthBatch(["primary"]));
		const snapshot = firstValidatedRow(healthBatch(["primary"]));
		const { store } = replayStore(
			[
				{
					snapshotId: snapshot.snapshot_id,
					payloadSha256: "e".repeat(64),
					payloadJson: "{}",
				},
			],
			{ failConflictPersistence: true },
		);
		let inserted = false;
		const result = await insertStreamHealthArchiveBatch(
			async () => {
				inserted = true;
			},
			store,
			validation,
		);
		expect(result).toMatchObject({ ok: false, status: 500 });
		expect(inserted).toBe(false);
	});
});
