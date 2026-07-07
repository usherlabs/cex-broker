-- Broker execution audit tables (order lifecycle + pre-order market metadata).
--
-- Columns are derived 1:1 from the row builders in
-- src/helpers/broker-execution-archive/rows.ts. Every field those builders emit
-- has a column here; the full untruncated telemetry is also kept in payload_json.
--
-- These rows reach ClickHouse through the same archive forwarder as market_data.*
-- (HTTP POST /archive). Unlike market_data streams they carry no Int64-ms event
-- column, so partitioning uses the always-present ISO8601 broker_observed_timestamp
-- as the event-time source (parsed to DateTime).
--
-- NO TTL: these are execution audit facts and must not expire (market_data
-- streams carry a 90-day TTL; execution history is retained indefinitely).

CREATE DATABASE IF NOT EXISTS broker_execution;

-- Order lifecycle events: execute-action results and user-stream order updates.
CREATE TABLE IF NOT EXISTS broker_execution.order_events
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    symbol LowCardinality(String),
    broker_observed_timestamp String,

    event_kind LowCardinality(String),
    action LowCardinality(String),
    subscription_type LowCardinality(String),

    -- Optional join keys: the row builders omit absent identifiers, so these are
    -- Nullable rather than plain String. A non-nullable String would default to
    -- '' on omission, and two rows that both lack a value would spuriously match
    -- on '' in the documented joins (maker_action_id / idempotency_id /
    -- client_order_id / order_id / market_metadata_hash). None are ORDER BY keys.
    order_id Nullable(String),
    client_order_id Nullable(String),
    idempotency_id Nullable(String),
    maker_action_id Nullable(String),
    market_metadata_hash Nullable(String),

    status LowCardinality(String),
    side LowCardinality(String),
    order_type LowCardinality(String),

    requested_quantity Nullable(Float64),
    requested_notional Nullable(Float64),
    executed_base_quantity Nullable(Float64),
    executed_quote_quantity Nullable(Float64),
    average_execution_price Nullable(Float64),
    filled_amount Nullable(Float64),
    remaining_amount Nullable(Float64),
    fee_amount Nullable(Float64),
    fee_currency LowCardinality(String),
    fee_rate Nullable(Float64),

    exchange_timestamp String,
    error_type LowCardinality(String),
    error_message String,

    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(parseDateTimeBestEffortOrZero(broker_observed_timestamp))
ORDER BY (exchange, symbol, broker_observed_timestamp);

-- CEX value movements: withdrawals, deposits, and sub<->master internal transfers.
--
-- Column names/types/ORDER BY match the fiet-maker consumer contract
-- (docs/CEX_EXECUTION_ARCHIVE_CONTRACT.md + scripts/sql/clickhouse-schema.sql):
-- MergeTree with a 90-day TTL, DateTime64(3,'UTC') timestamps, string quantities,
-- result_index UInt32, error_summary. Two ADDITIVE columns not in the consumer
-- contract: fee_amount / fee_currency (the ccxt withdrawal object exposes the fee,
-- the dominant small-commit cost). broker_observed_timestamp is emitted as an
-- ISO-8601 UTC string and parsed on insert via the forwarder's
-- date_time_input_format=best_effort (see services/archive-forwarder/index.ts).
--
-- Engine is plain MergeTree (contract), so re-observed rows are NOT collapsed;
-- dedup, when needed, is at read time (GROUP BY / argMax over exchange,
-- account_selector, symbol, external_id, lifecycle_action).
CREATE TABLE IF NOT EXISTS broker_execution.transfer_events
(
    broker_observed_timestamp DateTime64(3, 'UTC'),
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    schema_version LowCardinality(String),
    account_selector LowCardinality(String),
    exchange LowCardinality(String),
    symbol LowCardinality(String),
    event_kind LowCardinality(String),
    lifecycle_action LowCardinality(String),
    status LowCardinality(String) DEFAULT '',
    asset_symbol LowCardinality(String) DEFAULT '',
    amount String DEFAULT '',
    address String DEFAULT '',
    network LowCardinality(String) DEFAULT '',
    external_id String DEFAULT '',
    txid String DEFAULT '',
    result_index UInt32 DEFAULT 0,
    fee_amount String DEFAULT '',
    fee_currency LowCardinality(String) DEFAULT '',
    exchange_timestamp Nullable(DateTime64(3, 'UTC')),
    error_summary String DEFAULT '',
    payload_json String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toDate(broker_observed_timestamp)
ORDER BY (account_selector, broker_observed_timestamp, exchange, symbol, event_kind, lifecycle_action)
TTL toDateTime(broker_observed_timestamp) + toIntervalDay(90)
SETTINGS ttl_only_drop_parts = 1;

-- Per-fill execution facts from the venue trade-history endpoint (fetchMyTrades),
-- captured by the broker-internal fill poller. GetOrderDetails/createOrder payloads
-- carry no per-trade breakdown and no fee on most venues, so per-fill truth
-- (incl. fee) requires this endpoint; hence event_kind is stamped
-- "trade_history_fill" rather than the contract fixture's "create_order_fill".
--
-- Column names/types/ORDER BY match the fiet-maker consumer contract: MergeTree +
-- 90-day TTL, DateTime64 timestamps, string quantities, fill_index UInt32. Plain
-- MergeTree (contract): the poller re-scans a lookback window after a restart, so
-- the same trade can be re-inserted; dedup is at read time (GROUP BY / argMax over
-- exchange, account_selector, symbol, order_id, fill_id).
CREATE TABLE IF NOT EXISTS broker_execution.fill_events
(
    broker_observed_timestamp DateTime64(3, 'UTC'),
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    schema_version LowCardinality(String),
    account_selector LowCardinality(String),
    exchange LowCardinality(String),
    symbol LowCardinality(String),
    event_kind LowCardinality(String),
    order_id String,
    client_order_id String DEFAULT '',
    fill_id String DEFAULT '',
    fill_index UInt32 DEFAULT 0,
    side LowCardinality(String) DEFAULT '',
    order_type LowCardinality(String) DEFAULT '',
    price String DEFAULT '',
    base_quantity String DEFAULT '',
    quote_quantity String DEFAULT '',
    fee_amount String DEFAULT '',
    fee_currency LowCardinality(String) DEFAULT '',
    fee_rate String DEFAULT '',
    exchange_timestamp Nullable(DateTime64(3, 'UTC')),
    payload_json String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toDate(broker_observed_timestamp)
ORDER BY (symbol, account_selector, broker_observed_timestamp, exchange, order_id, fill_index)
TTL toDateTime(broker_observed_timestamp) + toIntervalDay(90)
SETTINGS ttl_only_drop_parts = 1;

-- Pre-order top-of-book snapshots captured immediately before an order action,
-- joinable to order_events via market_metadata_hash and the order identifiers.
CREATE TABLE IF NOT EXISTS broker_execution.market_metadata_snapshots
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    symbol LowCardinality(String),
    broker_observed_timestamp String,

    -- Optional join keys (see order_events): Nullable so an omitted identifier is
    -- NULL, not '', avoiding spurious ''-on-'' matches. market_metadata_hash is
    -- always computed for a snapshot row, so it stays non-nullable.
    client_order_id Nullable(String),
    order_id Nullable(String),
    maker_action_id Nullable(String),
    idempotency_id Nullable(String),
    market_metadata_hash String,

    snapshot_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(parseDateTimeBestEffortOrZero(broker_observed_timestamp))
ORDER BY (exchange, symbol, broker_observed_timestamp);
