-- Market data tables for cex-broker subscribe watch streams
-- (ORDERBOOK, OHLCV, TRADES, TICKER, BALANCE, ORDERS).
--
-- Forwarder contract (HTTP POST from BrokerExecutionArchiver):
--   Enabled only by CEX_BROKER_ARCHIVE_ENABLED=true.
--   URL: CEX_BROKER_ARCHIVE_FORWARDER_URL (required, no derived default).
--   Loss journal: CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH (required, writable).
--   {
--     "source": "broker_write",
--     "deployment_id": "<deployment>",
--     "batch_id": "<stable across retries of these exact rows>",
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
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000000;

-- Every legacy market-data producer has emitted this common archive tag since
-- the pre-canonical baseline. Add it idempotently so fresh and upgraded schemas
-- preserve the producer value instead of rejecting or dropping it.
ALTER TABLE market_data.orderbook_snapshots ADD COLUMN IF NOT EXISTS broker_observed_timestamp String DEFAULT '' AFTER symbol;

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
ORDER BY (exchange, asset_type, symbol, timeframe, open_time_ms)
SETTINGS non_replicated_deduplication_window = 1000000;

ALTER TABLE market_data.candles ADD COLUMN IF NOT EXISTS broker_observed_timestamp String DEFAULT '' AFTER symbol;

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
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000000;

ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS broker_observed_timestamp String DEFAULT '' AFTER symbol;

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
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000000;

ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS broker_observed_timestamp String DEFAULT '' AFTER symbol;

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
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000000;

ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS broker_observed_timestamp String DEFAULT '' AFTER symbol;

-- Replay capture-core columns are added idempotently so this schema upgrades
-- installations created before canonical replay capture was introduced.
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS capture_bundle_id Nullable(String) AFTER deployment_id;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS trading_pair LowCardinality(String) AFTER symbol;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS source_symbol String AFTER trading_pair;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS feed LowCardinality(String) AFTER stream_type;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS provider LowCardinality(String) AFTER feed;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS source_mode LowCardinality(String) AFTER provider;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS source_time_ms UInt64 AFTER source_mode;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS raw_capture_id Nullable(String) AFTER received_time_ms;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS raw_capture_scope LowCardinality(Nullable(String)) AFTER raw_capture_id;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS schema_version LowCardinality(String) AFTER raw_capture_scope;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS checksum_algorithm LowCardinality(String) AFTER schema_version;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS raw_checksum Nullable(String) AFTER checksum_algorithm;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS provenance_complete UInt8 DEFAULT 0 AFTER raw_checksum;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS payload_encoding LowCardinality(String) DEFAULT 'legacy_json' AFTER provenance_complete;
ALTER TABLE market_data.cex_stream_events ADD COLUMN IF NOT EXISTS normalized_row_checksum String DEFAULT '' AFTER payload_json;

ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS capture_bundle_id Nullable(String) AFTER deployment_id;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS trading_pair LowCardinality(String) AFTER symbol;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS source_symbol String AFTER trading_pair;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS feed LowCardinality(String) DEFAULT 'TICKER' AFTER source_symbol;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS provider LowCardinality(String) AFTER feed;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS source_mode LowCardinality(String) AFTER provider;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS source_time_ms UInt64 AFTER source_mode;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS raw_capture_id Nullable(String) AFTER received_time_ms;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS raw_capture_scope LowCardinality(Nullable(String)) AFTER raw_capture_id;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS schema_version LowCardinality(String) AFTER raw_capture_scope;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS checksum_algorithm LowCardinality(String) AFTER schema_version;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS raw_checksum Nullable(String) AFTER checksum_algorithm;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS provenance_complete UInt8 DEFAULT 0 AFTER raw_checksum;
ALTER TABLE market_data.cex_ticker_events ADD COLUMN IF NOT EXISTS normalized_row_checksum String DEFAULT '' AFTER payload_json;

ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS capture_bundle_id Nullable(String) AFTER deployment_id;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS trading_pair LowCardinality(String) AFTER symbol;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS source_symbol String AFTER trading_pair;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS feed LowCardinality(String) DEFAULT 'TRADES' AFTER source_symbol;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS provider LowCardinality(String) AFTER feed;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS source_mode LowCardinality(String) AFTER provider;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS source_time_ms UInt64 AFTER source_mode;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS raw_capture_id Nullable(String) AFTER received_time_ms;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS raw_capture_scope LowCardinality(Nullable(String)) AFTER raw_capture_id;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS schema_version LowCardinality(String) AFTER raw_capture_scope;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS checksum_algorithm LowCardinality(String) AFTER schema_version;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS raw_checksum Nullable(String) AFTER checksum_algorithm;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS provenance_complete UInt8 DEFAULT 0 AFTER raw_checksum;
ALTER TABLE market_data.cex_trades ADD COLUMN IF NOT EXISTS normalized_row_checksum String DEFAULT '' AFTER taker_or_maker;

-- Append-only physical evidence. Canonical and conflict views below implement
-- query-time idempotency without erasing disagreeing deliveries.
CREATE TABLE IF NOT EXISTS market_data.cex_order_book_levels
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    capture_bundle_id Nullable(String),
    exchange LowCardinality(String),
    symbol LowCardinality(String),
    trading_pair LowCardinality(String),
    source_symbol String,
    asset_type LowCardinality(String),
    feed LowCardinality(String),
    provider LowCardinality(String),
    source_mode LowCardinality(String),
    source_time_ms UInt64,
    received_time_ms UInt64,
    raw_capture_id Nullable(String),
    raw_capture_scope LowCardinality(Nullable(String)),
    schema_version LowCardinality(String),
    checksum_algorithm LowCardinality(String),
    raw_checksum Nullable(String),
    provenance_complete UInt8,
    snapshot_id String,
    construction_mode LowCardinality(String),
    gap_policy LowCardinality(String),
    depth_limit UInt16,
    sequence Nullable(UInt64),
    exact_l2_reconstruction_complete UInt8,
    side LowCardinality(String),
    level_index UInt16,
    price Decimal(38, 18),
    amount Decimal(38, 18),
    notional Decimal(38, 18),
    mid_price Decimal(38, 18),
    spread_from_mid_bps Float64,
    normalized_row_checksum String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(source_time_ms))
