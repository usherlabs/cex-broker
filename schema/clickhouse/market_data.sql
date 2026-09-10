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
    broker_observed_timestamp String DEFAULT '',

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
    broker_observed_timestamp String DEFAULT '',
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
    capture_bundle_id Nullable(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    asset_type LowCardinality(String),
    symbol LowCardinality(String),
    trading_pair LowCardinality(String),
    source_symbol String,
    broker_observed_timestamp String DEFAULT '',

    stream_type LowCardinality(String),
    feed LowCardinality(String),
    provider LowCardinality(String),
    source_mode LowCardinality(String),
    source_time_ms UInt64,

    event_time_ms UInt64,
    received_time_ms UInt64,
    raw_capture_id Nullable(String),
    raw_capture_scope LowCardinality(Nullable(String)),
    schema_version LowCardinality(String),
    checksum_algorithm LowCardinality(String),
    raw_checksum Nullable(String),
    provenance_complete UInt8 DEFAULT 0,
    payload_encoding LowCardinality(String) DEFAULT 'legacy_json',

    payload_json String,
    normalized_row_checksum String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (exchange, asset_type, symbol, stream_type, event_time_ms)
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000000;


-- Ticker snapshots from watchTicker.
CREATE TABLE IF NOT EXISTS market_data.cex_ticker_events
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    capture_bundle_id Nullable(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    asset_type LowCardinality(String),
    symbol LowCardinality(String),
    trading_pair LowCardinality(String),
    source_symbol String,
    feed LowCardinality(String) DEFAULT 'TICKER',
    provider LowCardinality(String),
    source_mode LowCardinality(String),
    source_time_ms UInt64,
    broker_observed_timestamp String DEFAULT '',

    event_time_ms UInt64,
    received_time_ms UInt64,
    raw_capture_id Nullable(String),
    raw_capture_scope LowCardinality(Nullable(String)),
    schema_version LowCardinality(String),
    checksum_algorithm LowCardinality(String),
    raw_checksum Nullable(String),
    provenance_complete UInt8 DEFAULT 0,

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

    payload_json Nullable(String),
    normalized_row_checksum String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (exchange, asset_type, symbol, event_time_ms)
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000000;


-- Public trade prints from watchTrades.
CREATE TABLE IF NOT EXISTS market_data.cex_trades
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    capture_bundle_id Nullable(String),
    account_selector LowCardinality(String),

    exchange LowCardinality(String),
    asset_type LowCardinality(String),
    symbol LowCardinality(String),
    trading_pair LowCardinality(String),
    source_symbol String,
    feed LowCardinality(String) DEFAULT 'TRADES',
    provider LowCardinality(String),
    source_mode LowCardinality(String),
    source_time_ms UInt64,
    broker_observed_timestamp String DEFAULT '',

    trade_id String,
    event_time_ms UInt64,
    received_time_ms UInt64,
    raw_capture_id Nullable(String),
    raw_capture_scope LowCardinality(Nullable(String)),
    schema_version LowCardinality(String),
    checksum_algorithm LowCardinality(String),
    raw_checksum Nullable(String),
    provenance_complete UInt8 DEFAULT 0,

    side LowCardinality(String),
    price Decimal(18, 8),
    amount Decimal(18, 8),
    cost Nullable(Decimal(18, 8)),
    taker_or_maker LowCardinality(Nullable(String)),
    normalized_row_checksum String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_time_ms))
ORDER BY (exchange, asset_type, symbol, event_time_ms, trade_id)
TTL toDateTime(fromUnixTimestamp64Milli(event_time_ms)) + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000000;

