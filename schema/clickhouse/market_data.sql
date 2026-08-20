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
    capture_origin LowCardinality(String) DEFAULT if(source = 'external_backfill', 'vendor_historical_backfill', 'production_capture'),
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
    DELETE WHERE source != 'external_backfill'
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
    capture_origin LowCardinality(String) DEFAULT if(source = 'external_backfill', 'vendor_historical_backfill', 'production_capture'),
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
    DELETE WHERE source != 'external_backfill'
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

-- A passing row is the last-write commit marker for one content-addressed
-- external capture. Candidate rows remain auditable in the physical/canonical
-- tables, but replay readers cannot see them through the qualified views below
-- until this exact scope is present.
CREATE TABLE IF NOT EXISTS market_data.cex_order_book_capture_promotions
(
    source LowCardinality(String),
    capture_origin LowCardinality(String),
    source_mode LowCardinality(String),
    deployment_id LowCardinality(String),
    receipt_schema_version LowCardinality(String),
    receipt_id String,
    promotion_identity_sha256 String,
    request_id String,
    idempotency_key String,
    status LowCardinality(String),
    capture_bundle_id String,
    provider LowCardinality(String),
    adapter_version LowCardinality(String),
    exchange LowCardinality(String),
    trading_pair LowCardinality(String),
    asset_type LowCardinality(String),
    feed LowCardinality(String),
    window_start_ms UInt64,
    window_end_ms UInt64,
    depth_limit UInt16,
    construction_mode LowCardinality(String),
    schema_version LowCardinality(String),
    canonical_schema_sha256 String,
    checksum_algorithm LowCardinality(String),
    coverage_policy_json String,
    selection_sha256 String,
    capability_policy_id String,
    capability_policy_sha256 String,
    resource_policy_id String,
    resource_policy_sha256 String,
    adapter_policy_id String,
    adapter_policy_sha256 String,
    acquisition_policy_id String,
    acquisition_policy_sha256 String,
    vendor_semantic_digest String,
    canonical_semantic_digest String,
    prefix_digest String,
    suffix_digest String,
    seam_verified UInt8,
    coverage_verified UInt8,
    dataset_objects_json String,
    receipt_json String,
    verification_time_ms UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(verification_time_ms))
ORDER BY (capture_bundle_id, exchange, trading_pair, window_start_ms, window_end_ms, depth_limit, construction_mode, schema_version, receipt_id)
SETTINGS non_replicated_deduplication_window = 1000000;

-- Final-v1 receipt occurrence identity is distinct from the semantic promotion
-- identity. A receipt is necessary but no longer sufficient for qualification.
-- The latest append-only event controls vendor replay eligibility; provisional
-- historical_vendor_orderbook_v1 receipts cannot enter this table's final-v1
-- qualified path.
CREATE TABLE IF NOT EXISTS market_data.cex_order_book_capture_qualifications
(
    source LowCardinality(String),
    capture_origin LowCardinality(String),
    source_mode LowCardinality(String),
    deployment_id LowCardinality(String),
    qualification_event_id UUID,
    capture_bundle_id String,
    state Enum8('qualified' = 1, 'quarantined' = 2, 'revoked' = 3),
    receipt_id String,
    promotion_identity_sha256 String,
    window_start_ms UInt64,
    window_end_ms UInt64,
    event_at_ms UInt64,
    reason_code LowCardinality(String),
    event_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(event_at_ms))
ORDER BY (capture_bundle_id, event_at_ms, qualification_event_id)
SETTINGS non_replicated_deduplication_window = 1000000;

CREATE TABLE IF NOT EXISTS market_data.cex_order_book_archive_selections
(
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    request_id UUID,
    idempotency_key String,
    selection_sha256 String,
    coverage_class LowCardinality(String),
    receipt_ids Array(String),
    request_json String,
    selection_json String,
    resolved_at_ms UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(resolved_at_ms))
ORDER BY (idempotency_key, resolved_at_ms, selection_sha256)
SETTINGS non_replicated_deduplication_window = 1000000;

