-- Broker-owned ClickHouse schemas for Maker metrics and financial telemetry.
-- Applied only by services/archive-forwarder/schema.ts.
--
-- Producer definitions live in fiet-maker; source DDL and application live here.
--   fiet_metrics.fiet_metrics ↔ MetricRecord (crates/telemetry/src/metrics.rs)
--   fiet_telemetry.actions    ↔ ActionEvent  (crates/telemetry/src/events.rs)
--   fiet_telemetry.positions  ↔ PositionEvent
--   fiet_telemetry.inventory  ↔ InventoryEvent
--   fiet_telemetry.tx_receipts↔ TxReceiptEvent
--   fiet_telemetry.market_onboarding ↔ MarketOnboardingEvent
--   fiet_telemetry.event_lane_coverage ↔ EventLaneCoverageSnapshot
-- Existing incompatible definitions require separately approved migration.

-- =============================================================================
-- Metrics Database (fiet_metrics)
-- =============================================================================

CREATE DATABASE IF NOT EXISTS fiet_metrics;

-- Main metrics table
-- This table stores all metrics (counters, gauges, histograms) from fiet-maker services
CREATE TABLE IF NOT EXISTS fiet_metrics.fiet_metrics
(
    `timestamp` DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `metric_name` LowCardinality(String) CODEC(ZSTD(1)),
    `metric_type` LowCardinality(String) CODEC(ZSTD(1)),
    `value` Float64 CODEC(ZSTD(1)),
    `labels` String CODEC(ZSTD(1)),
    `service` LowCardinality(String) CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (service, metric_name, toUnixTimestamp(timestamp))
TTL toDateTime(timestamp) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1;

-- Materialized views for common queries (optional, for performance)
-- NOTE: CH 25.12 disallows aliasing a column with the same name as the source column
-- (e.g. `toStartOfHour(timestamp) AS timestamp`). We use explicit column definitions
-- and qualify source references as `fiet_metrics.timestamp` to avoid shadowing.

-- Counter metrics aggregated by hour
CREATE MATERIALIZED VIEW IF NOT EXISTS fiet_metrics.fiet_metrics_counter_hourly
(
    `service` LowCardinality(String),
    `metric_name` LowCardinality(String),
    `labels` String,
    `timestamp` DateTime('UTC'),
    `total_value` Float64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (service, metric_name, labels, timestamp)
AS SELECT
    service,
    metric_name,
    labels,
    toStartOfHour(fiet_metrics.timestamp) AS timestamp,
    sum(value) AS total_value
FROM fiet_metrics.fiet_metrics
WHERE metric_type = 'counter'
GROUP BY service, metric_name, labels, timestamp;

-- Gauge metrics (latest value per service/metric/labels)
CREATE MATERIALIZED VIEW IF NOT EXISTS fiet_metrics.fiet_metrics_gauge_latest
(
    `service` LowCardinality(String),
    `metric_name` LowCardinality(String),
    `labels` String,
    `timestamp` DateTime64(9, 'UTC'),
    `value` Float64
)
ENGINE = ReplacingMergeTree(timestamp)
PARTITION BY toDate(timestamp)
ORDER BY (service, metric_name, labels)
AS SELECT
    service,
    metric_name,
    labels,
    fiet_metrics.timestamp AS timestamp,
    value
FROM fiet_metrics.fiet_metrics
WHERE metric_type = 'gauge';

-- Histogram metrics aggregated by hour
CREATE MATERIALIZED VIEW IF NOT EXISTS fiet_metrics.fiet_metrics_histogram_hourly
(
    `service` LowCardinality(String),
    `metric_name` LowCardinality(String),
    `labels` String,
    `timestamp` DateTime('UTC'),
    `avg_value` AggregateFunction(avg, Float64),
    `min_value` AggregateFunction(min, Float64),
    `max_value` AggregateFunction(max, Float64),
    `count_value` AggregateFunction(count)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (service, metric_name, labels, timestamp)
AS SELECT
    service,
    metric_name,
    labels,
    toStartOfHour(fiet_metrics.timestamp) AS timestamp,
    avgState(value) AS avg_value,
    minState(value) AS min_value,
    maxState(value) AS max_value,
    countState() AS count_value
FROM fiet_metrics.fiet_metrics
WHERE metric_type = 'histogram'
GROUP BY service, metric_name, labels, timestamp;

-- =============================================================================
-- Financial Telemetry Facts (fiet_telemetry database)
-- =============================================================================
-- These tables store financial facts: actions, positions, inventory snapshots.
-- Used for analysis, debugging, and PnL calculations.

CREATE DATABASE IF NOT EXISTS fiet_telemetry;

-- Actions table: Records all trading actions (swaps, mints, burns, etc.)
CREATE TABLE IF NOT EXISTS fiet_telemetry.actions
(
    `timestamp` DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `action_id` String CODEC(ZSTD(1)),
    `run_id` String CODEC(ZSTD(1)),
    `plan_id` String CODEC(ZSTD(1)),
    `plan_uuid` UUID CODEC(ZSTD(1)),
    `action_type` LowCardinality(String) CODEC(ZSTD(1)),
    `pool_key` String CODEC(ZSTD(1)),
    `amount_specified` Decimal(38, 18) CODEC(ZSTD(1)),
    `zero_for_one` Bool CODEC(ZSTD(1)),
    `status` LowCardinality(String) CODEC(ZSTD(1)),
    `tx_hash` Nullable(String) CODEC(ZSTD(1)),
    `service` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    `labels` String CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (pool_key, toDate(timestamp), action_type, timestamp)
TTL toDateTime(timestamp) + toIntervalDay(90)
SETTINGS ttl_only_drop_parts = 1;

-- Two row families share this table: hydrate/sync are absolute position snapshots
-- without provenance; open/modify/close are signed lifecycle deltas with tx/plan provenance.
CREATE TABLE IF NOT EXISTS fiet_telemetry.positions
(
    `timestamp` DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `position_id` String CODEC(ZSTD(1)),
    `pool_key` String CODEC(ZSTD(1)),
    `tick_lower` Nullable(Int32) CODEC(ZSTD(1)),
    `tick_upper` Nullable(Int32) CODEC(ZSTD(1)),
    `liquidity` Nullable(Decimal(38, 18)) CODEC(ZSTD(1)),
    `event_type` LowCardinality(String) CODEC(ZSTD(1)),
    `tx_hash` Nullable(String) CODEC(ZSTD(1)),
    `plan_uuid` Nullable(UUID) CODEC(ZSTD(1)),
    `labels` String CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (pool_key, toDate(timestamp), position_id, timestamp)
TTL toDateTime(timestamp) + toIntervalDay(90)
SETTINGS ttl_only_drop_parts = 1;

-- Inventory table: Periodic snapshots of token balances across locations
CREATE TABLE IF NOT EXISTS fiet_telemetry.inventory
(
    `timestamp` DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `run_id` String CODEC(ZSTD(1)),
    `location` LowCardinality(String) CODEC(ZSTD(1)),
    `pool_key` String CODEC(ZSTD(1)),
    `token` String CODEC(ZSTD(1)),
    -- Raw token amount in base units (U256, always an integer). Scale 0, not 18: a raw
    -- 18-decimal amount already carries 18 magnitude digits, so Decimal(38, 18) (max ~10^20
    -- integer part) overflows and zeroes the higher-decimal leg once a position exceeds ~100
    -- tokens. Scale 0 keeps all 38 integer digits; readers scale by the token's decimals.
    `balance` Decimal(38, 0) CODEC(ZSTD(1)),
    `labels` String CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (pool_key, toDate(timestamp), location, token, timestamp)
TTL toDateTime(timestamp) + toIntervalDay(90)
SETTINGS ttl_only_drop_parts = 1;

-- =============================================================================
-- Semantic Inventory Contract
-- =============================================================================
-- These tables are additive. The generic `inventory` rows above remain legacy
-- telemetry and are never inferred, upgraded, or unioned into this contract.
-- Registry entries are expected facts, not observations. Ownership is an
-- independent dimension from custody: only MARKET entries may carry market_id;
-- SHARED, WRAPPER, and UNALLOCATED entries structurally cannot.
CREATE TABLE IF NOT EXISTS fiet_telemetry.semantic_inventory_registry_versions
(
    `registry_id` LowCardinality(String) CODEC(ZSTD(1)),
    `registry_revision` String CODEC(ZSTD(1)),
    `payload_hash` String CODEC(ZSTD(1)),
    `schema_revision` UInt16 CODEC(ZSTD(1)),
    `published_at` DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `expected_entry_count` UInt32 CODEC(ZSTD(1)),
    CONSTRAINT semantic_registry_id_not_empty CHECK notEmpty(registry_id),
    CONSTRAINT semantic_registry_revision_is_hash CHECK match(toString(registry_revision), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_registry_payload_is_hash CHECK match(toString(payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_registry_not_empty CHECK expected_entry_count > 0
)
ENGINE = ReplacingMergeTree
ORDER BY (registry_id, registry_revision, payload_hash);

CREATE TABLE IF NOT EXISTS fiet_telemetry.semantic_inventory_registry_entries
(
    `registry_id` LowCardinality(String) CODEC(ZSTD(1)),
    `registry_revision` String CODEC(ZSTD(1)),
    `registry_payload_hash` String CODEC(ZSTD(1)),
    `entry_id` String CODEC(ZSTD(1)),
    `entry_payload_hash` String CODEC(ZSTD(1)),
    `schema_revision` UInt16 CODEC(ZSTD(1)),
    `source_domain_id` String CODEC(ZSTD(1)),
    `source_domain_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `source_domain_chain_id` Nullable(UInt64) CODEC(ZSTD(1)),
    `source_domain_wallet_address` Nullable(String) CODEC(ZSTD(1)),
    `source_domain_exchange` Nullable(String) CODEC(ZSTD(1)),
    `source_domain_account_id` Nullable(String) CODEC(ZSTD(1)),
    `source_domain_subaccount_id` Nullable(String) CODEC(ZSTD(1)),
    `subject_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `subject_key` String CODEC(ZSTD(1)),
    `ownership_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `market_id` Nullable(String) CODEC(ZSTD(1)),
    `ownership_scope_id` Nullable(String) CODEC(ZSTD(1)),
    `ownership_wrapper_chain_id` Nullable(UInt64) CODEC(ZSTD(1)),
    `ownership_wrapper_address` Nullable(String) CODEC(ZSTD(1)),
    `holder_locator_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `holder_role` LowCardinality(String) CODEC(ZSTD(1)),
    `holder_chain_id` Nullable(UInt64) CODEC(ZSTD(1)),
    `holder_static_address` Nullable(String) CODEC(ZSTD(1)),
    `holder_queue_mm_position_manager_address` Nullable(String) CODEC(ZSTD(1)),
    `holder_queue_wallet_address` Nullable(String) CODEC(ZSTD(1)),
    `resolved_holder_address` Nullable(String) CODEC(ZSTD(1)),
    `holder_exchange` Nullable(String) CODEC(ZSTD(1)),
    `holder_account_id` Nullable(String) CODEC(ZSTD(1)),
    `holder_subaccount_id` Nullable(String) CODEC(ZSTD(1)),
    `asset_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `asset_chain_id` Nullable(UInt64) CODEC(ZSTD(1)),
    `asset_address` Nullable(String) CODEC(ZSTD(1)),
    `asset_id` Nullable(String) CODEC(ZSTD(1)),
    `asset_symbol` Nullable(String) CODEC(ZSTD(1)),
    `asset_decimals` Nullable(UInt8) CODEC(ZSTD(1)),
    `related_underlying_kind` Nullable(String) CODEC(ZSTD(1)),
    `related_underlying_address` Nullable(String) CODEC(ZSTD(1)),
    `asset_exchange` Nullable(String) CODEC(ZSTD(1)),
    `observation_role` LowCardinality(String) CODEC(ZSTD(1)),
    `lcc_provenance` LowCardinality(String) CODEC(ZSTD(1)),
    CONSTRAINT semantic_entry_registry_revision_is_hash CHECK match(toString(registry_revision), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_entry_registry_payload_is_hash CHECK match(toString(registry_payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_entry_id_is_hash CHECK match(toString(entry_id), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_entry_payload_is_hash CHECK match(toString(entry_payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_entry_source_domain_id_is_hash CHECK match(toString(source_domain_id), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_entry_source_domain_chain_shape CHECK
        (source_domain_kind = 'ON_CHAIN') = isNotNull(source_domain_chain_id),
    CONSTRAINT semantic_entry_source_domain_wallet_shape CHECK
        (source_domain_kind = 'ON_CHAIN') = isNotNull(source_domain_wallet_address),
    CONSTRAINT semantic_entry_source_domain_exchange_shape CHECK
        (source_domain_kind = 'CEX_ACCOUNT') = isNotNull(source_domain_exchange),
    CONSTRAINT semantic_entry_source_domain_account_shape CHECK
        (source_domain_kind = 'CEX_ACCOUNT') = isNotNull(source_domain_account_id),
    CONSTRAINT semantic_entry_source_domain_subaccount_shape CHECK
        source_domain_kind = 'CEX_ACCOUNT' OR isNull(source_domain_subaccount_id),
    CONSTRAINT semantic_entry_source_domain_strings CHECK
        (isNull(source_domain_exchange) OR notEmpty(assumeNotNull(source_domain_exchange)))
        AND (isNull(source_domain_account_id) OR notEmpty(assumeNotNull(source_domain_account_id)))
        AND (isNull(source_domain_subaccount_id) OR notEmpty(assumeNotNull(source_domain_subaccount_id))),
    CONSTRAINT semantic_entry_subject_not_empty CHECK notEmpty(subject_key),
    CONSTRAINT semantic_entry_asset_symbol_not_empty CHECK
        isNull(asset_symbol) OR notEmpty(assumeNotNull(asset_symbol)),
    CONSTRAINT semantic_entry_market_id_scope CHECK
        (ownership_kind = 'MARKET') = isNotNull(market_id),
    CONSTRAINT semantic_entry_market_id_not_empty CHECK
        isNull(market_id) OR notEmpty(assumeNotNull(market_id)),
    CONSTRAINT semantic_entry_named_scope_shape CHECK
        (ownership_kind IN ('SHARED', 'UNALLOCATED')) = isNotNull(ownership_scope_id),
    CONSTRAINT semantic_entry_named_scope_not_empty CHECK
        isNull(ownership_scope_id) OR notEmpty(assumeNotNull(ownership_scope_id)),
    CONSTRAINT semantic_entry_wrapper_chain_shape CHECK
        (ownership_kind = 'WRAPPER') = isNotNull(ownership_wrapper_chain_id),
    CONSTRAINT semantic_entry_wrapper_address_shape CHECK
        (ownership_kind = 'WRAPPER') = isNotNull(ownership_wrapper_address),
    CONSTRAINT semantic_entry_holder_role_shape CHECK
        (holder_locator_kind = 'CEX_ACCOUNT') = (holder_role = 'CEX_ACCOUNT'),
    CONSTRAINT semantic_entry_queue_holder_role_shape CHECK
        (holder_locator_kind = 'QUEUE_CUSTODIAN') = (holder_role = 'QUEUE_CUSTODIAN'),
    CONSTRAINT semantic_entry_holder_chain_shape CHECK
        (holder_locator_kind IN ('STATIC_ON_CHAIN', 'QUEUE_CUSTODIAN')) = isNotNull(holder_chain_id),
    CONSTRAINT semantic_entry_static_holder_shape CHECK
        (holder_locator_kind = 'STATIC_ON_CHAIN') = isNotNull(holder_static_address),
    CONSTRAINT semantic_entry_queue_mmpm_shape CHECK
        (holder_locator_kind = 'QUEUE_CUSTODIAN') = isNotNull(holder_queue_mm_position_manager_address),
    CONSTRAINT semantic_entry_queue_wallet_shape CHECK
        (holder_locator_kind = 'QUEUE_CUSTODIAN') = isNotNull(holder_queue_wallet_address),
    CONSTRAINT semantic_entry_resolved_holder_shape CHECK
        holder_locator_kind = 'QUEUE_CUSTODIAN' OR isNull(resolved_holder_address),
    CONSTRAINT semantic_entry_holder_exchange_shape CHECK
        (holder_locator_kind = 'CEX_ACCOUNT') = isNotNull(holder_exchange),
    CONSTRAINT semantic_entry_holder_exchange_not_empty CHECK
        isNull(holder_exchange) OR notEmpty(assumeNotNull(holder_exchange)),
    CONSTRAINT semantic_entry_holder_account_shape CHECK
        (holder_locator_kind = 'CEX_ACCOUNT') = isNotNull(holder_account_id),
    CONSTRAINT semantic_entry_holder_account_not_empty CHECK
        isNull(holder_account_id) OR notEmpty(assumeNotNull(holder_account_id)),
    CONSTRAINT semantic_entry_holder_subaccount_shape CHECK
        holder_locator_kind = 'CEX_ACCOUNT' OR isNull(holder_subaccount_id),
    CONSTRAINT semantic_entry_holder_subaccount_not_empty CHECK
        isNull(holder_subaccount_id) OR notEmpty(assumeNotNull(holder_subaccount_id)),
    CONSTRAINT semantic_entry_subject_holder_shape CHECK
        (subject_kind = 'CEX_ACCOUNT') = (holder_locator_kind = 'CEX_ACCOUNT'),
    CONSTRAINT semantic_entry_position_holder_role CHECK
        (subject_kind = 'CONFIGURED_POSITION') = (holder_role = 'POSITION_MANAGER'),
    CONSTRAINT semantic_entry_vault_holder_role CHECK
        (subject_kind = 'VAULT') = (holder_role = 'VAULT'),
    CONSTRAINT semantic_entry_wrapper_holder_role CHECK
        (subject_kind = 'WRAPPER') = (holder_role = 'WRAPPER'),
    CONSTRAINT semantic_entry_shared_holder_role CHECK
        subject_kind != 'SHARED_HOLDER'
        OR holder_role IN ('WALLET', 'MM_POSITION_MANAGER', 'QUEUE_CUSTODIAN'),
    CONSTRAINT semantic_entry_shared_subject_scope CHECK
        subject_kind != 'SHARED_HOLDER' OR ownership_kind != 'MARKET',
    CONSTRAINT semantic_entry_wrapper_subject_scope CHECK
        (subject_kind = 'WRAPPER') = (ownership_kind = 'WRAPPER'),
    CONSTRAINT semantic_entry_asset_chain_shape CHECK
        (asset_kind != 'CEX_ASSET') = isNotNull(asset_chain_id),
    CONSTRAINT semantic_entry_asset_address_shape CHECK
        asset_kind = 'UNDERLYING'
        OR (asset_kind = 'LCC' AND isNotNull(asset_address))
        OR (asset_kind IN ('NATIVE_GAS', 'CEX_ASSET') AND isNull(asset_address)),
    CONSTRAINT semantic_entry_native_gas_has_no_address CHECK
        asset_kind != 'NATIVE_GAS' OR isNull(asset_address),
    CONSTRAINT semantic_entry_asset_id_shape CHECK
        (asset_kind = 'CEX_ASSET') = isNotNull(asset_id),
    CONSTRAINT semantic_entry_asset_id_not_empty CHECK
        isNull(asset_id) OR notEmpty(assumeNotNull(asset_id)),
    CONSTRAINT semantic_entry_asset_exchange_shape CHECK
        (asset_kind = 'CEX_ASSET') = isNotNull(asset_exchange),
    CONSTRAINT semantic_entry_asset_exchange_not_empty CHECK
        isNull(asset_exchange) OR notEmpty(assumeNotNull(asset_exchange)),
    CONSTRAINT semantic_entry_cex_has_no_underlying CHECK
        asset_kind != 'CEX_ASSET' OR (isNull(related_underlying_kind) AND isNull(related_underlying_address)),
    CONSTRAINT semantic_entry_related_underlying_scope CHECK
        asset_kind = 'LCC' OR (isNull(related_underlying_kind) AND isNull(related_underlying_address)),
    CONSTRAINT semantic_entry_related_underlying_address_shape CHECK
        (isNull(related_underlying_kind) AND isNull(related_underlying_address))
        OR (related_underlying_kind = 'NATIVE' AND isNull(related_underlying_address))
        OR (related_underlying_kind = 'CONTRACT' AND isNotNull(related_underlying_address)),
    CONSTRAINT semantic_entry_holder_asset_kind_matches CHECK
        (holder_locator_kind = 'CEX_ACCOUNT') = (asset_kind = 'CEX_ASSET'),
    CONSTRAINT semantic_entry_onchain_scope_matches CHECK
        holder_locator_kind = 'CEX_ACCOUNT' OR holder_chain_id = asset_chain_id,
    CONSTRAINT semantic_entry_cex_scope_matches CHECK
        holder_locator_kind != 'CEX_ACCOUNT' OR holder_exchange = asset_exchange,
    CONSTRAINT semantic_entry_source_domain_kind_matches CHECK
        (source_domain_kind = 'CEX_ACCOUNT') = (holder_locator_kind = 'CEX_ACCOUNT'),
    CONSTRAINT semantic_entry_onchain_source_domain_matches CHECK
        source_domain_kind != 'ON_CHAIN'
        OR (source_domain_chain_id = holder_chain_id AND source_domain_chain_id = asset_chain_id),
    CONSTRAINT semantic_entry_wallet_source_domain_matches CHECK
        holder_role != 'WALLET' OR source_domain_wallet_address = holder_static_address,
    CONSTRAINT semantic_entry_queue_source_domain_matches CHECK
        holder_locator_kind != 'QUEUE_CUSTODIAN'
        OR source_domain_wallet_address = holder_queue_wallet_address,
    CONSTRAINT semantic_entry_cex_source_domain_matches CHECK
        source_domain_kind != 'CEX_ACCOUNT'
        OR (source_domain_exchange = holder_exchange
            AND source_domain_exchange = asset_exchange
            AND source_domain_account_id = holder_account_id
            AND ifNull(source_domain_subaccount_id, '') = ifNull(holder_subaccount_id, '')),
    CONSTRAINT semantic_entry_address_shapes CHECK
        (isNull(source_domain_wallet_address) OR match(assumeNotNull(source_domain_wallet_address), '^0x[0-9a-f]{40}$'))
        AND (isNull(holder_static_address) OR match(assumeNotNull(holder_static_address), '^0x[0-9a-f]{40}$'))
        AND (isNull(holder_queue_mm_position_manager_address) OR match(assumeNotNull(holder_queue_mm_position_manager_address), '^0x[0-9a-f]{40}$'))
        AND (isNull(holder_queue_wallet_address) OR match(assumeNotNull(holder_queue_wallet_address), '^0x[0-9a-f]{40}$'))
        AND (isNull(resolved_holder_address) OR match(assumeNotNull(resolved_holder_address), '^0x[0-9a-f]{40}$'))
        AND (isNull(asset_address) OR match(assumeNotNull(asset_address), '^0x[0-9a-f]{40}$'))
        AND (isNull(related_underlying_address) OR match(assumeNotNull(related_underlying_address), '^0x[0-9a-f]{40}$'))
        AND (isNull(ownership_wrapper_address) OR match(assumeNotNull(ownership_wrapper_address), '^0x[0-9a-f]{40}$')),
    CONSTRAINT semantic_entry_no_zero_address_sentinels CHECK
        (isNull(source_domain_wallet_address) OR assumeNotNull(source_domain_wallet_address) != '0x0000000000000000000000000000000000000000')
        AND (isNull(holder_static_address) OR assumeNotNull(holder_static_address) != '0x0000000000000000000000000000000000000000')
        AND (isNull(holder_queue_mm_position_manager_address) OR assumeNotNull(holder_queue_mm_position_manager_address) != '0x0000000000000000000000000000000000000000')
        AND (isNull(holder_queue_wallet_address) OR assumeNotNull(holder_queue_wallet_address) != '0x0000000000000000000000000000000000000000')
        AND (isNull(resolved_holder_address) OR assumeNotNull(resolved_holder_address) != '0x0000000000000000000000000000000000000000')
        AND (isNull(asset_address) OR assumeNotNull(asset_address) != '0x0000000000000000000000000000000000000000')
        AND (isNull(related_underlying_address) OR assumeNotNull(related_underlying_address) != '0x0000000000000000000000000000000000000000')
        AND (isNull(ownership_wrapper_address) OR assumeNotNull(ownership_wrapper_address) != '0x0000000000000000000000000000000000000000'),
    CONSTRAINT semantic_entry_underlying_role_semantics CHECK
        observation_role NOT IN ('UNDERLYING_BALANCE', 'POSITION_SETTLED_UNDERLYING')
        OR (asset_kind = 'UNDERLYING' AND lcc_provenance = 'NOT_APPLICABLE'),
    CONSTRAINT semantic_entry_native_role_semantics CHECK
        observation_role != 'NATIVE_GAS_BALANCE'
        OR (asset_kind = 'NATIVE_GAS' AND lcc_provenance = 'NOT_APPLICABLE'),
    CONSTRAINT semantic_entry_lcc_role_semantics CHECK
        observation_role != 'LCC_BALANCE'
        OR (asset_kind = 'LCC' AND lcc_provenance IN ('DIRECT_WRAPPED', 'MARKET_DERIVED')),
    CONSTRAINT semantic_entry_effective_lcc_role_semantics CHECK
        observation_role != 'POSITION_EFFECTIVE_LCC'
        OR (asset_kind = 'LCC' AND lcc_provenance = 'NOT_APPLICABLE'),
    CONSTRAINT semantic_entry_queue_role_semantics CHECK
        observation_role != 'QUEUED_CLAIM'
        OR (asset_kind = 'LCC' AND lcc_provenance = 'MARKET_DERIVED'),
    CONSTRAINT semantic_entry_fungible_role_scope CHECK
        observation_role NOT IN ('UNDERLYING_BALANCE', 'NATIVE_GAS_BALANCE', 'LCC_BALANCE', 'QUEUED_CLAIM')
        OR ownership_kind != 'MARKET',
    CONSTRAINT semantic_entry_cex_role_semantics CHECK
        observation_role NOT IN ('CEX_TOTAL_BALANCE', 'CEX_FREE_BALANCE', 'CEX_RESERVED_BALANCE')
        OR (asset_kind = 'CEX_ASSET' AND lcc_provenance = 'NOT_APPLICABLE')
)
ENGINE = ReplacingMergeTree
ORDER BY (registry_id, registry_revision, registry_payload_hash, entry_id, entry_payload_hash);

-- batch_id hashes only the frozen registry/source/producer attempt identity.
-- payload_hash covers the mutable payload separately. Exact replay collapses;
-- the same batch id with another payload remains visible as a conflict.
CREATE TABLE IF NOT EXISTS fiet_telemetry.semantic_inventory_batches
(
    `batch_id` String CODEC(ZSTD(1)),
    `payload_hash` String CODEC(ZSTD(1)),
    `schema_revision` UInt16 CODEC(ZSTD(1)),
    `registry_id` LowCardinality(String) CODEC(ZSTD(1)),
    `registry_revision` String CODEC(ZSTD(1)),
    `registry_payload_hash` String CODEC(ZSTD(1)),
    `source_domain_id` String CODEC(ZSTD(1)),
    `source_domain_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `source_domain_chain_id` Nullable(UInt64) CODEC(ZSTD(1)),
    `source_domain_wallet_address` Nullable(String) CODEC(ZSTD(1)),
    `source_domain_exchange` Nullable(String) CODEC(ZSTD(1)),
    `source_domain_account_id` Nullable(String) CODEC(ZSTD(1)),
    `source_domain_subaccount_id` Nullable(String) CODEC(ZSTD(1)),
    `producer_id` LowCardinality(String) CODEC(ZSTD(1)),
    `producer_epoch` String CODEC(ZSTD(1)),
    `sequence` UInt64 CODEC(Delta(8), ZSTD(1)),
    `cadence_started_at` DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `observed_at` DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `source_set_id` String CODEC(ZSTD(1)),
    `batch_status` LowCardinality(String) CODEC(ZSTD(1)),
    `expected_count` UInt32 CODEC(ZSTD(1)),
    `emitted_count` UInt32 CODEC(ZSTD(1)),
    `unavailable_count` UInt32 CODEC(ZSTD(1)),
    CONSTRAINT semantic_batch_id_is_hash CHECK match(toString(batch_id), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_batch_payload_is_hash CHECK match(toString(payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_batch_registry_revision_is_hash CHECK match(toString(registry_revision), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_batch_registry_payload_is_hash CHECK match(toString(registry_payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_batch_source_domain_id_is_hash CHECK match(toString(source_domain_id), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_batch_source_domain_chain_shape CHECK
        (source_domain_kind = 'ON_CHAIN') = isNotNull(source_domain_chain_id),
    CONSTRAINT semantic_batch_source_domain_wallet_shape CHECK
        (source_domain_kind = 'ON_CHAIN') = isNotNull(source_domain_wallet_address),
    CONSTRAINT semantic_batch_source_domain_exchange_shape CHECK
        (source_domain_kind = 'CEX_ACCOUNT') = isNotNull(source_domain_exchange),
    CONSTRAINT semantic_batch_source_domain_account_shape CHECK
        (source_domain_kind = 'CEX_ACCOUNT') = isNotNull(source_domain_account_id),
    CONSTRAINT semantic_batch_source_domain_subaccount_shape CHECK
        source_domain_kind = 'CEX_ACCOUNT' OR isNull(source_domain_subaccount_id),
    CONSTRAINT semantic_batch_source_domain_strings CHECK
        (isNull(source_domain_exchange) OR notEmpty(assumeNotNull(source_domain_exchange)))
        AND (isNull(source_domain_account_id) OR notEmpty(assumeNotNull(source_domain_account_id)))
        AND (isNull(source_domain_subaccount_id) OR notEmpty(assumeNotNull(source_domain_subaccount_id))),
    CONSTRAINT semantic_batch_source_domain_wallet_format CHECK
        isNull(source_domain_wallet_address)
        OR (match(assumeNotNull(source_domain_wallet_address), '^0x[0-9a-f]{40}$')
            AND assumeNotNull(source_domain_wallet_address) != '0x0000000000000000000000000000000000000000'),
    CONSTRAINT semantic_batch_source_set_is_hash CHECK match(toString(source_set_id), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_batch_producer_identity CHECK notEmpty(producer_id) AND notEmpty(producer_epoch),
    CONSTRAINT semantic_batch_count_bounds CHECK unavailable_count <= emitted_count AND emitted_count <= expected_count,
    CONSTRAINT semantic_batch_status_matches_counts CHECK
        (batch_status = 'COMPLETE') = (emitted_count = expected_count AND unavailable_count = 0)
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(observed_at)
ORDER BY (batch_id, payload_hash);

CREATE TABLE IF NOT EXISTS fiet_telemetry.semantic_inventory_observations
(
    `batch_id` String CODEC(ZSTD(1)),
    `payload_hash` String CODEC(ZSTD(1)),
    `registry_id` LowCardinality(String) CODEC(ZSTD(1)),
    `registry_revision` String CODEC(ZSTD(1)),
    `registry_payload_hash` String CODEC(ZSTD(1)),
    `entry_id` String CODEC(ZSTD(1)),
    `observation_payload_hash` String CODEC(ZSTD(1)),
    `observation_outcome` LowCardinality(String) CODEC(ZSTD(1)),
    -- Canonical unsigned base-10 U256 base units. Scale comes from the registry
    -- asset decimals; never convert through Float64.
    `raw_amount` Nullable(String) CODEC(ZSTD(1)),
    `unavailable_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `source_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `source_id` Nullable(String) CODEC(ZSTD(1)),
    `source_chain_id` Nullable(UInt64) CODEC(ZSTD(1)),
    `source_block_number` Nullable(UInt64) CODEC(ZSTD(1)),
    `source_block_hash` Nullable(String) CODEC(ZSTD(1)),
    `source_exchange` Nullable(String) CODEC(ZSTD(1)),
    `source_account_id` Nullable(String) CODEC(ZSTD(1)),
    `source_subaccount_id` Nullable(String) CODEC(ZSTD(1)),
    `source_snapshot_id` Nullable(String) CODEC(ZSTD(1)),
    CONSTRAINT semantic_observation_batch_id_is_hash CHECK match(toString(batch_id), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_observation_payload_is_hash CHECK match(toString(payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_observation_registry_revision_is_hash CHECK match(toString(registry_revision), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_observation_registry_payload_is_hash CHECK match(toString(registry_payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_observation_entry_id_is_hash CHECK match(toString(entry_id), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_observation_row_payload_is_hash CHECK match(toString(observation_payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT semantic_observation_outcome_shape CHECK
        (observation_outcome = 'OBSERVED' AND isNotNull(raw_amount) AND unavailable_kind = 'NONE')
        OR (observation_outcome = 'UNAVAILABLE' AND isNull(raw_amount) AND unavailable_kind != 'NONE'),
    CONSTRAINT semantic_observation_raw_amount_is_u256 CHECK
        isNull(raw_amount)
        OR (match(assumeNotNull(raw_amount), '^(0|[1-9][0-9]*)$')
            AND isNotNull(toUInt256OrNull(assumeNotNull(raw_amount)))),
    CONSTRAINT semantic_observation_source_id_shape CHECK
        (source_kind = 'RUNTIME_SNAPSHOT') = isNotNull(source_id),
    CONSTRAINT semantic_observation_source_id_not_empty CHECK
        isNull(source_id) OR notEmpty(assumeNotNull(source_id)),
    CONSTRAINT semantic_observation_source_chain_shape CHECK
        (source_kind = 'EVM_BLOCK') = isNotNull(source_chain_id),
    CONSTRAINT semantic_observation_source_block_number_shape CHECK
        (source_kind = 'EVM_BLOCK') = isNotNull(source_block_number),
    CONSTRAINT semantic_observation_source_block_hash_shape CHECK
        (source_kind = 'EVM_BLOCK') = isNotNull(source_block_hash),
    CONSTRAINT semantic_observation_source_block_hash_format CHECK
        isNull(source_block_hash) OR match(assumeNotNull(source_block_hash), '^0x[0-9a-f]{64}$'),
    CONSTRAINT semantic_observation_source_exchange_shape CHECK
        (source_kind = 'CEX_SNAPSHOT') = isNotNull(source_exchange),
    CONSTRAINT semantic_observation_source_exchange_not_empty CHECK
        isNull(source_exchange) OR notEmpty(assumeNotNull(source_exchange)),
    CONSTRAINT semantic_observation_source_account_shape CHECK
        (source_kind = 'CEX_SNAPSHOT') = isNotNull(source_account_id),
    CONSTRAINT semantic_observation_source_account_not_empty CHECK
        isNull(source_account_id) OR notEmpty(assumeNotNull(source_account_id)),
    CONSTRAINT semantic_observation_source_subaccount_shape CHECK
        source_kind = 'CEX_SNAPSHOT' OR isNull(source_subaccount_id),
    CONSTRAINT semantic_observation_source_snapshot_shape CHECK
        (source_kind IN ('CEX_SNAPSHOT', 'RUNTIME_SNAPSHOT')) = isNotNull(source_snapshot_id),
    CONSTRAINT semantic_observation_source_snapshot_not_empty CHECK
        isNull(source_snapshot_id) OR notEmpty(assumeNotNull(source_snapshot_id))
)
ENGINE = ReplacingMergeTree
ORDER BY (batch_id, payload_hash, entry_id, observation_payload_hash);

-- A divergent replay is rejected by resolved projections even before
-- background merges; readers never select one conflicting payload with argMax.
CREATE VIEW IF NOT EXISTS fiet_telemetry.semantic_inventory_registry_conflicts AS
SELECT
    registry_id,
    registry_revision,
    uniqExact(payload_hash) AS payload_count
FROM fiet_telemetry.semantic_inventory_registry_versions FINAL
GROUP BY registry_id, registry_revision
HAVING payload_count > 1;

CREATE VIEW IF NOT EXISTS fiet_telemetry.semantic_inventory_batch_conflicts AS
SELECT
    batch_id,
    uniqExact(payload_hash) AS payload_count
FROM fiet_telemetry.semantic_inventory_batches FINAL
GROUP BY batch_id
HAVING payload_count > 1;

CREATE VIEW IF NOT EXISTS fiet_telemetry.semantic_inventory_registry_entry_conflicts AS
SELECT
    registry_id,
    registry_revision,
    registry_payload_hash,
    entry_id,
    uniqExact(entry_payload_hash) AS payload_count
FROM fiet_telemetry.semantic_inventory_registry_entries FINAL
GROUP BY registry_id, registry_revision, registry_payload_hash, entry_id
HAVING payload_count > 1;

CREATE VIEW IF NOT EXISTS fiet_telemetry.semantic_inventory_observation_conflicts AS
SELECT
    batch_id,
    payload_hash,
    entry_id,
    uniqExact(observation_payload_hash) AS payload_count
FROM fiet_telemetry.semantic_inventory_observations FINAL
GROUP BY batch_id, payload_hash, entry_id
HAVING payload_count > 1;

CREATE VIEW IF NOT EXISTS fiet_telemetry.semantic_inventory_registry_integrity AS
SELECT
    versions.registry_id AS registry_id,
    versions.registry_revision AS registry_revision,
    versions.payload_hash AS payload_hash,
    versions.schema_revision AS schema_revision,
    versions.published_at AS published_at,
    versions.expected_entry_count AS expected_entry_count,
    coalesce(entries.actual_entry_count, toUInt64(0)) AS actual_entry_count,
    coalesce(entry_conflicts.conflict_count, toUInt64(0)) AS entry_conflict_count,
    multiIf(
        conflicts.payload_count > 1, 'PAYLOAD_CONFLICT',
        entry_conflict_count != 0, 'ENTRY_CONFLICT',
        actual_entry_count != expected_entry_count, 'COUNT_MISMATCH',
        'VALID'
    ) AS integrity_status
FROM fiet_telemetry.semantic_inventory_registry_versions AS versions FINAL
LEFT JOIN
(
    SELECT
        registry_id,
        registry_revision,
        registry_payload_hash,
        uniqExact(entry_id) AS actual_entry_count
    FROM fiet_telemetry.semantic_inventory_registry_entries FINAL
    GROUP BY registry_id, registry_revision, registry_payload_hash
) AS entries
    ON versions.registry_id = entries.registry_id
    AND versions.registry_revision = entries.registry_revision
    AND versions.payload_hash = entries.registry_payload_hash
LEFT JOIN fiet_telemetry.semantic_inventory_registry_conflicts AS conflicts
    ON versions.registry_id = conflicts.registry_id
    AND versions.registry_revision = conflicts.registry_revision
LEFT JOIN
(
    SELECT
        registry_id,
        registry_revision,
        registry_payload_hash,
        count() AS conflict_count
    FROM fiet_telemetry.semantic_inventory_registry_entry_conflicts
    GROUP BY registry_id, registry_revision, registry_payload_hash
) AS entry_conflicts
    ON versions.registry_id = entry_conflicts.registry_id
    AND versions.registry_revision = entry_conflicts.registry_revision
    AND versions.payload_hash = entry_conflicts.registry_payload_hash;

CREATE VIEW IF NOT EXISTS fiet_telemetry.semantic_inventory_batch_integrity AS
SELECT
    batches.batch_id AS batch_id,
    batches.payload_hash AS payload_hash,
    batches.schema_revision AS schema_revision,
    batches.registry_id AS registry_id,
    batches.registry_revision AS registry_revision,
    batches.registry_payload_hash AS registry_payload_hash,
    batches.source_domain_id AS source_domain_id,
    batches.source_domain_kind AS source_domain_kind,
    batches.source_domain_chain_id AS source_domain_chain_id,
    batches.source_domain_wallet_address AS source_domain_wallet_address,
    batches.source_domain_exchange AS source_domain_exchange,
    batches.source_domain_account_id AS source_domain_account_id,
    batches.source_domain_subaccount_id AS source_domain_subaccount_id,
    batches.producer_id AS producer_id,
    batches.producer_epoch AS producer_epoch,
    batches.sequence AS sequence,
    batches.cadence_started_at AS cadence_started_at,
    batches.observed_at AS observed_at,
    batches.source_set_id AS source_set_id,
    batches.batch_status AS batch_status,
    batches.expected_count AS expected_count,
    batches.emitted_count AS emitted_count,
    batches.unavailable_count AS unavailable_count,
    coalesce(registry_scope.scoped_expected_entry_count, toUInt64(0)) AS scoped_expected_entry_count,
    coalesce(observations.actual_emitted_count, toUInt64(0)) AS actual_emitted_count,
    coalesce(observations.actual_unavailable_count, toUInt64(0)) AS actual_unavailable_count,
    coalesce(observations.unregistered_count, toUInt64(0)) AS unregistered_count,
    coalesce(observations.registry_mismatch_count, toUInt64(0)) AS registry_mismatch_count,
    coalesce(observations.out_of_scope_count, toUInt64(0)) AS out_of_scope_count,
    coalesce(observations.source_scope_mismatch_count, toUInt64(0)) AS source_scope_mismatch_count,
    coalesce(observation_conflicts.conflict_count, toUInt64(0)) AS observation_conflict_count,
    multiIf(
        batch_conflicts.payload_count > 1, 'PAYLOAD_CONFLICT',
        registry.registry_found != 1 OR registry.integrity_status != 'VALID', 'REGISTRY_INVALID',
        batches.schema_revision != registry.schema_revision, 'SCHEMA_MISMATCH',
        registry_scope.scope_found != 1 OR registry_scope.domain_payload_count != 1, 'SOURCE_DOMAIN_INVALID',
        toString(batches.source_domain_kind) != registry_scope.scope_kind
            OR ifNull(toString(batches.source_domain_chain_id), '') != registry_scope.scope_chain_id
            OR ifNull(batches.source_domain_wallet_address, '') != registry_scope.scope_wallet_address
            OR ifNull(batches.source_domain_exchange, '') != registry_scope.scope_exchange
            OR ifNull(batches.source_domain_account_id, '') != registry_scope.scope_account_id
            OR ifNull(batches.source_domain_subaccount_id, '') != registry_scope.scope_subaccount_id,
            'SOURCE_DOMAIN_MISMATCH',
        batches.expected_count != scoped_expected_entry_count, 'EXPECTED_COUNT_MISMATCH',
        registry_mismatch_count != 0, 'OBSERVATION_REGISTRY_MISMATCH',
        out_of_scope_count != 0, 'OBSERVATION_SOURCE_DOMAIN_MISMATCH',
        source_scope_mismatch_count != 0, 'OBSERVATION_SOURCE_MISMATCH',
        observation_conflict_count != 0, 'OBSERVATION_CONFLICT',
        actual_emitted_count != emitted_count OR actual_unavailable_count != unavailable_count, 'COUNT_MISMATCH',
        unregistered_count != 0, 'UNREGISTERED_FACT',
        batch_status = 'COMPLETE', 'COMPLETE',
        'PARTIAL'
    ) AS integrity_status
FROM fiet_telemetry.semantic_inventory_batches AS batches FINAL
LEFT JOIN
(
    SELECT
        observations.batch_id,
        observations.payload_hash,
        uniqExact(observations.entry_id) AS actual_emitted_count,
        uniqExactIf(observations.entry_id, observations.observation_outcome = 'UNAVAILABLE') AS actual_unavailable_count,
        uniqExactIf(observations.entry_id, registry_entries.entry_found != 1) AS unregistered_count,
        uniqExactIf(
            observations.entry_id,
            observations.registry_id != batch_registry.registry_id
                OR observations.registry_revision != batch_registry.registry_revision
                OR observations.registry_payload_hash != batch_registry.registry_payload_hash
        ) AS registry_mismatch_count,
        uniqExactIf(
            observations.entry_id,
            registry_entries.entry_found = 1
                AND registry_entries.source_domain_id != batch_registry.source_domain_id
        ) AS out_of_scope_count,
        uniqExactIf(
            observations.entry_id,
            (batch_registry.source_domain_kind = 'ON_CHAIN'
                AND (observations.source_kind = 'CEX_SNAPSHOT'
                    OR (observations.source_kind = 'EVM_BLOCK'
                        AND observations.source_chain_id != batch_registry.source_domain_chain_id)))
            OR (batch_registry.source_domain_kind = 'CEX_ACCOUNT'
                AND (observations.source_kind = 'EVM_BLOCK'
                    OR (observations.source_kind = 'CEX_SNAPSHOT'
                        AND (observations.source_exchange != batch_registry.source_domain_exchange
                            OR observations.source_account_id != batch_registry.source_domain_account_id
                            OR ifNull(observations.source_subaccount_id, '')
                                != ifNull(batch_registry.source_domain_subaccount_id, '')))))
        ) AS source_scope_mismatch_count
    FROM fiet_telemetry.semantic_inventory_observations AS observations FINAL
    INNER JOIN fiet_telemetry.semantic_inventory_batches AS batch_registry FINAL
        ON observations.batch_id = batch_registry.batch_id
        AND observations.payload_hash = batch_registry.payload_hash
    LEFT JOIN
    (
        SELECT *, toUInt8(1) AS entry_found
        FROM fiet_telemetry.semantic_inventory_registry_entries FINAL
    ) AS registry_entries
        ON observations.registry_id = registry_entries.registry_id
        AND observations.registry_revision = registry_entries.registry_revision
        AND observations.registry_payload_hash = registry_entries.registry_payload_hash
        AND observations.entry_id = registry_entries.entry_id
    GROUP BY observations.batch_id, observations.payload_hash
) AS observations
    ON batches.batch_id = observations.batch_id
    AND batches.payload_hash = observations.payload_hash
LEFT JOIN fiet_telemetry.semantic_inventory_batch_conflicts AS batch_conflicts
    ON batches.batch_id = batch_conflicts.batch_id
LEFT JOIN
(
    SELECT
        batch_id,
        payload_hash,
        count() AS conflict_count
    FROM fiet_telemetry.semantic_inventory_observation_conflicts
    GROUP BY batch_id, payload_hash
) AS observation_conflicts
    ON batches.batch_id = observation_conflicts.batch_id
    AND batches.payload_hash = observation_conflicts.payload_hash
LEFT JOIN
(
    SELECT
        registry_id,
        registry_revision,
        registry_payload_hash,
        source_domain_id,
        uniqExact(entry_id) AS scoped_expected_entry_count,
        uniqExact(tuple(
            toString(source_domain_kind),
            ifNull(toString(source_domain_chain_id), ''),
            ifNull(source_domain_wallet_address, ''),
            ifNull(source_domain_exchange, ''),
            ifNull(source_domain_account_id, ''),
            ifNull(source_domain_subaccount_id, '')
        )) AS domain_payload_count,
        any(toString(source_domain_kind)) AS scope_kind,
        any(ifNull(toString(source_domain_chain_id), '')) AS scope_chain_id,
        any(ifNull(source_domain_wallet_address, '')) AS scope_wallet_address,
        any(ifNull(source_domain_exchange, '')) AS scope_exchange,
        any(ifNull(source_domain_account_id, '')) AS scope_account_id,
        any(ifNull(source_domain_subaccount_id, '')) AS scope_subaccount_id,
        toUInt8(1) AS scope_found
    FROM fiet_telemetry.semantic_inventory_registry_entries FINAL
    GROUP BY registry_id, registry_revision, registry_payload_hash, source_domain_id
) AS registry_scope
    ON batches.registry_id = registry_scope.registry_id
    AND batches.registry_revision = registry_scope.registry_revision
    AND batches.registry_payload_hash = registry_scope.registry_payload_hash
    AND batches.source_domain_id = registry_scope.source_domain_id
LEFT JOIN
(
    SELECT *, toUInt8(1) AS registry_found
    FROM fiet_telemetry.semantic_inventory_registry_integrity
) AS registry
    ON batches.registry_id = registry.registry_id
    AND batches.registry_revision = registry.registry_revision
    AND batches.registry_payload_hash = registry.payload_hash;

CREATE VIEW IF NOT EXISTS fiet_telemetry.semantic_inventory_batches_resolved AS
SELECT *
FROM fiet_telemetry.semantic_inventory_batch_integrity
WHERE integrity_status IN ('COMPLETE', 'PARTIAL');

CREATE VIEW IF NOT EXISTS fiet_telemetry.semantic_inventory_observations_resolved AS
SELECT
    observations.batch_id AS batch_id,
    observations.payload_hash AS payload_hash,
    observations.registry_id AS registry_id,
    observations.registry_revision AS registry_revision,
    observations.registry_payload_hash AS registry_payload_hash,
    batches.source_domain_id AS source_domain_id,
    batches.source_domain_kind AS source_domain_kind,
    batches.source_domain_chain_id AS source_domain_chain_id,
    batches.source_domain_wallet_address AS source_domain_wallet_address,
    batches.source_domain_exchange AS source_domain_exchange,
    batches.source_domain_account_id AS source_domain_account_id,
    batches.source_domain_subaccount_id AS source_domain_subaccount_id,
    observations.entry_id AS entry_id,
    observations.observation_payload_hash AS observation_payload_hash,
    observations.observation_outcome AS observation_outcome,
    observations.raw_amount AS raw_amount,
    observations.unavailable_kind AS unavailable_kind,
    observations.source_kind AS source_kind,
    observations.source_id AS source_id,
    observations.source_chain_id AS source_chain_id,
    observations.source_block_number AS source_block_number,
    observations.source_block_hash AS source_block_hash,
    observations.source_exchange AS source_exchange,
    observations.source_account_id AS source_account_id,
    observations.source_subaccount_id AS source_subaccount_id,
    observations.source_snapshot_id AS source_snapshot_id,
    entries.subject_kind AS subject_kind,
    entries.subject_key AS subject_key,
    entries.ownership_kind AS ownership_kind,
    entries.market_id AS market_id,
    entries.ownership_scope_id AS ownership_scope_id,
    entries.ownership_wrapper_chain_id AS ownership_wrapper_chain_id,
    entries.ownership_wrapper_address AS ownership_wrapper_address,
    entries.holder_locator_kind AS holder_locator_kind,
    entries.holder_role AS holder_role,
    entries.holder_chain_id AS holder_chain_id,
    entries.holder_static_address AS holder_static_address,
    entries.holder_queue_mm_position_manager_address AS holder_queue_mm_position_manager_address,
    entries.holder_queue_wallet_address AS holder_queue_wallet_address,
    entries.resolved_holder_address AS resolved_holder_address,
    entries.holder_exchange AS holder_exchange,
    entries.holder_account_id AS holder_account_id,
    entries.holder_subaccount_id AS holder_subaccount_id,
    entries.asset_kind AS asset_kind,
    entries.asset_chain_id AS asset_chain_id,
    entries.asset_address AS asset_address,
    entries.asset_id AS asset_id,
    entries.asset_symbol AS asset_symbol,
    entries.asset_decimals AS asset_decimals,
    entries.related_underlying_kind AS related_underlying_kind,
    entries.related_underlying_address AS related_underlying_address,
    entries.asset_exchange AS asset_exchange,
    entries.observation_role AS observation_role,
    entries.lcc_provenance AS lcc_provenance,
    batches.batch_status AS batch_status,
    batches.observed_at AS observed_at
FROM fiet_telemetry.semantic_inventory_observations AS observations FINAL
INNER JOIN fiet_telemetry.semantic_inventory_batches_resolved AS batches
    ON observations.batch_id = batches.batch_id
    AND observations.payload_hash = batches.payload_hash
INNER JOIN fiet_telemetry.semantic_inventory_registry_entries AS entries FINAL
    ON observations.registry_id = entries.registry_id
    AND observations.registry_revision = entries.registry_revision
    AND observations.registry_payload_hash = entries.registry_payload_hash
    AND observations.entry_id = entries.entry_id
    AND entries.source_domain_id = batches.source_domain_id;

-- Tx Receipts table: Records gas data from transaction receipts
CREATE TABLE IF NOT EXISTS fiet_telemetry.tx_receipts
(
    `timestamp` DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `tx_hash` String CODEC(ZSTD(1)),
    `action_id` String CODEC(ZSTD(1)),
    `run_id` String CODEC(ZSTD(1)),
    `pool_key` String CODEC(ZSTD(1)),
    `action_type` LowCardinality(String) CODEC(ZSTD(1)),
    `gas_used` Decimal(38, 18) CODEC(ZSTD(1)),
    `effective_gas_price` Decimal(38, 18) CODEC(ZSTD(1)),
    `block_number` UInt64 CODEC(ZSTD(1)),
    `labels` String CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (pool_key, toDate(timestamp), action_type, timestamp)
TTL toDateTime(timestamp) + toIntervalDay(90)
SETTINGS ttl_only_drop_parts = 1;

-- Market Onboarding table: Periodic snapshots of market onboarding state.
-- Gives operators queryable history of operability and dataset coverage transitions.
-- Source: MarketOnboardingEvent (crates/telemetry/src/events.rs)
CREATE TABLE IF NOT EXISTS fiet_telemetry.market_onboarding
(
    `timestamp` DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `market_id` LowCardinality(String) CODEC(ZSTD(1)),
    `core_pool_id` String CODEC(ZSTD(1)),
    `operability` LowCardinality(String) CODEC(ZSTD(1)),
    `dataset_coverage` LowCardinality(String) CODEC(ZSTD(1)),
    `metadata_resolution` LowCardinality(String) CODEC(ZSTD(1)),
    -- ClickHouse 25.12 rejects Nullable(LowCardinality(String)); keep these nullable and
    -- prioritize compatibility for the devcontainer/sandbox bootstrap path.
    `metadata_provenance` Nullable(String) CODEC(ZSTD(1)),
    `dataset_provenance` Nullable(String) CODEC(ZSTD(1)),
    `desired_enablement` LowCardinality(String) CODEC(ZSTD(1)),
    `service` LowCardinality(String) CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (market_id, timestamp)
TTL toDateTime(timestamp) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1;

-- Coherent process-epoch snapshots for the five financial event lanes. This is
-- intentionally a plain MergeTree: duplicate logical keys remain visible to the
-- integrity projection instead of being hidden by replacement semantics.
CREATE TABLE IF NOT EXISTS fiet_telemetry.event_lane_coverage
(
    `slot_started_at` DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `snapshot_at` DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `service` LowCardinality(String) CODEC(ZSTD(1)),
    `producer_epoch` UUID CODEC(ZSTD(1)),
    `snapshot_sequence` UInt64 CODEC(Delta(8), ZSTD(1)),
    `lane` LowCardinality(String) CODEC(ZSTD(1)),
    `attempted` UInt64 CODEC(Delta(8), ZSTD(1)),
    `enqueued` UInt64 CODEC(Delta(8), ZSTD(1)),
    `rejected_before_enqueue` UInt64 CODEC(Delta(8), ZSTD(1)),
    `acknowledged` UInt64 CODEC(Delta(8), ZSTD(1)),
    `dropped_after_enqueue` UInt64 CODEC(Delta(8), ZSTD(1)),
    `indeterminate` UInt64 CODEC(Delta(8), ZSTD(1)),
    `pending` UInt64 CODEC(Delta(8), ZSTD(1)),
    `failed_batches` UInt64 CODEC(Delta(8), ZSTD(1)),
    `last_acknowledged_at` Nullable(DateTime64(9, 'UTC')) CODEC(ZSTD(1)),
    `flusher_running` Bool CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toDate(slot_started_at)
ORDER BY (service, producer_epoch, snapshot_sequence, lane)
TTL toDateTime(slot_started_at) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1;

CREATE OR REPLACE VIEW fiet_telemetry.event_lane_coverage_batch_integrity AS
SELECT
    service,
    producer_epoch,
    snapshot_sequence,
    slot_started_at,
    snapshot_at,
    row_count,
    distinct_lane_count,
    row_count - distinct_lane_count AS duplicate_row_count,
    if(
        previous_sequence = 0,
        snapshot_sequence - 1,
        snapshot_sequence - previous_sequence - 1
    ) AS missing_sequence_count,
    row_count = 5
        AND distinct_lane_count = 5
        AND hasAll(
            lanes,
            ['actions', 'positions', 'tx_receipts', 'inventory', 'market_onboarding']
        ) AS structurally_complete
FROM
(
    SELECT
        *,
        lagInFrame(snapshot_sequence, 1, toUInt64(0)) OVER (
            PARTITION BY service, producer_epoch
            ORDER BY snapshot_sequence
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS previous_sequence
    FROM
    (
        SELECT
            service,
            producer_epoch,
            snapshot_sequence,
            min(slot_started_at) AS slot_started_at,
            max(snapshot_at) AS snapshot_at,
            count() AS row_count,
            uniqExact(lane) AS distinct_lane_count,
            groupUniqArray(lane) AS lanes
        FROM fiet_telemetry.event_lane_coverage
        GROUP BY service, producer_epoch, snapshot_sequence
    )
);

-- Indexer capability snapshots: one complete observer collection attempt per row.
--
-- Exact chain quantities stay decimal strings because block heights and signed raw
-- amounts can exceed ordinary integer/Float64 boundaries. Consumers must parse
-- these fields with toUInt256OrNull/toInt256OrNull before comparing or subtracting;
-- string comparison is invalid for numeric ordering.
--
-- `snapshot_id` identifies an observer attempt. A replay with the same payload hash
-- has the same replacement key and collapses under FINAL. A reused snapshot id with
-- a different hash deliberately has a different key and remains visible for the
-- writer/read path to reject as a payload conflict rather than silently selecting it.
-- Health reads select the latest attempt regardless of outcome. A separate
-- last-COMPLETE cursor read is only a recovery-interval anchor, never a present-health
-- fallback.
CREATE TABLE IF NOT EXISTS fiet_telemetry.indexer_capability_snapshots
(
    `snapshot_id` String CODEC(ZSTD(1)),
    `payload_sha256` String CODEC(ZSTD(1)),
    `producer_id` LowCardinality(String) CODEC(ZSTD(1)),
    `producer_run_id` String CODEC(ZSTD(1)),
    `attempt_seq` UInt64 CODEC(Delta(8), ZSTD(1)),
    `cadence_started_at` DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `observed_at` DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `schema_revision` UInt16 CODEC(ZSTD(1)),
    `source_id` LowCardinality(String) CODEC(ZSTD(1)),
    `indexer_name` LowCardinality(String) CODEC(ZSTD(1)),
    `network` LowCardinality(String) CODEC(ZSTD(1)),
    `capability` LowCardinality(String) CODEC(ZSTD(1)),
    `capability_state` LowCardinality(String) CODEC(ZSTD(1)),
    `snapshot_status` LowCardinality(String) CODEC(ZSTD(1)),
    `failure_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `registry_id` LowCardinality(String) CODEC(ZSTD(1)),
    `registry_revision` String CODEC(ZSTD(1)),
    `head_block` Nullable(String) CODEC(ZSTD(1)),
    `head_observed_at` Nullable(DateTime64(6, 'UTC')) CODEC(Delta(8), ZSTD(1)),
    `cursor_block` Nullable(String) CODEC(ZSTD(1)),
    `cursor_observed_at` Nullable(DateTime64(6, 'UTC')) CODEC(Delta(8), ZSTD(1)),
    `cursor_lag_blocks` Nullable(String) CODEC(ZSTD(1)),
    `interval_from_block` Nullable(String) CODEC(ZSTD(1)),
    `interval_to_block` Nullable(String) CODEC(ZSTD(1)),
    `expected_market_count` UInt32 CODEC(ZSTD(1)),
    `emitted_market_count` UInt32 CODEC(ZSTD(1)),
    `market_payload_json` String CODEC(ZSTD(1)),
    CONSTRAINT snapshot_id_is_sha256 CHECK match(toString(snapshot_id), '^[0-9a-f]{64}$'),
    CONSTRAINT payload_sha256_is_sha256 CHECK match(toString(payload_sha256), '^[0-9a-f]{64}$'),
    CONSTRAINT complete_has_no_failure CHECK snapshot_status != 'COMPLETE' OR failure_kind = 'NONE',
    CONSTRAINT incomplete_has_failure CHECK snapshot_status = 'COMPLETE' OR failure_kind != 'NONE',
    CONSTRAINT supported_complete CHECK capability_state != 'UNSUPPORTED' OR snapshot_status != 'COMPLETE',
    CONSTRAINT emitted_market_count_is_bounded CHECK emitted_market_count <= expected_market_count,
    CONSTRAINT complete_has_full_market_payload CHECK snapshot_status != 'COMPLETE' OR emitted_market_count = expected_market_count,
    CONSTRAINT market_payload_is_json CHECK isValidJSON(market_payload_json),
    CONSTRAINT head_block_is_decimal CHECK isNull(head_block) OR isNotNull(toUInt256OrNull(head_block)),
    CONSTRAINT cursor_block_is_decimal CHECK isNull(cursor_block) OR isNotNull(toUInt256OrNull(cursor_block)),
    CONSTRAINT cursor_lag_is_decimal CHECK isNull(cursor_lag_blocks) OR isNotNull(toInt256OrNull(cursor_lag_blocks)),
    CONSTRAINT interval_from_is_decimal CHECK isNull(interval_from_block) OR isNotNull(toUInt256OrNull(interval_from_block)),
    CONSTRAINT interval_to_is_decimal CHECK isNull(interval_to_block) OR isNotNull(toUInt256OrNull(interval_to_block))
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(observed_at)
ORDER BY (source_id, network, capability, snapshot_id, payload_sha256);

-- =============================================================================
-- Historical CEX Price Data (from backtest Parquet files)
-- =============================================================================
-- Stores CEX price observations imported from .backtest/cex_prices/*.parquet.
-- Parquet files contain: symbol (String), timestamp (Int64 ms), price (String).
--
-- To import CEX price data from Parquet files:
--   INSERT INTO fiet_telemetry.cex_prices
--   SELECT
--       symbol,
--       fromUnixTimestamp64Milli(timestamp),
--       toFloat64(price)
--   FROM file('/var/lib/clickhouse/user_files/cex_prices/*.parquet', Parquet);
CREATE TABLE IF NOT EXISTS fiet_telemetry.cex_prices
(
    `symbol` LowCardinality(String) CODEC(ZSTD(1)),
    `timestamp` DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `price` Float64 CODEC(ZSTD(1))
)
ENGINE = MergeTree
ORDER BY (symbol, timestamp);

-- =============================================================================
-- Broker Execution Archive Facts — schema NOT defined here
-- =============================================================================
-- The broker_execution.* tables are owned by the cex-broker repo at
-- schema/clickhouse/broker_execution.sql and created by the archive-forwarder's
-- self-init (fail-closed at startup). fiet-maker deliberately does NOT define them
-- here: the previous copy had drifted from production (e.g. filled_base_quantity vs
-- prod's executed_base_quantity/filled_amount) and a schema must not be maintained in
-- two places. The sandbox proof harness carries its own DDL fixture at
-- scripts/sandbox/fixtures/broker_execution_schema.sql (a contract fixture, not prod reality).

-- =============================================================================
-- Settlement Capital Coordinator — obligation journal + custody/movement ledger
-- =============================================================================
-- The durable plane of record for the capital coordinator (FIET-972). Restate
-- object state holds only the live working set; these two tables hold the
-- append-only history that a cold start reconciles against.
--
-- Both use the semantic_inventory_batches shape: ReplacingMergeTree ORDER BY
-- (<identity>, payload_hash). The identity hash covers the frozen identity of a
-- record; payload_hash covers the mutable payload separately. An exact replay
-- collapses under FINAL, while the same identity carrying a different payload
-- stays visible as two rows and is surfaced by the *_conflicts views below.
-- Silent last-write-wins would let a divergent replay overwrite history, which
-- is the one thing a ledger must never do.
--
-- Amounts: the two tables use DIFFERENT types on purpose, and harmonizing them
-- would break one of the two properties below. Journal amounts are canonical
-- unsigned base-10 U256 strings, the same convention as
-- semantic_inventory_observations.raw_amount — scale comes from token_decimals
-- and no value is ever routed through Float64. They are magnitudes that are
-- never summed across rows. Ledger deltas are Int128 instead, because they
-- exist to be summed: the custody conservation identity below must be
-- checkable by query without a per-read cast, and a cast on the hot path is
-- where someone eventually reaches for a float. Int128 and not Int256 for a
-- hard reason: the pinned clickhouse Rust client serializes i128 as 16 bytes
-- of RowBinary and has no 256-bit integer at all, so an Int256 column would
-- misalign the whole row stream rather than fail loudly. Trade-off accepted
-- deliberately: a delta above Int128::MAX ERRORS the insert rather than
-- wrapping, which is fail-closed and unreachable in practice (1.7e20 whole
-- tokens at 18 decimals, against a total USDC supply near 1e10).
--
-- Custody conservation, the identity these postings exist to make checkable:
--   SELECT asset_address, sum(delta_amount)
--   FROM fiet_telemetry.custody_ledger_postings FINAL
--   WHERE posting_kind = 'TRANSFER'
--   GROUP BY asset_address
--   HAVING sum(delta_amount) != 0
-- Value enters and leaves the system only through the explicit GAS, FEE, MINT
-- and BURN kinds, so excluding them is what makes the remaining sum balance.
-- Any row returned by that query is a real accounting break, not noise.

CREATE TABLE IF NOT EXISTS fiet_telemetry.obligation_journal
(
    `record_id` String CODEC(ZSTD(1)),
    `payload_hash` String CODEC(ZSTD(1)),
    `schema_revision` UInt16 CODEC(ZSTD(1)),

    `obligation_id` String CODEC(ZSTD(1)),
    `intent_id` Nullable(String) CODEC(ZSTD(1)),
    `lifecycle_state` LowCardinality(String) CODEC(ZSTD(1)),
    -- Authored by the coordinator. INDETERMINATE is reserved for rows written
    -- before the taxonomy existed; SQL must not recreate the coordinator's
    -- classifier from incomplete historical facts.
    `queue_class` LowCardinality(String) DEFAULT 'INDETERMINATE' CODEC(ZSTD(1)),
    -- Empty for ordinary transitions. Non-empty values explain only an actual
    -- coordinator transition, never a refused request that produced no row.
    `reason_code` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    `conflict_detail` Nullable(String) CODEC(ZSTD(1)),
    `state_version` UInt64 CODEC(Delta(8), ZSTD(1)),
    `open_state_version` Nullable(UInt64) CODEC(Delta(8), ZSTD(1)),
    `idempotency_key` String CODEC(ZSTD(1)),

    -- Capital scope. The coordinator object is keyed (chain_id, wallet_address);
    -- the full asset scope lives on the row so a query can group by it directly.
    `chain_id` UInt64 CODEC(ZSTD(1)),
    `wallet_address` String CODEC(ZSTD(1)),
    `canonical_token_address` String CODEC(ZSTD(1)),
    `token_decimals` UInt8 CODEC(ZSTD(1)),
    `custody_authority` LowCardinality(String) CODEC(ZSTD(1)),

    -- Protocol scope. Nullable because a proactive obligation can exist before
    -- it is bound to a commitment or a settlement.
    `market_id` Nullable(String) CODEC(ZSTD(1)),
    `pool_id` Nullable(String) CODEC(ZSTD(1)),
    `commitment_id` Nullable(String) CODEC(ZSTD(1)),
    `settlement_id` Nullable(String) CODEC(ZSTD(1)),

    `direction` LowCardinality(String) CODEC(ZSTD(1)),
    -- Canonical unsigned base-10 U256 base units, scaled by token_decimals.
    -- String, NOT Int256, on purpose: these are magnitudes that are never
    -- summed across rows, so they keep the full U256 range. Do not "harmonize"
    -- them with custody_ledger_postings.delta_amount — that column is Int256
    -- for the opposite reason. Never convert either through Float64.
    `gross_amount` String CODEC(ZSTD(1)),
    `fulfilled_amount` String CODEC(ZSTD(1)),
    `reserved_amount` String CODEC(ZSTD(1)),
    `remaining_amount` String CODEC(ZSTD(1)),

    -- Lease plane. Deliberately NOT named claim_id: that name is taken by the
    -- HB-local supersession token and conflating the two would be a live bug.
    `lease_id` Nullable(String) CODEC(ZSTD(1)),
    `lease_holder` Nullable(String) CODEC(ZSTD(1)),
    `lease_expires_at` Nullable(DateTime64(6, 'UTC')) CODEC(ZSTD(1)),
    `fencing_token` UInt64 CODEC(Delta(8), ZSTD(1)),

    -- Deadline plane. rfs_phase = BLIND carries its reason so an unreadable
    -- deadline stays INDETERMINATE and never renders as closed or expired.
    `rfs_open_since` Nullable(DateTime64(6, 'UTC')) CODEC(ZSTD(1)),
    `rfs_deadline_at` Nullable(DateTime64(6, 'UTC')) CODEC(ZSTD(1)),
    `rfs_phase` LowCardinality(String) CODEC(ZSTD(1)),
    `rfs_blind_reason` Nullable(String) CODEC(ZSTD(1)),

    -- Chain identity of the event that caused this record, when one exists.
    `source_chain_id` Nullable(UInt64) CODEC(ZSTD(1)),
    `source_block_number` Nullable(UInt64) CODEC(ZSTD(1)),
    `source_block_timestamp` Nullable(DateTime64(6, 'UTC')) CODEC(ZSTD(1)),
    `source_tx_hash` Nullable(String) CODEC(ZSTD(1)),
    `source_log_index` Nullable(UInt64) CODEC(ZSTD(1)),

    `producer_id` LowCardinality(String) CODEC(ZSTD(1)),
    `producer_epoch` String CODEC(ZSTD(1)),
    `sequence` UInt64 CODEC(Delta(8), ZSTD(1)),
    `recorded_at` DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),

    CONSTRAINT obligation_journal_record_id_is_hash CHECK match(toString(record_id), '^[0-9a-f]{64}$'),
    CONSTRAINT obligation_journal_payload_is_hash CHECK match(toString(payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT obligation_journal_identity_present CHECK
        notEmpty(obligation_id) AND notEmpty(idempotency_key),
    -- PENDING_CONFIRMATION is parked broadcast evidence after lease expiry.
    -- EVIDENCE_UNRESOLVED is open indeterminate evidence, not in-flight
    -- confirmation; REPLACEMENT_PENDING is open while a successor awaits
    -- confirmation. SUPERSEDED remains reserved for terminal supersession.
    CONSTRAINT obligation_journal_lifecycle_state_known CHECK
        lifecycle_state IN ('OPEN', 'LEASED', 'INTENT_ACCEPTED', 'SUBMITTED', 'INDEXER_CONFIRMED',
                            'APPLIED', 'CANCELLED', 'REJECTED', 'SUPERSEDED', 'LEASE_EXPIRED',
                            'PENDING_CONFIRMATION', 'EVIDENCE_UNRESOLVED', 'REPLACEMENT_PENDING'),
    CONSTRAINT obligation_journal_queue_class_known CHECK
        queue_class IN ('Rfs', 'PlanCapitalRequest', 'INDETERMINATE'),
    CONSTRAINT obligation_journal_reason_code_known CHECK
        reason_code IN ('', 'LEASE_EXPIRED', 'LEASE_EXPIRED_AFTER_BROADCAST', 'CLAIM_APPLIED',
                        'OBLIGATION_SETTLED_EXTERNALLY', 'RESERVATION_CONFLICT'),
    CONSTRAINT obligation_journal_conflict_detail_shape CHECK
        (reason_code = 'RESERVATION_CONFLICT') = isNotNull(conflict_detail),
    CONSTRAINT obligation_journal_direction_known CHECK
        direction IN ('DEPOSIT', 'WITHDRAWAL', 'REBALANCE'),
    CONSTRAINT obligation_journal_wallet_format CHECK
        match(wallet_address, '^0x[0-9a-f]{40}$')
        AND wallet_address != '0x0000000000000000000000000000000000000000',
    CONSTRAINT obligation_journal_token_format CHECK match(canonical_token_address, '^0x[0-9a-f]{40}$'),
    CONSTRAINT obligation_journal_amounts_are_u256 CHECK
        match(gross_amount, '^(0|[1-9][0-9]*)$')
        AND match(fulfilled_amount, '^(0|[1-9][0-9]*)$')
        AND match(reserved_amount, '^(0|[1-9][0-9]*)$')
        AND match(remaining_amount, '^(0|[1-9][0-9]*)$'),
    -- Weak form on purpose. The strong identity (fulfilled + reserved + remaining
    -- = gross) does not survive every terminal state: a CANCELLED record zeroes
    -- remaining while gross still exceeds fulfilled. A constraint a legitimate
    -- state cannot satisfy would block a write during an incident. The strong
    -- identity belongs to the reconciliation harness, as a query that REPORTS
    -- violations rather than DDL that blocks writes.
    -- Reading an error from this one: ClickHouse does not guarantee constraint
    -- evaluation order, so a malformed amount can surface as a toUInt256 parse
    -- error instead of a named constraint violation. Either way the insert is
    -- rejected; only the error text differs.
    CONSTRAINT obligation_journal_amounts_bounded CHECK
        toUInt256(fulfilled_amount) + toUInt256(reserved_amount) <= toUInt256(gross_amount),
    -- A leased record must carry the whole lease, never half of it.
    CONSTRAINT obligation_journal_lease_shape CHECK
        (lifecycle_state = 'LEASED')
        <= (isNotNull(lease_id) AND isNotNull(lease_holder) AND isNotNull(lease_expires_at)),
    CONSTRAINT obligation_journal_rfs_phase_known CHECK
        rfs_phase IN ('CLOSED', 'OPEN_ACTIVE', 'OPEN_EXPIRED', 'BLIND'),
    -- Blind means the deadline could not be read: it must say why, and must not
    -- also claim to know the deadline it failed to read.
    CONSTRAINT obligation_journal_blind_carries_reason CHECK
        (rfs_phase = 'BLIND') = isNotNull(rfs_blind_reason),
    CONSTRAINT obligation_journal_active_deadline_present CHECK
        (rfs_phase = 'OPEN_ACTIVE') <= isNotNull(rfs_deadline_at),
    CONSTRAINT obligation_journal_producer_identity CHECK
        notEmpty(producer_id) AND notEmpty(producer_epoch),
    CONSTRAINT obligation_journal_open_state_version_positive CHECK
        isNull(open_state_version) OR open_state_version > 0
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(recorded_at)
ORDER BY (record_id, payload_hash);

-- Custody/movement postings. Keyed by posting_id, which hashes
-- (chain_id, tx_hash, log_index, account_id, asset_address, posting_kind): the
-- (tx_hash, log_index) pair is the movement key for exactly-once crediting, but
-- one log produces several legs (at minimum a debit and a credit), so the pair
-- alone would collapse the legs of a single movement into one row. chain_id is
-- part of the key because asset identity is chain-scoped everywhere in this
-- epic, and a tx hash is only unique within a chain.
CREATE TABLE IF NOT EXISTS fiet_telemetry.custody_ledger_postings
(
    `posting_id` String CODEC(ZSTD(1)),
    `payload_hash` String CODEC(ZSTD(1)),
    `schema_revision` UInt16 CODEC(ZSTD(1)),

    `movement_id` String CODEC(ZSTD(1)),
    `obligation_id` Nullable(String) CODEC(ZSTD(1)),
    `open_state_version` Nullable(UInt64) CODEC(Delta(8), ZSTD(1)),
    `intent_id` Nullable(String) CODEC(ZSTD(1)),
    `idempotency_key` String CODEC(ZSTD(1)),

    `posting_kind` LowCardinality(String) CODEC(ZSTD(1)),

    `account_id` String CODEC(ZSTD(1)),
    `account_kind` LowCardinality(String) CODEC(ZSTD(1)),
    `chain_id` UInt64 CODEC(ZSTD(1)),
    `wallet_address` Nullable(String) CODEC(ZSTD(1)),
    `custody_authority` LowCardinality(String) CODEC(ZSTD(1)),

    `asset_address` String CODEC(ZSTD(1)),
    `asset_decimals` UInt8 CODEC(ZSTD(1)),
    -- Signed base units, scaled by asset_decimals. An integer, NOT a String
    -- like obligation_journal's amounts, on purpose: these deltas exist to be
    -- summed and the conservation query must not cast on the read path.
    -- Int128 specifically because the pinned clickhouse Rust client has no
    -- 256-bit integer and writes i128 as 16 RowBinary bytes; an Int256 column
    -- would silently misalign every column after it. A delta above Int128::MAX
    -- ERRORS the insert rather than wrapping. Fail-closed, and unreachable in
    -- practice at 1.7e20 whole tokens for an 18-decimal asset.
    `delta_amount` Int128 CODEC(ZSTD(1)),

    -- A posting exists because something landed on chain, so its chain identity
    -- is never optional.
    `tx_hash` String CODEC(ZSTD(1)),
    `log_index` UInt64 CODEC(ZSTD(1)),
    `block_number` UInt64 CODEC(Delta(8), ZSTD(1)),
    `block_timestamp` DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),

    `producer_id` LowCardinality(String) CODEC(ZSTD(1)),
    `producer_epoch` String CODEC(ZSTD(1)),
    `sequence` UInt64 CODEC(Delta(8), ZSTD(1)),
    `recorded_at` DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),

    CONSTRAINT custody_posting_id_is_hash CHECK match(toString(posting_id), '^[0-9a-f]{64}$'),
    CONSTRAINT custody_posting_payload_is_hash CHECK match(toString(payload_hash), '^[0-9a-f]{64}$'),
    CONSTRAINT custody_posting_identity_present CHECK
        notEmpty(movement_id) AND notEmpty(idempotency_key) AND notEmpty(account_id),
    CONSTRAINT custody_posting_kind_known CHECK
        posting_kind IN ('TRANSFER', 'GAS', 'FEE', 'MINT', 'BURN'),
    CONSTRAINT custody_posting_account_kind_known CHECK
        account_kind IN ('WALLET', 'LCC', 'VAULT', 'CEX_ACCOUNT', 'EXTERNAL'),
    CONSTRAINT custody_posting_wallet_shape CHECK
        (account_kind = 'WALLET') = isNotNull(wallet_address),
    CONSTRAINT custody_posting_wallet_format CHECK
        isNull(wallet_address)
        OR (match(assumeNotNull(wallet_address), '^0x[0-9a-f]{40}$')
            AND assumeNotNull(wallet_address) != '0x0000000000000000000000000000000000000000'),
    CONSTRAINT custody_posting_asset_format CHECK match(asset_address, '^0x[0-9a-f]{40}$'),
    -- A zero-delta posting records nothing and would silently pad the ledger.
    CONSTRAINT custody_posting_delta_nonzero CHECK delta_amount != 0,
    CONSTRAINT custody_posting_tx_hash_format CHECK match(tx_hash, '^0x[0-9a-f]{64}$'),
    CONSTRAINT custody_posting_producer_identity CHECK
        notEmpty(producer_id) AND notEmpty(producer_epoch),
    CONSTRAINT custody_posting_open_state_version_positive CHECK
        isNull(open_state_version) OR open_state_version > 0
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(block_timestamp)
ORDER BY (posting_id, payload_hash);

-- Divergent replay stays visible rather than overwriting: any identity carrying
-- more than one payload is a conflict a human must resolve.
CREATE VIEW IF NOT EXISTS fiet_telemetry.obligation_journal_conflicts AS
SELECT
    record_id,
    uniqExact(payload_hash) AS payload_count
FROM fiet_telemetry.obligation_journal FINAL
GROUP BY record_id
HAVING payload_count > 1;

CREATE VIEW IF NOT EXISTS fiet_telemetry.custody_ledger_posting_conflicts AS
SELECT
    posting_id,
    uniqExact(payload_hash) AS payload_count
FROM fiet_telemetry.custody_ledger_postings FINAL
GROUP BY posting_id
HAVING payload_count > 1;

-- =============================================================================
-- Settlement capital coordinator — reconciliation read plane
-- =============================================================================
-- Read surfaces over the two tables above (FIET-972). They exist to answer one
-- question: for every obligation, does the recorded demand still equal what was
-- reserved, moved and left outstanding — and does custody balance to zero once
-- the explicit leak kinds are excluded.
--
-- WHY THESE LIVE HERE and not in scripts/sql/observability-views.sql: that file
-- is gated on eight upstream databases existing
-- (docker/setup/clickhouse-observability-views.sh), because most of its views
-- join broker and collector data. Nothing below reads anything outside
-- fiet_telemetry, so parking it there would make a self-contained ledger surface
-- impossible to apply — or to test — without first bringing up the broker and
-- OHLCV upstreams that it has no relationship to.
--
-- CREATE OR REPLACE, deliberately unlike the two conflicts views directly above,
-- which use CREATE VIEW IF NOT EXISTS: a re-apply must actually update a CHANGED
-- definition. Otherwise merged SQL and applied SQL diverge silently and the file
-- stops being the contract it claims to be.
--
-- DEDUPLICATION — the rule every query below obeys. state_version is
-- history-dependent: after a Restate state wipe the same obligation re-enters at
-- version 0 and walks its lifecycle again from there, so the same
-- (obligation, open_state_version, lifecycle_state, state_version) coordinates
-- may recur across incarnations. record_id therefore carries both the Open-cycle
-- generation and producer_epoch, which guarantees a late older-generation row
-- cannot collapse with a newer cycle and post-wipe rows do not collapse against
-- pre-wipe rows under ReplacingMergeTree. The journal remains append-only
-- history — but it means "journal record count" is NOT "distinct obligations",
-- and since the epoch turns over on every orchestrator restart it is NOT
-- "distinct transitions" either: an identical re-observation from a later
-- incarnation is a new record. Counting transitions requires deduplicating by
-- (obligation_id, lifecycle_state, state_version), which nothing below does or
-- needs to. So: read the base tables FINAL to collapse exact replay, reduce to
-- one row per obligation_id, and count obligations with uniqExact(obligation_id),
-- never count(). A restart must never read as duplicated obligations.
--
-- LATEST-RECORD ORDERING first elects the highest non-null
-- open_state_version. NULL is the legacy-lowest generation, so a late
-- re-emission from an older cycle cannot mask a newer cycle. Within the chosen
-- generation the latest key is (recorded_at, sequence, state_version), in that
-- order: wall clock first because a wipe resets state_version to 0.
--
-- SUMS WIDEN TO Int256 BEFORE AGGREGATING. delta_amount is Int128, and sum()
-- over Int128 accumulates in Int128 and wraps SILENTLY on overflow. The widening
-- is an integer cast only, so the property the column comment above protects —
-- no value is ever routed through Float64 — is preserved exactly.

-- -----------------------------------------------------------------------------
-- capital_obligation_state
-- One row per obligation: its current recorded state, and whether that state can
-- be trusted at all.
--
-- integrity = 'CONFLICTED' means some record of this obligation was replayed
-- carrying a divergent payload. Such an obligation gets NO verdict downstream:
-- electing one of two contradictory payloads would launder a real accounting
-- break into a clean-looking row. The test is exact rather than approximate —
-- uniqExact over (record_id, payload_hash) exceeds uniqExact over record_id
-- precisely when some record_id carries more than one payload.
--
-- Its reach is WITHIN one producer incarnation, because record_id carries the
-- producer_epoch. Two incarnations describing the same transition differently
-- are two records, not a conflict — deliberately, and it is the difference
-- between a signal and a false alarm: a re-lease after a restart necessarily
-- carries a new fencing token, and payload_hash covers the lease, so a
-- cross-incarnation test would flag every ordinary restart-then-re-lease as an
-- accounting break. The cost is real and accepted: a producer that genuinely
-- disagrees with its own predecessor about a past transition is invisible here.
-- The newest incarnation wins downstream, by recorded_at.
--
-- Only rows at schema_revision >= 3 take part in the test. Before revision 3
-- the writer restarted state_version at 0 whenever a settled obligation owed
-- again, so every reopened cycle re-used the previous cycle's record_ids under
-- the same epoch and read as a divergent replay. Those rows keep feeding the
-- elected state and first_seen_at — they are real history — but their identity
-- cannot distinguish a reopen from a replay, so they are disqualified from
-- judging integrity rather than allowed to fail it forever.
--
-- The amounts stay Strings here, as they are stored. Callers that need to do
-- arithmetic cast to Int256 at the point of use (see capital_obligation_
-- reconciliation); the canonical U256 decimal string is what survives round trips.
-- -----------------------------------------------------------------------------
-- The aggregation runs in two stages whose outputs carry latest_ names. The
-- first stage selects one row per Open generation. The second elects the
-- highest generation first (NULL is the legacy-lowest generation), then the
-- latest row within that generation. Aliasing an aggregate to the same
-- identifier as its source column is a cyclic alias to ClickHouse's analyzer,
-- so both stages use explicit indirection.
CREATE OR REPLACE VIEW fiet_telemetry.capital_obligation_state AS
WITH journal_rows AS
(
    SELECT
        *,
        (recorded_at, sequence, state_version) AS journal_order
    FROM fiet_telemetry.obligation_journal FINAL
),
generation_state AS
(
    SELECT
        obligation_id,
        open_state_version,
        argMax(chain_id, journal_order) AS latest_chain_id,
        argMax(wallet_address, journal_order) AS latest_wallet_address,
        argMax(canonical_token_address, journal_order) AS latest_canonical_token_address,
        argMax(token_decimals, journal_order) AS latest_token_decimals,
        argMax(custody_authority, journal_order) AS latest_custody_authority,

        argMax(market_id, journal_order) AS latest_market_id,
        argMax(pool_id, journal_order) AS latest_pool_id,
        argMax(commitment_id, journal_order) AS latest_commitment_id,
        argMax(settlement_id, journal_order) AS latest_settlement_id,

        argMax(direction, journal_order) AS latest_direction,
        argMax(lifecycle_state, journal_order) AS latest_lifecycle_state,
        argMax(queue_class, journal_order) AS latest_queue_class,
        argMax(reason_code, journal_order) AS latest_reason_code,
        argMax(state_version, journal_order) AS latest_state_version,
        argMax(sequence, journal_order) AS latest_sequence,

        argMax(gross_amount, journal_order) AS latest_gross_amount,
        argMax(fulfilled_amount, journal_order) AS latest_fulfilled_amount,
        argMax(reserved_amount, journal_order) AS latest_reserved_amount,
        argMax(remaining_amount, journal_order) AS latest_remaining_amount,

        argMax(rfs_phase, journal_order) AS latest_rfs_phase,
        argMax(rfs_open_since, journal_order) AS latest_rfs_open_since,
        argMax(rfs_deadline_at, journal_order) AS latest_rfs_deadline_at,
        argMax(rfs_blind_reason, journal_order) AS latest_rfs_blind_reason,

        min(recorded_at) AS first_seen_at,
        max(recorded_at) AS last_seen_at,

        count() AS journal_rows,
        uniqExact(record_id) AS journal_records,

        if(
            uniqExactIf((record_id, payload_hash), schema_revision >= 3)
                > uniqExactIf(record_id, schema_revision >= 3),
            'CONFLICTED',
            'OK'
        ) AS integrity
    FROM journal_rows
    GROUP BY obligation_id, open_state_version
),
obligation_state AS
(
    SELECT
        obligation_id,
        argMax(ifNull(open_state_version, toUInt64(0)), generation_order) AS latest_open_state_version,

        argMax(latest_chain_id, generation_order) AS selected_chain_id,
        argMax(latest_wallet_address, generation_order) AS selected_wallet_address,
        argMax(latest_canonical_token_address, generation_order) AS selected_canonical_token_address,
        argMax(latest_token_decimals, generation_order) AS selected_token_decimals,
        argMax(latest_custody_authority, generation_order) AS selected_custody_authority,

        argMax(latest_market_id, generation_order) AS selected_market_id,
        argMax(latest_pool_id, generation_order) AS selected_pool_id,
        argMax(latest_commitment_id, generation_order) AS selected_commitment_id,
        argMax(latest_settlement_id, generation_order) AS selected_settlement_id,

        argMax(latest_direction, generation_order) AS selected_direction,
        argMax(latest_lifecycle_state, generation_order) AS selected_lifecycle_state,
        argMax(latest_queue_class, generation_order) AS selected_queue_class,
        argMax(latest_reason_code, generation_order) AS selected_reason_code,
        argMax(latest_state_version, generation_order) AS selected_state_version,

        argMax(latest_gross_amount, generation_order) AS selected_gross_amount,
        argMax(latest_fulfilled_amount, generation_order) AS selected_fulfilled_amount,
        argMax(latest_reserved_amount, generation_order) AS selected_reserved_amount,
        argMax(latest_remaining_amount, generation_order) AS selected_remaining_amount,

        argMax(latest_rfs_phase, generation_order) AS selected_rfs_phase,
        argMax(latest_rfs_open_since, generation_order) AS selected_rfs_open_since,
        argMax(latest_rfs_deadline_at, generation_order) AS selected_rfs_deadline_at,
        argMax(latest_rfs_blind_reason, generation_order) AS selected_rfs_blind_reason,

        min(first_seen_at) AS first_seen_at,
        max(last_seen_at) AS last_seen_at,
        sum(journal_rows) AS journal_rows,
        sum(journal_records) AS journal_records,
        if(
            countIf(integrity = 'CONFLICTED') > 0
                OR argMax(latest_reason_code, generation_order) = 'RESERVATION_CONFLICT',
            'CONFLICTED',
            'OK'
        ) AS integrity
    FROM
    (
        SELECT
            *,
            (
                if(isNull(open_state_version), toUInt8(0), toUInt8(1)),
                ifNull(open_state_version, toUInt64(0)),
                last_seen_at,
                latest_sequence,
                latest_state_version
            ) AS generation_order
        FROM generation_state
    ) AS ordered_generations
    GROUP BY obligation_id
)
SELECT
    obligation_id,
    nullIf(latest_open_state_version, toUInt64(0)) AS open_state_version,

    selected_chain_id AS chain_id,
    selected_wallet_address AS wallet_address,
    selected_canonical_token_address AS canonical_token_address,
    selected_token_decimals AS token_decimals,
    selected_custody_authority AS custody_authority,

    selected_market_id AS market_id,
    selected_pool_id AS pool_id,
    selected_commitment_id AS commitment_id,
    selected_settlement_id AS settlement_id,

    selected_direction AS direction,
    selected_lifecycle_state AS lifecycle_state,
    selected_queue_class AS queue_class,
    selected_reason_code AS reason_code,
    selected_state_version AS state_version,

    selected_gross_amount AS gross_amount,
    selected_fulfilled_amount AS fulfilled_amount,
    selected_reserved_amount AS reserved_amount,
    selected_remaining_amount AS remaining_amount,

    selected_rfs_phase AS rfs_phase,
    selected_rfs_open_since AS rfs_open_since,
    selected_rfs_deadline_at AS rfs_deadline_at,
    selected_rfs_blind_reason AS rfs_blind_reason,

    first_seen_at,
    last_seen_at,
    journal_rows,
    journal_records,

    selected_lifecycle_state IN (
        'OPEN', 'LEASED', 'INTENT_ACCEPTED', 'SUBMITTED', 'INDEXER_CONFIRMED',
        'LEASE_EXPIRED', 'PENDING_CONFIRMATION', 'EVIDENCE_UNRESOLVED', 'REPLACEMENT_PENDING'
    ) AS is_open,
    integrity
FROM obligation_state;

-- -----------------------------------------------------------------------------
-- capital_obligation_queue_age
-- How long open obligations have been waiting, per scope and per state.
--
-- queue_class is a coordinator-authored fact. Rows from before that writer
-- shape have the schema default INDETERMINATE. SQL must retain that failure
-- rather than guessing a class from lifecycle or deadline fields.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW fiet_telemetry.capital_obligation_queue_age AS
SELECT
    chain_id,
    wallet_address,
    canonical_token_address,
    market_id,
    lifecycle_state,
    rfs_phase,

    queue_class,
    if(
        queue_class = 'INDETERMINATE',
        'obligation_journal.queue_class (legacy row predates coordinator taxonomy)',
        ''
    ) AS queue_class_missing_source,

    uniqExact(obligation_id) AS open_obligations,
    countIf(integrity = 'CONFLICTED') AS conflicted_obligations,

    max(dateDiff('second', first_seen_at, now())) AS oldest_age_seconds,
    min(dateDiff('second', first_seen_at, now())) AS newest_age_seconds
FROM fiet_telemetry.capital_obligation_state
WHERE is_open
GROUP BY chain_id, wallet_address, canonical_token_address, market_id, lifecycle_state, rfs_phase, queue_class;

-- -----------------------------------------------------------------------------
-- capital_deadline_risk
-- Minimum time to settlement risk per scope, failing closed.
--
-- A scope holding ANY blind obligation reads INDETERMINATE regardless of the
-- computed minimum: a deadline that could not be read must never render as safe,
-- and the one number an operator would act on is exactly the one a blind row
-- would omit from the minimum.
--
-- A scope holding any CONFLICTED obligation reads INDETERMINATE for the same
-- reason one step earlier. capital_obligation_state elects the current record
-- with argMax, and for a conflicted obligation the contending payloads sit on
-- one record_id — so the elected rfs_phase and rfs_deadline_at are whichever of
-- two contradictory values the aggregate happened to pick. Reading a deadline
-- off that and calling the scope OK would be the fail-open outcome this view
-- exists to prevent, so conflicted rows are excluded from the minimum and force
-- the verdict.
--
-- DISPLAY ONLY. seconds_to_deadline is computed against query-time now(), so it
-- is a rendering of the deadline, not the deadline itself. Never feed it back
-- into urgency logic as t_rfs — consumers derive urgency from rfs_deadline_at
-- with their own journaled time source.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW fiet_telemetry.capital_deadline_risk AS
SELECT
    chain_id,
    wallet_address,
    canonical_token_address,
    market_id,

    uniqExact(obligation_id) AS open_obligations,
    countIf(rfs_phase = 'OPEN_ACTIVE') AS active_obligations,
    countIf(rfs_phase = 'OPEN_EXPIRED') AS expired_obligations,
    countIf(rfs_phase = 'BLIND') AS blind_obligations,
    countIf(integrity = 'CONFLICTED') AS conflicted_obligations,

    -- Guarded rather than bare: minIf over an empty selection returns 0, and a
    -- zero here would read as "no time left" on a scope that simply has no
    -- active deadline at all. Conflicted obligations are excluded from the
    -- minimum for a different reason: their phase and deadline were elected from
    -- contradictory payloads, so the value is arbitrary and would corrupt the
    -- one number an operator acts on.
    if(countIf(rfs_phase = 'OPEN_ACTIVE' AND isNotNull(rfs_deadline_at) AND integrity != 'CONFLICTED') = 0,
       NULL,
       minIf(dateDiff('second', now(), rfs_deadline_at),
             rfs_phase = 'OPEN_ACTIVE' AND isNotNull(rfs_deadline_at) AND integrity != 'CONFLICTED'))
        AS min_seconds_to_deadline,

    -- Conflicted outranks blind: an unreadable deadline is a gap, contradictory
    -- deadlines are worse than a gap, and neither may render as safe.
    multiIf(
        countIf(integrity = 'CONFLICTED') > 0, 'INDETERMINATE',
        countIf(rfs_phase = 'BLIND') > 0, 'INDETERMINATE',
        countIf(rfs_phase = 'OPEN_EXPIRED') > 0, 'EXPIRED',
        countIf(rfs_phase = 'OPEN_ACTIVE') > 0, 'OK',
        'NO_ACTIVE_DEADLINE') AS verdict,

    multiIf(
        countIf(integrity = 'CONFLICTED') > 0,
        'obligation_journal (divergent replay: elected rfs_phase and rfs_deadline_at are arbitrary)',
        countIf(rfs_phase = 'BLIND') > 0,
        'obligation_journal.rfs_deadline_at (phase BLIND: ' || anyIf(assumeNotNull(rfs_blind_reason), rfs_phase = 'BLIND') || ')',
        '') AS missing_source
FROM fiet_telemetry.capital_obligation_state
WHERE is_open
GROUP BY chain_id, wallet_address, canonical_token_address, market_id;

-- -----------------------------------------------------------------------------
-- capital_custody_conservation
-- The reconcile-to-zero surface: per chain and asset, do the internal transfers
-- balance once the explicit leak kinds are set aside.
--
-- Residual is REPORTED, never absorbed. A non-zero transfer_net_base_units is a
-- real accounting break, not noise, because value is only supposed to enter or
-- leave through the GAS, FEE, MINT and BURN kinds — each broken out below so the
-- leak is visible rather than implied.
--
-- asset_decimal_variants guards the interpretation of every number in the row:
-- more than one scale recorded for the same asset means two producers disagree
-- about it, and every total here would be a mix of scales.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW fiet_telemetry.capital_custody_conservation AS
SELECT
    chain_id,
    asset_address,
    -- Named apart from the source column deliberately: aliasing an aggregate to
    -- the identifier it reads is a cyclic alias to the analyzer.
    max(asset_decimals) AS asset_scale,
    uniqExact(asset_decimals) AS asset_decimal_variants,

    sumIf(toInt256(delta_amount), posting_kind = 'TRANSFER') AS transfer_net_base_units,
    sumIf(toInt256(delta_amount), posting_kind = 'GAS') AS gas_base_units,
    sumIf(toInt256(delta_amount), posting_kind = 'FEE') AS fee_base_units,
    sumIf(toInt256(delta_amount), posting_kind = 'MINT') AS mint_base_units,
    sumIf(toInt256(delta_amount), posting_kind = 'BURN') AS burn_base_units,

    countIf(posting_kind = 'TRANSFER') AS transfer_legs,
    uniqExact(posting_id) AS postings,

    sumIf(toInt256(delta_amount), posting_kind = 'TRANSFER') = 0 AS balanced,
    if(uniqExact(posting_id, payload_hash) > uniqExact(posting_id), 'CONFLICTED', 'OK') AS integrity
FROM fiet_telemetry.custody_ledger_postings FINAL
GROUP BY chain_id, asset_address;

-- -----------------------------------------------------------------------------
-- capital_movement_flow
-- Gross movement against net external movement, per day, chain and asset.
--
-- Gross is the sum of the CREDITED transfer legs rather than half the sum of
-- absolute deltas. Halving assumes both legs of every movement carry the same
-- block_timestamp and so land in the same day bucket; summing credits assumes
-- nothing and stays correct when they do not.
--
-- SIGN CONVENTION: net_external_base_units is what the SYSTEM gained, so it is
-- the negation of the delta recorded on the EXTERNAL account. Positive means
-- value entered the system from outside.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW fiet_telemetry.capital_movement_flow AS
SELECT
    toDate(block_timestamp) AS movement_day,
    chain_id,
    asset_address,
    max(asset_decimals) AS asset_scale,

    uniqExact(movement_id) AS movements,
    countIf(posting_kind = 'TRANSFER') AS transfer_legs,

    sumIf(toInt256(delta_amount), posting_kind = 'TRANSFER' AND delta_amount > 0) AS gross_credited_base_units,
    sumIf(toInt256(delta_amount), posting_kind = 'TRANSFER' AND delta_amount < 0) AS gross_debited_base_units,
    negate(sumIf(toInt256(delta_amount), posting_kind = 'TRANSFER' AND account_kind = 'EXTERNAL'))
        AS net_external_base_units,

    sumIf(toInt256(delta_amount), posting_kind IN ('GAS', 'FEE')) AS cost_base_units,
    sumIf(toInt256(delta_amount), posting_kind IN ('MINT', 'BURN')) AS supply_change_base_units
FROM fiet_telemetry.custody_ledger_postings FINAL
GROUP BY movement_day, chain_id, asset_address;

-- -----------------------------------------------------------------------------
-- capital_duplicate_credits
-- The counter that must read zero. Any row here is a movement credited twice.
--
-- The grouping key IS the posting_id hash preimage
-- (chain_id, tx_hash, log_index, account_id, asset_address, posting_kind), so
-- two distinct posting_ids under one key can only mean the id derivation drifted
-- — which is precisely the mechanism by which one on-chain movement gets applied
-- to the ledger more than once. This is a different failure from
-- custody_ledger_posting_conflicts, which catches one identity carrying two
-- payloads; here the identity itself was minted twice.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW fiet_telemetry.capital_duplicate_credits AS
SELECT
    chain_id,
    tx_hash,
    log_index,
    account_id,
    asset_address,
    posting_kind,
    uniqExact(posting_id) AS posting_id_variants,
    arraySort(groupUniqArray(posting_id)) AS posting_ids,
    sum(toInt256(delta_amount)) AS credited_base_units
FROM fiet_telemetry.custody_ledger_postings FINAL
GROUP BY chain_id, tx_hash, log_index, account_id, asset_address, posting_kind
HAVING posting_id_variants > 1;

-- -----------------------------------------------------------------------------
-- capital_obligation_reconciliation
-- The ledger walk, one row per obligation Open cycle, keyed by
-- (obligation_id, open_state_version). A NULL generation is one legacy bucket
-- per obligation and is flagged rather than certified.
--   source demand -> custody movement -> reservations -> fulfillment -> externally settled remainder -> remaining
--
-- Two independent checks, reported separately because they fail for different
-- reasons and a single verdict would hide which one broke.
--
-- IDENTITY CHECK: gross = fulfilled + reserved + remaining + externally
-- settled. The DDL enforces only the weak form (fulfilled + reserved <= gross),
-- because the strong form is a lifecycle property that a legitimate terminal
-- state can violate — a CANCELLED record zeroes remaining while gross still
-- exceeds fulfilled — and a constraint a valid state cannot satisfy would block
-- a write mid-incident. So the strong identity lives here, as a report.
--
-- CUSTODY CHECK: `custody_net_base_units` is signed from the scope wallet's
-- point of view. The capital coordinator confirms wallet-sent movements, so a
-- fulfilled DEPOSIT or WITHDRAWAL claim has an expected net of
-- `-fulfilled_amount`; the obligation direction names the destination, not the
-- sign of the wallet leg. Scope matching is on (obligation, Open-cycle
-- generation, chain, wallet, asset), which selects the WALLET legs of the
-- obligation's own scope: the schema allows wallet_address only on account_kind
-- = 'WALLET', so LCC, vault, venue and external legs are excluded by
-- construction rather than by an exclusion list that could go stale.
--
-- SETTLED_EXTERNALLY rows preserve the pre-close gross amount, carry the
-- coordinator's aggregate Applied credits as fulfilled, and set remaining to
-- zero. The gross-minus-fulfilled remainder is named `externally_settled` and
-- excluded from the unexplained identity residual.
--
-- REBALANCE is INDETERMINATE on the custody side by nature: both legs can land
-- on the same wallet and net to zero, so a zero net is indistinguishable from no
-- movement at all. It is reported as unknown rather than as balanced.
--
-- ⚠ "This obligation has no postings" is detected by a posting COUNT of zero and
-- never by isNull — an obligation claiming fulfilled > 0 with no custody evidence
-- at all would otherwise read as perfectly balanced. The zero is written with
-- ifNull rather than inherited from join_use_nulls = 0, because that is a SESSION
-- setting and a plain VIEW is expanded with the READER's settings: a client or
-- datasource profile carrying join_use_nulls = 1 would turn the unmatched side
-- NULL, and every comparison against it into an unknown that reads as false,
-- silently relabelling MISSING_CUSTODY_EVIDENCE as an ordinary residual. The
-- detector must not depend on how the reader is configured.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW fiet_telemetry.capital_obligation_reconciliation AS
WITH journal_rows AS
(
    -- Materialize the election tuple before aggregation. Reusing an aggregate
    -- alias named `state_version` inside another argMax makes ClickHouse expand
    -- that alias recursively and reject the view with ILLEGAL_AGGREGATION.
    SELECT
        *,
        (recorded_at, sequence, state_version) AS journal_order
    FROM fiet_telemetry.obligation_journal FINAL
),
obligation_integrity AS
(
    -- Replay identity is an obligation-level invariant. A generation split
    -- must not turn one record_id with two payloads into two harmless buckets.
    SELECT
        obligation_id,
        if(
            uniqExactIf((record_id, payload_hash), schema_revision >= 3)
                > uniqExactIf(record_id, schema_revision >= 3),
            'CONFLICTED',
            'OK'
        ) AS integrity
    FROM journal_rows
    GROUP BY obligation_id
),
generation_state AS
(
    SELECT
        j.obligation_id AS obligation_id,
        j.open_state_version AS open_state_version,
        argMax(j.chain_id, j.journal_order) AS chain_id,
        argMax(j.wallet_address, j.journal_order) AS wallet_address,
        argMax(j.canonical_token_address, j.journal_order) AS canonical_token_address,
        argMax(j.market_id, j.journal_order) AS market_id,
        argMax(j.settlement_id, j.journal_order) AS settlement_id,
        argMax(j.direction, j.journal_order) AS direction,
        argMax(j.lifecycle_state, j.journal_order) AS lifecycle_state,
        argMax(j.reason_code, j.journal_order) AS latest_reason_code,
        argMax(j.state_version, j.journal_order) AS latest_state_version,
        argMax(j.gross_amount, j.journal_order) AS gross_amount,
        argMax(j.fulfilled_amount, j.journal_order) AS fulfilled_amount,
        argMax(j.reserved_amount, j.journal_order) AS reserved_amount,
        argMax(j.remaining_amount, j.journal_order) AS remaining_amount,
        argMax(j.rfs_phase, j.journal_order) AS rfs_phase,
        argMax(j.rfs_open_since, j.journal_order) AS rfs_open_since,
        argMax(j.rfs_deadline_at, j.journal_order) AS rfs_deadline_at,
        argMax(j.rfs_blind_reason, j.journal_order) AS rfs_blind_reason,
        min(j.recorded_at) AS first_seen_at,
        max(j.recorded_at) AS last_seen_at,
        count() AS journal_rows,
        uniqExact(j.record_id) AS journal_records,
        if(
            isNull(j.open_state_version),
            'LEGACY_UNASSIGNED',
            if(
                any(identity.integrity) = 'CONFLICTED'
                    OR argMax(j.reason_code, j.journal_order) = 'RESERVATION_CONFLICT',
                'CONFLICTED',
                'OK'
            )
        ) AS integrity
    FROM journal_rows AS j
    INNER JOIN obligation_integrity AS identity
        ON j.obligation_id = identity.obligation_id
    GROUP BY j.obligation_id, j.open_state_version
)
SELECT
    s.obligation_id AS obligation_id,
    s.open_state_version AS open_state_version,
    s.chain_id AS chain_id,
    s.wallet_address AS wallet_address,
    s.canonical_token_address AS canonical_token_address,
    s.market_id AS market_id,
    s.settlement_id AS settlement_id,
    s.direction AS direction,
    s.lifecycle_state AS lifecycle_state,
    s.reason_code AS reason_code,
    s.is_open AS is_open,
    s.first_seen_at AS first_seen_at,
    s.last_seen_at AS last_seen_at,

    toInt256(s.gross_amount) AS demand_gross_base_units,
    toInt256(s.reserved_amount) AS reserved_base_units,
    toInt256(s.fulfilled_amount) AS fulfilled_base_units,
    toInt256(s.remaining_amount) AS remaining_exposure_base_units,

    if(
        s.lifecycle_state = 'APPLIED' AND s.reason_code = 'OBLIGATION_SETTLED_EXTERNALLY',
        toInt256(s.gross_amount) - toInt256(s.fulfilled_amount),
        toInt256(0)
    ) AS externally_settled_base_units,

    ifNull(p.posting_legs, 0) AS posting_legs,
    ifNull(p.custody_net_base_units, toInt256(0)) AS custody_net_base_units,

    toInt256(s.gross_amount)
        - (
            toInt256(s.fulfilled_amount)
            + toInt256(s.reserved_amount)
            + toInt256(s.remaining_amount)
            + if(
                s.lifecycle_state = 'APPLIED' AND s.reason_code = 'OBLIGATION_SETTLED_EXTERNALLY',
                toInt256(s.gross_amount) - toInt256(s.fulfilled_amount),
                toInt256(0)
            )
        )
        AS identity_residual_base_units,

    multiIf(
        s.integrity IN ('CONFLICTED', 'LEGACY_UNASSIGNED'), 'CONFLICTED',
        toInt256(s.gross_amount)
            = toInt256(s.fulfilled_amount)
                + toInt256(s.reserved_amount)
                + toInt256(s.remaining_amount)
                + if(
                    s.lifecycle_state = 'APPLIED' AND s.reason_code = 'OBLIGATION_SETTLED_EXTERNALLY',
                    toInt256(s.gross_amount) - toInt256(s.fulfilled_amount),
                    toInt256(0)
                ),
            'BALANCED',
        -- EVIDENCE_UNRESOLVED and REPLACEMENT_PENDING remain live and are
        -- intentionally absent from the terminal-exempt set.
        s.lifecycle_state IN ('CANCELLED', 'REJECTED', 'SUPERSEDED'), 'TERMINAL_EXEMPT',
        'RESIDUAL') AS identity_verdict,

    multiIf(
        s.direction IN ('DEPOSIT', 'WITHDRAWAL'),
            toInt256(s.fulfilled_amount) + ifNull(p.custody_net_base_units, toInt256(0)),
        NULL) AS custody_residual_base_units,

    multiIf(
        s.integrity IN ('CONFLICTED', 'LEGACY_UNASSIGNED'), 'CONFLICTED',
        toInt256(s.fulfilled_amount) = 0 AND ifNull(p.posting_legs, 0) = 0, 'NO_MOVEMENT_YET',
        s.direction = 'REBALANCE', 'INDETERMINATE',
        toInt256(s.fulfilled_amount) > 0 AND ifNull(p.posting_legs, 0) = 0, 'MISSING_CUSTODY_EVIDENCE',
        s.direction IN ('DEPOSIT', 'WITHDRAWAL')
            AND toInt256(s.fulfilled_amount) = negate(ifNull(p.custody_net_base_units, toInt256(0))), 'BALANCED',
        'RESIDUAL') AS custody_verdict,

    multiIf(
        s.integrity = 'CONFLICTED',
            'obligation_journal (divergent replay: one record_id carries several payloads)',
        s.integrity = 'LEGACY_UNASSIGNED',
            'obligation_journal.open_state_version (legacy row predates generation identity)',
        s.direction = 'REBALANCE',
            'custody_ledger_postings (a rebalance can net to zero on one wallet; net movement cannot confirm it)',
        toInt256(s.fulfilled_amount) > 0 AND ifNull(p.posting_legs, 0) = 0,
            'custody_ledger_postings (obligation reports fulfilment with no posting)',
        '') AS missing_source
FROM
(
    SELECT
        obligation_id,
        open_state_version,
        chain_id,
        wallet_address,
        canonical_token_address,
        market_id,
        settlement_id,
        direction,
        lifecycle_state,
        latest_reason_code AS reason_code,
        latest_state_version AS state_version,
        gross_amount,
        fulfilled_amount,
        reserved_amount,
        remaining_amount,
        rfs_phase,
        rfs_open_since,
        rfs_deadline_at,
        rfs_blind_reason,
        first_seen_at,
        last_seen_at,
        journal_rows,
        journal_records,
        integrity,
        lifecycle_state IN (
            'OPEN', 'LEASED', 'INTENT_ACCEPTED', 'SUBMITTED', 'INDEXER_CONFIRMED',
            'LEASE_EXPIRED', 'PENDING_CONFIRMATION', 'EVIDENCE_UNRESOLVED', 'REPLACEMENT_PENDING'
        ) AS is_open
    FROM generation_state
) AS s
LEFT JOIN
(
    SELECT
        assumeNotNull(obligation_id) AS scoped_obligation_id,
        open_state_version AS scoped_open_state_version,
        chain_id AS scoped_chain_id,
        assumeNotNull(wallet_address) AS scoped_wallet_address,
        asset_address AS scoped_asset_address,
        count() AS posting_legs,
        sum(toInt256(delta_amount)) AS custody_net_base_units
    FROM fiet_telemetry.custody_ledger_postings FINAL
    WHERE posting_kind = 'TRANSFER'
      AND isNotNull(obligation_id)
      AND isNotNull(wallet_address)
    GROUP BY scoped_obligation_id, scoped_open_state_version, scoped_chain_id, scoped_wallet_address, scoped_asset_address
) AS p
    ON s.obligation_id = p.scoped_obligation_id
    AND ifNull(s.open_state_version, toUInt64(0)) = ifNull(p.scoped_open_state_version, toUInt64(0))
    AND s.chain_id = p.scoped_chain_id
    AND s.wallet_address = p.scoped_wallet_address
    AND s.canonical_token_address = p.scoped_asset_address;

-- -----------------------------------------------------------------------------
-- capital_reconciliation_verdict
-- One row per chain: can this chain's capital ledger be certified right now.
--
-- ⚠ FAILS CLOSED BY ABSENCE. A chain with no journal rows produces NO ROW here,
-- and a consumer must render an expected-but-absent chain as INDETERMINATE
-- naming the missing source — never as OK. A verdict surface that reads healthy
-- because its input vanished is the failure mode this column set exists to
-- prevent.
--
-- duplicate_credits and unbalanced_assets are the two counters that must read
-- zero. Any other value is an accounting break, not a threshold to tune.
-- -----------------------------------------------------------------------------
-- The posting-side counters arrive by LEFT JOIN, and an unmatched chain must
-- read 0: a chain with journal rows but no postings at all has no conservation
-- and no duplicate rows to match, and zero unbalanced assets and zero duplicate
-- credits is the truthful answer. That zero is written with ifNull rather than
-- left to join_use_nulls, which is a SESSION setting a reader can flip: a plain
-- VIEW is expanded with the reader's settings, so a client profile carrying
-- join_use_nulls = 1 would otherwise turn every counter here into NULL and every
-- comparison below into an unknown that silently reads as false.
-- The zero is only safe because these are counts of DETECTED breaks; it would be
-- wrong for any column where absence means "unknown", which is why missing
-- custody evidence is decided per obligation in the view above rather than
-- inferred from an unmatched join here.
--
-- SCALE AMBIGUITY OUTRANKS FAIL, and sits just under CONFLICTED. When one asset
-- carries two recorded decimal scales, the sums behind balanced are a mix of
-- scales, so unbalanced_assets may be an artifact of the mixing rather than a
-- real break. Reporting FAIL would send an operator hunting a break that might
-- not exist; INDETERMINATE with the count points at the actual problem.
CREATE OR REPLACE VIEW fiet_telemetry.capital_reconciliation_verdict AS
SELECT
    r.chain_id AS chain_id,

    r.obligations AS obligations,
    r.open_obligations AS open_obligations,

    r.identity_balanced AS identity_balanced,
    r.identity_terminal_exempt AS identity_terminal_exempt,
    r.identity_residual AS identity_residual,
    r.identity_conflicted AS identity_conflicted,

    r.custody_balanced AS custody_balanced,
    r.custody_no_movement_yet AS custody_no_movement_yet,
    r.custody_indeterminate AS custody_indeterminate,
    r.custody_missing_evidence AS custody_missing_evidence,
    r.custody_residual AS custody_residual,

    ifNull(c.unbalanced_assets, 0) AS unbalanced_assets,
    ifNull(c.conflicted_assets, 0) AS conflicted_assets,
    ifNull(c.scale_ambiguous_assets, 0) AS scale_ambiguous_assets,
    ifNull(d.duplicate_credits, 0) AS duplicate_credits,

    multiIf(
        r.identity_conflicted > 0 OR ifNull(c.conflicted_assets, 0) > 0, 'CONFLICTED',
        ifNull(c.scale_ambiguous_assets, 0) > 0, 'INDETERMINATE',
        r.identity_residual > 0
            OR r.custody_residual > 0
            OR r.custody_missing_evidence > 0
            OR ifNull(c.unbalanced_assets, 0) > 0
            OR ifNull(d.duplicate_credits, 0) > 0, 'FAIL',
        r.custody_indeterminate > 0, 'INDETERMINATE',
        'OK') AS verdict
FROM
(
    SELECT
        chain_id,
        uniqExact(obligation_id) AS obligations,
        countIf(is_open) AS open_obligations,
        countIf(identity_verdict = 'BALANCED') AS identity_balanced,
        countIf(identity_verdict = 'TERMINAL_EXEMPT') AS identity_terminal_exempt,
        countIf(identity_verdict = 'RESIDUAL') AS identity_residual,
        countIf(identity_verdict = 'CONFLICTED') AS identity_conflicted,
        countIf(custody_verdict = 'BALANCED') AS custody_balanced,
        countIf(custody_verdict = 'NO_MOVEMENT_YET') AS custody_no_movement_yet,
        countIf(custody_verdict = 'INDETERMINATE') AS custody_indeterminate,
        countIf(custody_verdict = 'MISSING_CUSTODY_EVIDENCE') AS custody_missing_evidence,
        countIf(custody_verdict = 'RESIDUAL') AS custody_residual
    FROM fiet_telemetry.capital_obligation_reconciliation
    GROUP BY chain_id
) AS r
LEFT JOIN
(
    SELECT
        chain_id,
        countIf(NOT balanced) AS unbalanced_assets,
        countIf(integrity = 'CONFLICTED') AS conflicted_assets,
        countIf(asset_decimal_variants > 1) AS scale_ambiguous_assets
    FROM fiet_telemetry.capital_custody_conservation
    GROUP BY chain_id
) AS c ON r.chain_id = c.chain_id
LEFT JOIN
(
    SELECT chain_id, count() AS duplicate_credits
    FROM fiet_telemetry.capital_duplicate_credits
    GROUP BY chain_id
) AS d ON r.chain_id = d.chain_id;
