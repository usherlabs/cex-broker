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

    order_id String,
    client_order_id String,
    idempotency_id String,
    maker_action_id String,
    market_metadata_hash String,

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

    client_order_id String,
    order_id String,
    maker_action_id String,
    idempotency_id String,
    market_metadata_hash String,

    snapshot_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(parseDateTimeBestEffortOrZero(broker_observed_timestamp))
ORDER BY (exchange, symbol, broker_observed_timestamp);
