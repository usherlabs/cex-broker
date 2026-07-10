-- Strategy runtime archive tables (HB external-strategy bridge, FIET-924).
--
-- Cross-repo contract between this forwarder (DDL + validation) and the
-- fiet-maker HB bridge (row producer). Column and table NAMES are the contract:
-- do not rename them here without changing the producer in lockstep.
-- Derived from Linear specs FIET-904 (policy clock), FIET-905 (policy/identity
-- snapshots), FIET-906 (inventory/settlement), FIET-909 (provenance).
--
-- Rows arrive through the archive forwarder (HTTP POST /archive) with the batch
-- envelope source = "hb_runtime".
--
-- NO TTL: replay-critical strategy history, retained indefinitely.

CREATE DATABASE IF NOT EXISTS strategy_data;

-- One row per control-loop evaluation that produces a Layer12 decision (FIET-904).
CREATE TABLE IF NOT EXISTS strategy_data.policy_evaluation_events
(
    event_time_ms Int64,
    emitted_at_ms Int64,
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    schema_version LowCardinality(String),
    controller_id String,
    controller_type LowCardinality(String),
    connector_name LowCardinality(String),
    exchange LowCardinality(String),
    trading_pair LowCardinality(String),
    market_id String,
    run_id String,

    policy_epoch String,
    fidelity LowCardinality(String),
    lag_ms Int64,
    fallback_reason String,
    -- Durable replay provenance cursor ("block:<n>:log:<i>"), empty when not derived from a chain cursor.
    source_cursor String,
    decision_kind LowCardinality(String),
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (controller_id, trading_pair, event_time_ms);

ALTER TABLE strategy_data.policy_evaluation_events
ADD COLUMN IF NOT EXISTS source_cursor String AFTER fallback_reason;

-- Append-only versioned snapshots of the effective controller/ladder config
-- on start and on config/policy change, hash-gated (FIET-905).
CREATE TABLE IF NOT EXISTS strategy_data.strategy_policy_snapshots
(
    event_time_ms Int64,
    emitted_at_ms Int64,
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    schema_version LowCardinality(String),
    controller_id String,
    controller_type LowCardinality(String),
    connector_name LowCardinality(String),
    exchange LowCardinality(String),
    trading_pair LowCardinality(String),
    market_id String,
    run_id String,

    snapshot_reason LowCardinality(String),
    policy_epoch String,
    config_file_path String,
    source_hash String,
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (controller_id, trading_pair, event_time_ms);

-- Append-only market identity snapshots keyed by canonical core pool id; the
-- latest row with event_time_ms <= t is the identity active at t (FIET-905).
CREATE TABLE IF NOT EXISTS strategy_data.market_identity
(
    event_time_ms Int64,
    emitted_at_ms Int64,
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    schema_version LowCardinality(String),
    controller_id String,
    controller_type LowCardinality(String),
    connector_name LowCardinality(String),
    exchange LowCardinality(String),
    trading_pair LowCardinality(String),
    market_id String,
    run_id String,

    snapshot_reason LowCardinality(String),
    source_hash String,
    core_pool_id String,
    canonical_core_pool_id String,
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (canonical_core_pool_id, event_time_ms);

-- Append-only CEX routeability snapshots keyed by exchange + trading_pair
-- (FIET-905).
CREATE TABLE IF NOT EXISTS strategy_data.symbol_mapping
(
    event_time_ms Int64,
    emitted_at_ms Int64,
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    schema_version LowCardinality(String),
    controller_id String,
    controller_type LowCardinality(String),
    connector_name LowCardinality(String),
    exchange LowCardinality(String),
    trading_pair LowCardinality(String),
    market_id String,
    run_id String,

    snapshot_reason LowCardinality(String),
    source_hash String,
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (exchange, trading_pair, event_time_ms);

-- Inventory snapshots (and, later, reservation/funding facts) on change with a
-- periodic heartbeat, hash-gated (FIET-906).
CREATE TABLE IF NOT EXISTS strategy_data.inventory_settlement_events
(
    event_time_ms Int64,
    emitted_at_ms Int64,
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    schema_version LowCardinality(String),
    controller_id String,
    controller_type LowCardinality(String),
    connector_name LowCardinality(String),
    exchange LowCardinality(String),
    trading_pair LowCardinality(String),
    market_id String,
    run_id String,

    event_kind LowCardinality(String),
    token LowCardinality(String),
    account LowCardinality(String),
    reservation_id String,
    workflow_state LowCardinality(String),
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (controller_id, trading_pair, event_time_ms);