ORDER BY (exchange, trading_pair, capture_bundle_id, source_time_ms, raw_capture_id, snapshot_id, schema_version, side, level_index)
TTL toDateTime(fromUnixTimestamp64Milli(source_time_ms)) + INTERVAL 90 DAY
SETTINGS allow_nullable_key = 1, non_replicated_deduplication_window = 1000000;

CREATE TABLE IF NOT EXISTS market_data.cex_order_book_depth_summary
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    capture_bundle_id Nullable(String),
    exchange LowCardinality(String),
    symbol LowCardinality(String),
    trading_pair LowCardinality(String),
    source_symbol String,
    asset_type LowCardinality(String),
    feed LowCardinality(String),
    provider LowCardinality(String),
    source_mode LowCardinality(String),
    source_time_ms UInt64,
    received_time_ms UInt64,
    raw_capture_id Nullable(String),
    raw_capture_scope LowCardinality(Nullable(String)),
    schema_version LowCardinality(String),
    checksum_algorithm LowCardinality(String),
    raw_checksum Nullable(String),
    provenance_complete UInt8,
    snapshot_id String,
    construction_mode LowCardinality(String),
    gap_policy LowCardinality(String),
    depth_limit UInt16,
    sequence Nullable(UInt64),
    exact_l2_reconstruction_complete UInt8,
    best_bid Decimal(38, 18),
    best_ask Decimal(38, 18),
    best_bid_amount Decimal(38, 18),
    best_ask_amount Decimal(38, 18),
    mid_price Decimal(38, 18),
    spread Decimal(38, 18),
    spread_bps Float64,
    staleness_ms UInt64,
    bid_level_count UInt16,
    ask_level_count UInt16,
    measurement_bands_bps Array(UInt32),
    bid_depth_by_band Array(Decimal(38, 18)),
    ask_depth_by_band Array(Decimal(38, 18)),
    normalized_row_checksum String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(source_time_ms))
ORDER BY (exchange, trading_pair, capture_bundle_id, source_time_ms, raw_capture_id, snapshot_id, schema_version)
TTL toDateTime(fromUnixTimestamp64Milli(source_time_ms)) + INTERVAL 90 DAY
SETTINGS allow_nullable_key = 1, non_replicated_deduplication_window = 1000000;

CREATE VIEW IF NOT EXISTS market_data.cex_order_book_levels_conflicts AS
SELECT
    capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
    schema_version, side, level_index,
    groupUniqArray(normalized_row_checksum) AS distinct_checksums,
    count() AS physical_row_count
FROM market_data.cex_order_book_levels
GROUP BY capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
    schema_version, side, level_index
HAVING uniqExact(normalized_row_checksum) > 1;