-- Deployment automation owns this singleton. The ordinary archive-forwarder
-- allowlist deliberately does not expose it to producers.
CREATE TABLE IF NOT EXISTS market_data.cex_archive_cluster_identity
(
    singleton_key LowCardinality(String),
    environment LowCardinality(String),
    cluster LowCardinality(String),
    configured_at_ms UInt64,
    configuration_sha256 String
)
ENGINE = ReplacingMergeTree(configured_at_ms)
ORDER BY singleton_key;

CREATE OR REPLACE VIEW market_data.cex_order_book_levels_replay_qualified AS
SELECT canonical.*
FROM market_data.cex_order_book_levels_canonical AS canonical
WHERE canonical.source IN ('broker_read', 'broker_write')
UNION ALL
SELECT canonical.*
FROM market_data.cex_order_book_levels_canonical AS canonical
INNER JOIN
(
    SELECT DISTINCT promotion.*
    FROM
    (
        SELECT
            capture_bundle_id AS qualified_capture_bundle_id,
            receipt_id AS qualified_receipt_id,
            promotion_identity_sha256 AS qualified_promotion_identity_sha256,
            state
        FROM market_data.cex_order_book_capture_qualifications
        ORDER BY event_at_ms DESC
        LIMIT 1 BY capture_bundle_id
    ) AS latest_qualification
    INNER JOIN market_data.cex_order_book_capture_promotions AS promotion
      ON latest_qualification.qualified_capture_bundle_id = promotion.capture_bundle_id
     AND latest_qualification.qualified_receipt_id = promotion.receipt_id
     AND latest_qualification.qualified_promotion_identity_sha256 = promotion.promotion_identity_sha256
    WHERE latest_qualification.state = 'qualified'
      AND promotion.source = 'external_backfill'
      AND promotion.capture_origin = 'vendor_historical_backfill'
      AND promotion.source_mode = 'vendor_historical_backfill_v1'
      AND promotion.receipt_schema_version = 'https://schemas.usher.so/market-data-vendor-backfill-promotion-receipt/v1'
      AND promotion.status = 'passing'
      AND promotion.seam_verified = 1
      AND promotion.coverage_verified = 1
      AND promotion.receipt_json != ''
) AS qualification
ON canonical.capture_bundle_id = qualification.capture_bundle_id
AND canonical.exchange = qualification.exchange
AND canonical.trading_pair = qualification.trading_pair
AND canonical.asset_type = qualification.asset_type
AND canonical.feed = qualification.feed
AND canonical.provider = qualification.provider
AND canonical.depth_limit = qualification.depth_limit
AND canonical.construction_mode = qualification.construction_mode
AND canonical.schema_version = qualification.schema_version
AND canonical.checksum_algorithm = qualification.checksum_algorithm
WHERE canonical.source = 'external_backfill'
  AND canonical.source_time_ms >= qualification.window_start_ms
  AND canonical.source_time_ms < qualification.window_end_ms;

