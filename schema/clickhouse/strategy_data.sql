-- Strategy runtime archive tables (Maker hb_runtime bridge; FIET-909/FIET-924).
--
-- Maker performs one non-blocking HTTP attempt. For source=hb_runtime and the
-- five tables below, the archive forwarder accepts ownership only after an
-- atomic SQLite spool commit, returns 202, and retries each table independently.
-- All other archive sources remain on the direct ClickHouse path.
--
-- Canonical producer/stream fields retain their historical defaults.
-- Incompatible existing tables are refused, never upgraded during startup.
-- NO TTL: replay-critical strategy history is retained indefinitely.

CREATE DATABASE IF NOT EXISTS strategy_data;

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
    producer_id String DEFAULT '',
    producer_run_id String DEFAULT '',
    stream_name LowCardinality(String) DEFAULT '',
    stream_seq UInt64 DEFAULT 0,
    seq UInt64 DEFAULT 0,
    archive_event_id String DEFAULT '',
    tick_id String DEFAULT '',
    policy_revision String DEFAULT '',
    decision_stage LowCardinality(String) DEFAULT '',
    decision_outcome LowCardinality(String) DEFAULT '',
    decision_reason String DEFAULT '',
    source_clock String DEFAULT '',
    action_ids_json String DEFAULT '[]',
    policy_epoch String,
    fidelity LowCardinality(String),
    lag_ms Int64,
    fallback_reason String,
    source_cursor String,
    decision_kind LowCardinality(String),
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (controller_id, trading_pair, event_time_ms)
SETTINGS non_replicated_deduplication_window = 1000000;

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
    producer_id String DEFAULT '',
    producer_run_id String DEFAULT '',
    stream_name LowCardinality(String) DEFAULT '',
    stream_seq UInt64 DEFAULT 0,
    seq UInt64 DEFAULT 0,
    archive_event_id String DEFAULT '',
    content_hash String DEFAULT '',
    revision String DEFAULT '',
    active_from_ms Int64 DEFAULT 0,
    canonical_market_id String DEFAULT '',
    connector_id String DEFAULT '',
    canonical_exchange String DEFAULT '',
    canonical_trading_pair String DEFAULT '',
    source_symbol String DEFAULT '',
    base_asset LowCardinality(String) DEFAULT '',
    quote_asset LowCardinality(String) DEFAULT '',
    access_policy_id String DEFAULT '',
    snapshot_reason LowCardinality(String),
    policy_epoch String,
    config_file_path String,
    source_hash String,
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (controller_id, trading_pair, event_time_ms)
SETTINGS non_replicated_deduplication_window = 1000000;

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
    producer_id String DEFAULT '',
    producer_run_id String DEFAULT '',
    stream_name LowCardinality(String) DEFAULT '',
    stream_seq UInt64 DEFAULT 0,
    seq UInt64 DEFAULT 0,
    archive_event_id String DEFAULT '',
    content_hash String DEFAULT '',
    revision String DEFAULT '',
    active_from_ms Int64 DEFAULT 0,
    canonical_market_id String DEFAULT '',
    connector_id String DEFAULT '',
    canonical_exchange String DEFAULT '',
    canonical_trading_pair String DEFAULT '',
    source_symbol String DEFAULT '',
    base_asset LowCardinality(String) DEFAULT '',
    quote_asset LowCardinality(String) DEFAULT '',
    access_policy_id String DEFAULT '',
    snapshot_reason LowCardinality(String),
    source_hash String,
    core_pool_id String,
    canonical_core_pool_id String,
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (canonical_core_pool_id, event_time_ms)
SETTINGS non_replicated_deduplication_window = 1000000;

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
    producer_id String DEFAULT '',
    producer_run_id String DEFAULT '',
    stream_name LowCardinality(String) DEFAULT '',
    stream_seq UInt64 DEFAULT 0,
    seq UInt64 DEFAULT 0,
    archive_event_id String DEFAULT '',
    content_hash String DEFAULT '',
    revision String DEFAULT '',
    active_from_ms Int64 DEFAULT 0,
    canonical_market_id String DEFAULT '',
    connector_id String DEFAULT '',
    canonical_exchange String DEFAULT '',
    canonical_trading_pair String DEFAULT '',
    source_symbol String DEFAULT '',
    base_asset LowCardinality(String) DEFAULT '',
    quote_asset LowCardinality(String) DEFAULT '',
    access_policy_id String DEFAULT '',
    snapshot_reason LowCardinality(String),
    source_hash String,
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (exchange, trading_pair, event_time_ms)
SETTINGS non_replicated_deduplication_window = 1000000;

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
    producer_id String DEFAULT '',
    producer_run_id String DEFAULT '',
    stream_name LowCardinality(String) DEFAULT '',
    stream_seq UInt64 DEFAULT 0,
    seq UInt64 DEFAULT 0,
    archive_event_id String DEFAULT '',
    event_kind LowCardinality(String),
    token LowCardinality(String),
    account LowCardinality(String),
    reservation_id String,
    workflow_state LowCardinality(String),
    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (controller_id, trading_pair, event_time_ms)
SETTINGS non_replicated_deduplication_window = 1000000;