-- Append-only physical evidence for the retained live/hot boundary.
-- Levels remain bounded schema-v1 diagnostics. Summary v2 is the only
-- supported depth-summary contract.
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
    source String,
    deployment_id String,
    capture_bundle_id String,
    exchange String,
    symbol String,
    trading_pair String,
    source_symbol String,
    asset_type String,
    feed String,
    provider String,
    source_mode String,
    source_time_ms UInt64,
    received_time_ms UInt64,
    raw_capture_id String,
    raw_capture_scope String,
    schema_version String,
    checksum_algorithm String,
    raw_checksum String,
    provenance_complete UInt8,
    snapshot_id String,
    construction_mode String,
    gap_policy String,
    depth_limit UInt16,
    sequence Nullable(UInt64),
    exact_l2_reconstruction_complete UInt8,
    capture_profile_id String,
    effective_cadence_ms UInt32,
    requested_upstream_depth Nullable(UInt16),
    observed_bid_count UInt32,
    observed_ask_count UInt32,
    observed_farthest_bid Decimal(38, 18),
    observed_farthest_ask Decimal(38, 18),
    retained_farthest_bid Decimal(38, 18),
    retained_farthest_ask Decimal(38, 18),
    bid_exhausted UInt8,
    ask_exhausted UInt8,
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
    bid_boundary_price_by_band Array(Decimal(38, 18)),
    ask_boundary_price_by_band Array(Decimal(38, 18)),
    bid_depth_by_band Array(Decimal(38, 18)),
    ask_depth_by_band Array(Decimal(38, 18)),
    bid_status_by_band Array(Enum8('exact' = 1, 'censored' = 2)),
    ask_status_by_band Array(Enum8('exact' = 1, 'censored' = 2)),
    normalized_row_checksum String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(source_time_ms))
ORDER BY (exchange, trading_pair, capture_bundle_id, source_time_ms, raw_capture_id, snapshot_id, schema_version)
TTL toDateTime(fromUnixTimestamp64Milli(source_time_ms)) + INTERVAL 90 DAY
SETTINGS non_replicated_deduplication_window = 1000000;

CREATE OR REPLACE VIEW market_data.cex_order_book_levels_conflicts AS
SELECT
    capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
    schema_version, side, level_index,
    groupUniqArray(normalized_row_checksum) AS distinct_checksums,
    count() AS physical_row_count
FROM market_data.cex_order_book_levels
WHERE source IN ('broker_read', 'broker_write')
  AND schema_version = '1.0.0'
GROUP BY capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
    schema_version, side, level_index
HAVING uniqExact(normalized_row_checksum) > 1;