CREATE OR REPLACE VIEW market_data.cex_order_book_depth_summary_replay_qualified AS
SELECT canonical.*
FROM market_data.cex_order_book_depth_summary_canonical AS canonical
WHERE canonical.source IN ('broker_read', 'broker_write')
UNION ALL
SELECT canonical.*
FROM market_data.cex_order_book_depth_summary_canonical AS canonical
INNER JOIN
(
    SELECT DISTINCT promotion.*
    FROM
    (
        SELECT
            capture_bundle_id AS qualified_capture_bundle_id,
            receipt_id AS qualified_receipt_id,
            promotion_identity_sha256 AS qualified_promotion_identity_sha256,
            state
        FROM market_data.cex_order_book_capture_qualifications
        ORDER BY event_at_ms DESC
        LIMIT 1 BY capture_bundle_id
    ) AS latest_qualification
    INNER JOIN market_data.cex_order_book_capture_promotions AS promotion
      ON latest_qualification.qualified_capture_bundle_id = promotion.capture_bundle_id
     AND latest_qualification.qualified_receipt_id = promotion.receipt_id
     AND latest_qualification.qualified_promotion_identity_sha256 = promotion.promotion_identity_sha256
    WHERE latest_qualification.state = 'qualified'
      AND promotion.source = 'external_backfill'
      AND promotion.capture_origin = 'vendor_historical_backfill'
      AND promotion.source_mode = 'vendor_historical_backfill_v1'
      AND promotion.receipt_schema_version = 'https://schemas.usher.so/market-data-vendor-backfill-promotion-receipt/v1'
      AND promotion.status = 'passing'
      AND promotion.seam_verified = 1
      AND promotion.coverage_verified = 1
      AND promotion.receipt_json != ''
) AS qualification
ON canonical.capture_bundle_id = qualification.capture_bundle_id
AND canonical.exchange = qualification.exchange
AND canonical.trading_pair = qualification.trading_pair
AND canonical.asset_type = qualification.asset_type
AND canonical.feed = qualification.feed
AND canonical.provider = qualification.provider
AND canonical.depth_limit = qualification.depth_limit
AND canonical.construction_mode = qualification.construction_mode
AND canonical.schema_version = qualification.schema_version
AND canonical.checksum_algorithm = qualification.checksum_algorithm
WHERE canonical.source = 'external_backfill'
  AND canonical.source_time_ms >= qualification.window_start_ms
  AND canonical.source_time_ms < qualification.window_end_ms;

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
ALTER TABLE market_data.cex_order_book_capture_promotions
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.cex_order_book_capture_qualifications
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.cex_order_book_archive_selections
    MODIFY SETTING non_replicated_deduplication_window = 1000000;
ALTER TABLE market_data.cex_ohlcv
    MODIFY SETTING non_replicated_deduplication_window = 1000000;

-- Existing installations were created with an unconditional live-capture TTL.
-- Preserve that policy for broker-origin rows while retaining historical
-- external candidates long enough for verification and later replay.
ALTER TABLE market_data.cex_order_book_levels
    MODIFY TTL toDateTime(fromUnixTimestamp64Milli(source_time_ms)) + INTERVAL 90 DAY
        DELETE WHERE source != 'external_backfill';
ALTER TABLE market_data.cex_order_book_depth_summary
    MODIFY TTL toDateTime(fromUnixTimestamp64Milli(source_time_ms)) + INTERVAL 90 DAY
        DELETE WHERE source != 'external_backfill';

-- Final-v1 origin is derived from immutable producer source so existing rows
-- and their stored checksum values remain untouched.
ALTER TABLE market_data.cex_order_book_levels
    ADD COLUMN IF NOT EXISTS capture_origin LowCardinality(String)
    DEFAULT if(source = 'external_backfill', 'vendor_historical_backfill', 'production_capture')
    AFTER source_mode;
ALTER TABLE market_data.cex_order_book_depth_summary
    ADD COLUMN IF NOT EXISTS capture_origin LowCardinality(String)
    DEFAULT if(source = 'external_backfill', 'vendor_historical_backfill', 'production_capture')
    AFTER source_mode;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS capture_origin LowCardinality(String) DEFAULT '' AFTER source;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS source_mode LowCardinality(String) DEFAULT '' AFTER capture_origin;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS promotion_identity_sha256 String DEFAULT '' AFTER receipt_id;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS canonical_schema_sha256 String DEFAULT '' AFTER schema_version;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS coverage_policy_json String DEFAULT '' AFTER checksum_algorithm;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS selection_sha256 String DEFAULT '' AFTER coverage_policy_json;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS capability_policy_id String DEFAULT '' AFTER selection_sha256;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS capability_policy_sha256 String DEFAULT '' AFTER capability_policy_id;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS resource_policy_id String DEFAULT '' AFTER capability_policy_sha256;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS resource_policy_sha256 String DEFAULT '' AFTER resource_policy_id;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS adapter_policy_id String DEFAULT '' AFTER resource_policy_sha256;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS adapter_policy_sha256 String DEFAULT '' AFTER adapter_policy_id;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS acquisition_policy_id String DEFAULT '' AFTER adapter_policy_sha256;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS acquisition_policy_sha256 String DEFAULT '' AFTER acquisition_policy_id;
ALTER TABLE market_data.cex_order_book_capture_promotions
    ADD COLUMN IF NOT EXISTS receipt_json String DEFAULT '' AFTER dataset_objects_json;
