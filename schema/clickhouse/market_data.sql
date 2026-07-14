-- Market data tables for cex-broker subscribe watch streams
-- (ORDERBOOK, OHLCV, TRADES, TICKER, BALANCE, ORDERS).
--
-- Forwarder contract (HTTP POST from BrokerExecutionArchiver):
--   Default URL: {protocol}://{CEX_BROKER_CLICKHOUSE_HOST}:{8090}/archive
--   Override host: CEX_BROKER_ARCHIVE_FORWARDER_HOST
--   Override URL: CEX_BROKER_ARCHIVE_FORWARDER_URL
--   {
--     "source": "broker_write",
--     "deployment_id": "<deployment>",
--     "rows": [{ "table": "<fully.qualified.table>", "row": { ...columns } }]
--   }
--
-- The forwarder is the single durable sink for every archive table: market_data.*
-- here, plus broker_execution.* (broker_execution.sql), broker_account.*
-- (broker_account.sql), and strategy_data.* (strategy_data.sql). Execution rows
-- may ALSO be mirrored to OTel logs for
-- observability when CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED=true; that mirror is in
-- addition to the forwarder, not a replacement, and market_data.* is never
-- mirrored (no OTel schema exists for it).

CREATE DATABASE IF NOT EXISTS market_data;


CREATE TABLE IF NOT EXISTS market_data.orderbook_snapshots
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    asset_type LowCardinality(String),
    symbol LowCardinality(String),

    event_time_ms UInt64,
    received_time_ms UInt64,

    best_bid Decimal(18, 8),
    best_ask Decimal(18, 8),
    bid_size Decimal(18, 8),
    ask_size Decimal(18, 8),
    mid Decimal(18, 8),
    spread_bps Float32,

    depth_limit UInt16,
    bid_levels UInt16,
    ask_levels UInt16,

    bids_price Array(Decimal(18, 8)),
    bids_size Array(Decimal(18, 8)),
    asks_price Array(Decimal(18, 8)),
    asks_size Array(Decimal(18, 8)),

    sequence Nullable(UInt64)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (exchange, asset_type, symbol, event_time_ms)
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY;

-- Backward-compatible views (query only; inserts use orderbook_snapshots).
CREATE VIEW IF NOT EXISTS market_data.orderbook_tob AS
SELECT
    source,
    deployment_id,
    account_selector,
    exchange,
    asset_type,
    symbol,
    event_time_ms,
    received_time_ms,
    best_bid,
    best_ask,
    bid_size,
    ask_size,
    mid,
    spread_bps,
    sequence
FROM market_data.orderbook_snapshots;

CREATE VIEW IF NOT EXISTS market_data.orderbook_depth AS
SELECT
    source,
    deployment_id,
    account_selector,
    exchange,
    asset_type,
    symbol,
    event_time_ms,
    received_time_ms,
    depth_limit,
    bid_levels,
    ask_levels,
    bids_price,
    bids_size,
    asks_price,
    asks_size,
    sequence
FROM market_data.orderbook_snapshots;

-- OHLCV candles from fetchOHLCVWs (forming + closed via ReplacingMergeTree).
CREATE TABLE IF NOT EXISTS market_data.candles
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    asset_type LowCardinality(String),
    symbol LowCardinality(String),
    timeframe LowCardinality(String),

    open_time_ms UInt64,

    open Decimal(18, 8),
    high Decimal(18, 8),
    low Decimal(18, 8),
    close Decimal(18, 8),
    volume Decimal(18, 8),
    quote_volume Nullable(Decimal(18, 8)),

    is_closed UInt8,
    broker_version UInt64
)
ENGINE = ReplacingMergeTree(broker_version)
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(open_time_ms))
ORDER BY (exchange, asset_type, symbol, timeframe, open_time_ms);

-- Deduped closed candles for research/backtest queries (ReplacingMergeTree FINAL).
CREATE VIEW IF NOT EXISTS market_data.candles_closed AS
SELECT *
FROM market_data.candles FINAL
WHERE is_closed = 1;

-- Generic subscribe stream payloads (balance, orders, etc.).
CREATE TABLE IF NOT EXISTS market_data.cex_stream_events
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    asset_type LowCardinality(String),
    symbol LowCardinality(String),

    stream_type LowCardinality(String),

    event_time_ms UInt64,
    received_time_ms UInt64,

    payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (exchange, asset_type, symbol, stream_type, event_time_ms)
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY;

-- Ticker snapshots from watchTicker.
CREATE TABLE IF NOT EXISTS market_data.cex_ticker_events
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    asset_type LowCardinality(String),
    symbol LowCardinality(String),

    event_time_ms UInt64,
    received_time_ms UInt64,

    last Nullable(Decimal(18, 8)),
    bid Nullable(Decimal(18, 8)),
    ask Nullable(Decimal(18, 8)),
    high Nullable(Decimal(18, 8)),
    low Nullable(Decimal(18, 8)),
    open Nullable(Decimal(18, 8)),
    close Nullable(Decimal(18, 8)),
    base_volume Nullable(Decimal(18, 8)),
    quote_volume Nullable(Decimal(18, 8)),
    change Nullable(Decimal(18, 8)),
    percentage Nullable(Decimal(18, 8)),

    payload_json Nullable(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (exchange, asset_type, symbol, event_time_ms)
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY;

-- Public trade prints from watchTrades.
CREATE TABLE IF NOT EXISTS market_data.cex_trades
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    asset_type LowCardinality(String),
    symbol LowCardinality(String),

    trade_id String,
    event_time_ms UInt64,
    received_time_ms UInt64,

    side LowCardinality(String),
    price Decimal(18, 8),
    amount Decimal(18, 8),
    cost Nullable(Decimal(18, 8)),
    taker_or_maker LowCardinality(Nullable(String))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (exchange, asset_type, symbol, event_time_ms, trade_id)
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY;