CREATE OR REPLACE VIEW market_data.cex_order_book_levels_canonical AS
SELECT DISTINCT evidence.*
FROM market_data.cex_order_book_levels AS evidence
INNER JOIN
(
    SELECT
        capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
        schema_version, side, level_index,
        any(normalized_row_checksum) AS agreed_checksum
    FROM market_data.cex_order_book_levels
    WHERE source IN ('broker_read', 'broker_write')
      AND schema_version = '1.0.0'
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
AND evidence.normalized_row_checksum = consistent.agreed_checksum
WHERE evidence.source IN ('broker_read', 'broker_write')
  AND evidence.schema_version = '1.0.0';

CREATE OR REPLACE VIEW market_data.cex_order_book_depth_summary_conflicts AS
SELECT
    capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
    schema_version,
    groupUniqArray(normalized_row_checksum) AS distinct_checksums,
    count() AS physical_row_count
FROM market_data.cex_order_book_depth_summary
WHERE source IN ('broker_read', 'broker_write')
  AND schema_version = '2.0.0'
  AND provenance_complete = 1
  AND capture_bundle_id != ''
  AND raw_capture_id != ''
  AND raw_checksum != ''
  AND capture_profile_id != ''
  AND effective_cadence_ms > 0
  AND observed_bid_count > 0
  AND observed_ask_count > 0
  AND bid_level_count > 0
  AND ask_level_count > 0
  AND length(measurement_bands_bps) BETWEEN 1 AND 64
  AND arrayAll(value -> value BETWEEN 1 AND 10000, measurement_bands_bps)
  AND measurement_bands_bps = arraySort(arrayDistinct(measurement_bands_bps))
  AND length(bid_boundary_price_by_band) = length(measurement_bands_bps)
  AND length(ask_boundary_price_by_band) = length(measurement_bands_bps)
  AND length(bid_depth_by_band) = length(measurement_bands_bps)
  AND length(ask_depth_by_band) = length(measurement_bands_bps)
  AND length(bid_status_by_band) = length(measurement_bands_bps)
  AND length(ask_status_by_band) = length(measurement_bands_bps)
GROUP BY capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
    schema_version
HAVING uniqExact(normalized_row_checksum) > 1;

CREATE OR REPLACE VIEW market_data.cex_order_book_depth_summary_canonical AS
SELECT DISTINCT
    CAST(evidence.source, 'String') AS source,
    CAST(evidence.deployment_id, 'String') AS deployment_id,
    CAST(assumeNotNull(evidence.capture_bundle_id), 'String') AS capture_bundle_id,
    CAST(evidence.exchange, 'String') AS exchange,
    CAST(evidence.symbol, 'String') AS symbol,
    CAST(evidence.trading_pair, 'String') AS trading_pair,
    CAST(evidence.source_symbol, 'String') AS source_symbol,
    CAST(evidence.asset_type, 'String') AS asset_type,
    CAST(evidence.feed, 'String') AS feed,
    CAST(evidence.provider, 'String') AS provider,
    CAST(evidence.source_mode, 'String') AS source_mode,
    CAST(evidence.source_time_ms, 'UInt64') AS source_time_ms,
    CAST(evidence.received_time_ms, 'UInt64') AS received_time_ms,
    CAST(assumeNotNull(evidence.raw_capture_id), 'String') AS raw_capture_id,
    CAST(assumeNotNull(evidence.raw_capture_scope), 'String') AS raw_capture_scope,
    CAST(evidence.schema_version, 'String') AS schema_version,
    CAST(evidence.checksum_algorithm, 'String') AS checksum_algorithm,
    CAST(assumeNotNull(evidence.raw_checksum), 'String') AS raw_checksum,
    CAST(evidence.provenance_complete, 'UInt8') AS provenance_complete,
    CAST(evidence.snapshot_id, 'String') AS snapshot_id,
    CAST(evidence.construction_mode, 'String') AS construction_mode,
    CAST(evidence.gap_policy, 'String') AS gap_policy,
    CAST(evidence.depth_limit, 'UInt16') AS depth_limit,
    CAST(evidence.sequence, 'Nullable(UInt64)') AS sequence,
    CAST(evidence.exact_l2_reconstruction_complete, 'UInt8') AS exact_l2_reconstruction_complete,
    CAST(evidence.capture_profile_id, 'String') AS capture_profile_id,
    CAST(evidence.effective_cadence_ms, 'UInt32') AS effective_cadence_ms,
    CAST(evidence.requested_upstream_depth, 'Nullable(UInt16)') AS requested_upstream_depth,
    CAST(evidence.observed_bid_count, 'UInt32') AS observed_bid_count,
    CAST(evidence.observed_ask_count, 'UInt32') AS observed_ask_count,
    CAST(evidence.observed_farthest_bid, 'Decimal(38, 18)') AS observed_farthest_bid,
    CAST(evidence.observed_farthest_ask, 'Decimal(38, 18)') AS observed_farthest_ask,
    CAST(evidence.retained_farthest_bid, 'Decimal(38, 18)') AS retained_farthest_bid,
    CAST(evidence.retained_farthest_ask, 'Decimal(38, 18)') AS retained_farthest_ask,
    CAST(evidence.bid_exhausted, 'UInt8') AS bid_exhausted,
    CAST(evidence.ask_exhausted, 'UInt8') AS ask_exhausted,
    CAST(evidence.best_bid, 'Decimal(38, 18)') AS best_bid,
    CAST(evidence.best_ask, 'Decimal(38, 18)') AS best_ask,
    CAST(evidence.best_bid_amount, 'Decimal(38, 18)') AS best_bid_amount,
    CAST(evidence.best_ask_amount, 'Decimal(38, 18)') AS best_ask_amount,
    CAST(evidence.mid_price, 'Decimal(38, 18)') AS mid_price,
    CAST(evidence.spread, 'Decimal(38, 18)') AS spread,
    CAST(evidence.spread_bps, 'Float64') AS spread_bps,
    CAST(evidence.staleness_ms, 'UInt64') AS staleness_ms,
    CAST(evidence.bid_level_count, 'UInt16') AS bid_level_count,
    CAST(evidence.ask_level_count, 'UInt16') AS ask_level_count,
    CAST(evidence.measurement_bands_bps, 'Array(UInt32)') AS measurement_bands_bps,
    CAST(evidence.bid_boundary_price_by_band, 'Array(Decimal(38, 18))') AS bid_boundary_price_by_band,
    CAST(evidence.ask_boundary_price_by_band, 'Array(Decimal(38, 18))') AS ask_boundary_price_by_band,
    CAST(evidence.bid_depth_by_band, 'Array(Decimal(38, 18))') AS bid_depth_by_band,
    CAST(evidence.ask_depth_by_band, 'Array(Decimal(38, 18))') AS ask_depth_by_band,
    CAST(evidence.bid_status_by_band, 'Array(Enum8(\'exact\' = 1, \'censored\' = 2))') AS bid_status_by_band,
    CAST(evidence.ask_status_by_band, 'Array(Enum8(\'exact\' = 1, \'censored\' = 2))') AS ask_status_by_band,
    CAST(evidence.normalized_row_checksum, 'String') AS normalized_row_checksum
FROM market_data.cex_order_book_depth_summary AS evidence
INNER JOIN
(
    SELECT
        capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id,
        schema_version, any(normalized_row_checksum) AS agreed_checksum
    FROM market_data.cex_order_book_depth_summary
    WHERE source IN ('broker_read', 'broker_write')
      AND schema_version = '2.0.0'
      AND provenance_complete = 1
      AND capture_bundle_id IS NOT NULL
      AND raw_capture_id IS NOT NULL
      AND raw_capture_scope IS NOT NULL
      AND raw_checksum IS NOT NULL
      AND capture_bundle_id != ''
      AND raw_capture_id != ''
      AND raw_capture_scope != ''
      AND raw_checksum != ''
      AND capture_profile_id != ''
      AND effective_cadence_ms > 0
      AND observed_bid_count > 0
      AND observed_ask_count > 0
      AND bid_level_count > 0
      AND ask_level_count > 0
      AND length(measurement_bands_bps) BETWEEN 1 AND 64
      AND arrayAll(value -> value BETWEEN 1 AND 10000, measurement_bands_bps)
      AND measurement_bands_bps = arraySort(arrayDistinct(measurement_bands_bps))
      AND length(bid_boundary_price_by_band) = length(measurement_bands_bps)
      AND length(ask_boundary_price_by_band) = length(measurement_bands_bps)
      AND length(bid_depth_by_band) = length(measurement_bands_bps)
      AND length(ask_depth_by_band) = length(measurement_bands_bps)
      AND length(bid_status_by_band) = length(measurement_bands_bps)
      AND length(ask_status_by_band) = length(measurement_bands_bps)
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
AND evidence.normalized_row_checksum = consistent.agreed_checksum
WHERE evidence.source IN ('broker_read', 'broker_write')
  AND evidence.schema_version = '2.0.0'
  AND evidence.provenance_complete = 1
  AND evidence.capture_bundle_id IS NOT NULL
  AND evidence.raw_capture_id IS NOT NULL
  AND evidence.raw_capture_scope IS NOT NULL
  AND evidence.raw_checksum IS NOT NULL;

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

