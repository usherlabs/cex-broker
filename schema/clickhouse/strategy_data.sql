-- Strategy runtime archive tables (Maker hb_runtime bridge; FIET-909/FIET-924).
--
-- Maker performs one non-blocking HTTP attempt. For source=hb_runtime and the
-- five tables below, the archive forwarder accepts ownership only after an
-- atomic SQLite spool commit, returns 202, and retries each table independently.
-- All other archive sources remain on the direct ClickHouse path.
--
-- The v2 producer/stream fields are additive and defaulted so historical v1
-- rows remain readable. Deploy this schema/forwarder before a v2 producer.
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

-- Additive migration for tables created by the v1 forwarder. Existing values
-- remain intact; defaults represent unavailable producer/stream evidence.
ALTER TABLE strategy_data.policy_evaluation_events
    ADD COLUMN IF NOT EXISTS producer_id String DEFAULT '' AFTER run_id,
    ADD COLUMN IF NOT EXISTS producer_run_id String DEFAULT '' AFTER producer_id,
    ADD COLUMN IF NOT EXISTS stream_name LowCardinality(String) DEFAULT '' AFTER producer_run_id,
    ADD COLUMN IF NOT EXISTS stream_seq UInt64 DEFAULT 0 AFTER stream_name,
    ADD COLUMN IF NOT EXISTS seq UInt64 DEFAULT 0 AFTER stream_seq,
    ADD COLUMN IF NOT EXISTS archive_event_id String DEFAULT '' AFTER seq,
    ADD COLUMN IF NOT EXISTS tick_id String DEFAULT '' AFTER archive_event_id,
    ADD COLUMN IF NOT EXISTS policy_revision String DEFAULT '' AFTER tick_id,
    ADD COLUMN IF NOT EXISTS decision_stage LowCardinality(String) DEFAULT '' AFTER policy_revision,
    ADD COLUMN IF NOT EXISTS decision_outcome LowCardinality(String) DEFAULT '' AFTER decision_stage,
    ADD COLUMN IF NOT EXISTS decision_reason String DEFAULT '' AFTER decision_outcome,
    ADD COLUMN IF NOT EXISTS source_clock String DEFAULT '' AFTER decision_reason,
    ADD COLUMN IF NOT EXISTS action_ids_json String DEFAULT '[]' AFTER source_clock,
    ADD COLUMN IF NOT EXISTS source_cursor String AFTER fallback_reason;

ALTER TABLE strategy_data.strategy_policy_snapshots
    ADD COLUMN IF NOT EXISTS producer_id String DEFAULT '' AFTER run_id,
    ADD COLUMN IF NOT EXISTS producer_run_id String DEFAULT '' AFTER producer_id,
    ADD COLUMN IF NOT EXISTS stream_name LowCardinality(String) DEFAULT '' AFTER producer_run_id,
    ADD COLUMN IF NOT EXISTS stream_seq UInt64 DEFAULT 0 AFTER stream_name,
    ADD COLUMN IF NOT EXISTS seq UInt64 DEFAULT 0 AFTER stream_seq,
    ADD COLUMN IF NOT EXISTS archive_event_id String DEFAULT '' AFTER seq,
    ADD COLUMN IF NOT EXISTS content_hash String DEFAULT '' AFTER archive_event_id,
    ADD COLUMN IF NOT EXISTS revision String DEFAULT '' AFTER content_hash,
    ADD COLUMN IF NOT EXISTS active_from_ms Int64 DEFAULT 0 AFTER revision,
    ADD COLUMN IF NOT EXISTS canonical_market_id String DEFAULT '' AFTER active_from_ms,
    ADD COLUMN IF NOT EXISTS connector_id String DEFAULT '' AFTER canonical_market_id,
    ADD COLUMN IF NOT EXISTS canonical_exchange String DEFAULT '' AFTER connector_id,
    ADD COLUMN IF NOT EXISTS canonical_trading_pair String DEFAULT '' AFTER canonical_exchange,
    ADD COLUMN IF NOT EXISTS source_symbol String DEFAULT '' AFTER canonical_trading_pair,
    ADD COLUMN IF NOT EXISTS base_asset LowCardinality(String) DEFAULT '' AFTER source_symbol,
    ADD COLUMN IF NOT EXISTS quote_asset LowCardinality(String) DEFAULT '' AFTER base_asset,
    ADD COLUMN IF NOT EXISTS access_policy_id String DEFAULT '' AFTER quote_asset;