CREATE VIEW IF NOT EXISTS market_data.cex_order_book_levels_canonical AS
SELECT DISTINCT evidence.*
FROM market_data.cex_order_book_levels AS evidence
INNER JOIN
(
    SELECT
        capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
        schema_version, side, level_index,
        any(normalized_row_checksum) AS agreed_checksum
    FROM market_data.cex_order_book_levels
    GROUP BY capture_bundle_id, exchange, trading_pair, raw_capture_id,
        snapshot_id, schema_version, side, level_index
    HAVING uniqExact(normalized_row_checksum) = 1
) AS consistent
ON evidence.capture_bundle_id IS NOT DISTINCT FROM consistent.capture_bundle_id
AND evidence.exchange = consistent.exchange
AND evidence.trading_pair = consistent.trading_pair
AND evidence.raw_capture_id IS NOT DISTINCT FROM consistent.raw_capture_id
AND evidence.snapshot_id = consistent.snapshot_id
AND evidence.schema_version = consistent.schema_version
AND evidence.side = consistent.side
AND evidence.level_index = consistent.level_index
AND evidence.normalized_row_checksum = consistent.agreed_checksum;

CREATE VIEW IF NOT EXISTS market_data.cex_order_book_depth_summary_conflicts AS
SELECT
    capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
    schema_version,
    groupUniqArray(normalized_row_checksum) AS distinct_checksums,
    count() AS physical_row_count
FROM market_data.cex_order_book_depth_summary
GROUP BY capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
    schema_version
HAVING uniqExact(normalized_row_checksum) > 1;

CREATE VIEW IF NOT EXISTS market_data.cex_order_book_depth_summary_canonical AS
SELECT DISTINCT evidence.*
FROM market_data.cex_order_book_depth_summary AS evidence
INNER JOIN
(
    SELECT
        capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
        schema_version, any(normalized_row_checksum) AS agreed_checksum
    FROM market_data.cex_order_book_depth_summary
    GROUP BY capture_bundle_id, exchange, trading_pair, raw_capture_id,
        snapshot_id, schema_version
    HAVING uniqExact(normalized_row_checksum) = 1
) AS consistent
ON evidence.capture_bundle_id IS NOT DISTINCT FROM consistent.capture_bundle_id
AND evidence.exchange = consistent.exchange
AND evidence.trading_pair = consistent.trading_pair
AND evidence.raw_capture_id IS NOT DISTINCT FROM consistent.raw_capture_id
AND evidence.snapshot_id = consistent.snapshot_id
AND evidence.schema_version = consistent.schema_version
AND evidence.normalized_row_checksum = consistent.agreed_checksum;

CREATE TABLE IF NOT EXISTS market_data.cex_ohlcv
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    capture_bundle_id Nullable(String),
    exchange LowCardinality(String),
    symbol LowCardinality(String),
    trading_pair LowCardinality(String),
    source_symbol String,
    asset_type LowCardinality(String),
    feed LowCardinality(String),
    provider LowCardinality(String),
    source_mode LowCardinality(String),
    source_time_ms UInt64,
    received_time_ms UInt64,
    raw_capture_id Nullable(String),
    raw_capture_scope LowCardinality(Nullable(String)),
    schema_version LowCardinality(String),
    checksum_algorithm LowCardinality(String),
    raw_checksum Nullable(String),
    provenance_complete UInt8,
    timeframe LowCardinality(String),
    open_time_ms UInt64,
    open Decimal(38, 18),
    high Decimal(38, 18),
    low Decimal(38, 18),
    close Decimal(38, 18),
    volume Decimal(38, 18),
    quote_volume Nullable(Decimal(38, 18)),
    is_closed UInt8,
    broker_version UInt64,
    normalized_row_checksum String
)
ENGINE = ReplacingMergeTree(broker_version)
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(open_time_ms))
ORDER BY (exchange, trading_pair, timeframe, open_time_ms, schema_version)
SETTINGS allow_nullable_key = 1, non_replicated_deduplication_window = 1000000;

CREATE VIEW IF NOT EXISTS market_data.cex_ohlcv_closed AS
SELECT *
FROM market_data.cex_ohlcv FINAL
WHERE is_closed = 1;

-- Insert deduplication for the forwarder's retry path. A batch the forwarder
-- could not fully commit is re-posted verbatim under its original id, so the
-- tables that already landed are inserted again; each insert carries a token
-- derived from that id, and this window is what makes ClickHouse recognise the
-- token and skip the repeat. Existing deployments pick it up here, since the
-- CREATE statements above are no-ops once the tables exist.
ALTER TABLE market_data.orderbook_snapshots
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.candles
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.cex_stream_events
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.cex_ticker_events
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.cex_trades
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.cex_order_book_levels
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.cex_order_book_depth_summary
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.cex_ohlcv
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
