-- Durable, source-authoritative CEX user-stream health snapshots.
-- NO TTL: quiet, disconnected, and failed states are replay evidence.

CREATE DATABASE IF NOT EXISTS broker_stream_health;

CREATE TABLE IF NOT EXISTS broker_stream_health.snapshots
(
    schema_version LowCardinality(String),
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    producer_id LowCardinality(String),
    producer_epoch UInt64,
    run_id UUID,
    batch_id FixedString(64),
    batch_sequence UInt64,
    batch_snapshot_count UInt32,
    batch_active_stream_count UInt32,
    registry_revision FixedString(64),
    registry_status Enum8('active' = 1, 'retired' = 2),
    retired_at Nullable(DateTime64(3, 'UTC')),
    snapshot_id FixedString(64),
    stream_key String,
    exchange LowCardinality(String),
    account_selector LowCardinality(String),
    account_role LowCardinality(Nullable(String)),
    stream_kind LowCardinality(String),
    account_scope LowCardinality(String),
    sequence UInt64,
    state Enum8('connecting' = 1, 'connected' = 2, 'disconnected' = 3, 'error' = 4),
    state_changed_at DateTime64(3, 'UTC'),
    last_connected_at Nullable(DateTime64(3, 'UTC')),
    last_authenticated_at Nullable(DateTime64(3, 'UTC')),
    last_received_at Nullable(DateTime64(3, 'UTC')),
    heartbeat_at DateTime64(3, 'UTC'),
    connect_attempt_count UInt64,
    reconnect_count UInt64,
    error_count UInt64,
    last_failure_kind Enum8(
        'none' = 0,
        'auth_failed' = 1,
        'transport_error' = 2,
        'remote_closed' = 3,
        'protocol_error' = 4,
        'backpressure' = 5,
        'unsupported_connector' = 6,
        'shutdown' = 7
    ),
    last_failure_reason String,
    traffic_mode Enum8('event_driven' = 1, 'continuous' = 2, 'unknown' = 3),
    source_watermark Nullable(String),
    payload_sha256 FixedString(64),
    payload_json String,
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(heartbeat_at)
ORDER BY (producer_id, producer_epoch, run_id, stream_key, sequence, snapshot_id);

-- A collision is never reconciled by a reader. The forwarder records the
-- evidence separately and fails the whole candidate batch closed.
CREATE TABLE IF NOT EXISTS broker_stream_health.replay_conflicts
(
    detected_at DateTime64(3, 'UTC') DEFAULT now64(3),
    batch_id FixedString(64),
    snapshot_id FixedString(64),
    conflict_kind Enum8(
        'payload_mismatch' = 1,
        'partial_batch' = 2,
        'multiple_existing_hashes' = 3
    ),
    existing_payload_sha256 String,
    incoming_payload_sha256 FixedString(64),
    existing_payload_json String,
    incoming_payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(detected_at)
ORDER BY (snapshot_id, detected_at);