ALTER TABLE strategy_data.market_identity
    ADD COLUMN IF NOT EXISTS producer_id String DEFAULT '' AFTER run_id,
    ADD COLUMN IF NOT EXISTS producer_run_id String DEFAULT '' AFTER producer_id,
    ADD COLUMN IF NOT EXISTS stream_name LowCardinality(String) DEFAULT '' AFTER producer_run_id,
    ADD COLUMN IF NOT EXISTS stream_seq UInt64 DEFAULT 0 AFTER stream_name,
    ADD COLUMN IF NOT EXISTS seq UInt64 DEFAULT 0 AFTER stream_seq,
    ADD COLUMN IF NOT EXISTS archive_event_id String DEFAULT '' AFTER seq,
    ADD COLUMN IF NOT EXISTS content_hash String DEFAULT '' AFTER archive_event_id,
    ADD COLUMN IF NOT EXISTS revision String DEFAULT '' AFTER content_hash,
    ADD COLUMN IF NOT EXISTS active_from_ms Int64 DEFAULT 0 AFTER revision,
    ADD COLUMN IF NOT EXISTS canonical_market_id String DEFAULT '' AFTER active_from_ms,
    ADD COLUMN IF NOT EXISTS connector_id String DEFAULT '' AFTER canonical_market_id,
    ADD COLUMN IF NOT EXISTS canonical_exchange String DEFAULT '' AFTER connector_id,
    ADD COLUMN IF NOT EXISTS canonical_trading_pair String DEFAULT '' AFTER canonical_exchange,
    ADD COLUMN IF NOT EXISTS source_symbol String DEFAULT '' AFTER canonical_trading_pair,
    ADD COLUMN IF NOT EXISTS base_asset LowCardinality(String) DEFAULT '' AFTER source_symbol,
    ADD COLUMN IF NOT EXISTS quote_asset LowCardinality(String) DEFAULT '' AFTER base_asset,
    ADD COLUMN IF NOT EXISTS access_policy_id String DEFAULT '' AFTER quote_asset;

ALTER TABLE strategy_data.symbol_mapping
    ADD COLUMN IF NOT EXISTS producer_id String DEFAULT '' AFTER run_id,
    ADD COLUMN IF NOT EXISTS producer_run_id String DEFAULT '' AFTER producer_id,
    ADD COLUMN IF NOT EXISTS stream_name LowCardinality(String) DEFAULT '' AFTER producer_run_id,
    ADD COLUMN IF NOT EXISTS stream_seq UInt64 DEFAULT 0 AFTER stream_name,
    ADD COLUMN IF NOT EXISTS seq UInt64 DEFAULT 0 AFTER stream_seq,
    ADD COLUMN IF NOT EXISTS archive_event_id String DEFAULT '' AFTER seq,
    ADD COLUMN IF NOT EXISTS content_hash String DEFAULT '' AFTER archive_event_id,
    ADD COLUMN IF NOT EXISTS revision String DEFAULT '' AFTER content_hash,
    ADD COLUMN IF NOT EXISTS active_from_ms Int64 DEFAULT 0 AFTER revision,
    ADD COLUMN IF NOT EXISTS canonical_market_id String DEFAULT '' AFTER active_from_ms,
    ADD COLUMN IF NOT EXISTS connector_id String DEFAULT '' AFTER canonical_market_id,
    ADD COLUMN IF NOT EXISTS canonical_exchange String DEFAULT '' AFTER connector_id,
    ADD COLUMN IF NOT EXISTS canonical_trading_pair String DEFAULT '' AFTER canonical_exchange,
    ADD COLUMN IF NOT EXISTS source_symbol String DEFAULT '' AFTER canonical_trading_pair,
    ADD COLUMN IF NOT EXISTS base_asset LowCardinality(String) DEFAULT '' AFTER source_symbol,
    ADD COLUMN IF NOT EXISTS quote_asset LowCardinality(String) DEFAULT '' AFTER base_asset,
    ADD COLUMN IF NOT EXISTS access_policy_id String DEFAULT '' AFTER quote_asset;

ALTER TABLE strategy_data.inventory_settlement_events
    ADD COLUMN IF NOT EXISTS producer_id String DEFAULT '' AFTER run_id,
    ADD COLUMN IF NOT EXISTS producer_run_id String DEFAULT '' AFTER producer_id,
    ADD COLUMN IF NOT EXISTS stream_name LowCardinality(String) DEFAULT '' AFTER producer_run_id,
    ADD COLUMN IF NOT EXISTS stream_seq UInt64 DEFAULT 0 AFTER stream_name,
    ADD COLUMN IF NOT EXISTS seq UInt64 DEFAULT 0 AFTER stream_seq,
    ADD COLUMN IF NOT EXISTS archive_event_id String DEFAULT '' AFTER seq;

ALTER TABLE strategy_data.policy_evaluation_events
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE strategy_data.strategy_policy_snapshots
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE strategy_data.market_identity
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE strategy_data.symbol_mapping
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE strategy_data.inventory_settlement_events
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
