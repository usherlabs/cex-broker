-- Canonical replay-window contract.
--
-- Run the two conflict preflight queries first. A replay orchestrator MUST fail
-- the selected bundle when either query returns a row; it must not consume a
-- partially conflicted bundle. Query parameters use ClickHouse HTTP-client
-- syntax and deliberately constrain bundle, venue, pair, and source-time range.

SELECT
    'levels' AS conflict_table,
    capture_bundle_id,
    exchange,
    trading_pair,
    snapshot_id,
    side,
    level_index,
    distinct_checksums
FROM market_data.cex_order_book_levels_conflicts
WHERE capture_bundle_id IN ({capture_bundle_ids:Array(String)})
  AND exchange = {exchange:String}
  AND trading_pair = {trading_pair:String}
  AND snapshot_id IN
  (
      SELECT snapshot_id
      FROM market_data.cex_order_book_depth_summary
      WHERE capture_bundle_id IN ({capture_bundle_ids:Array(String)})
        AND exchange = {exchange:String}
        AND trading_pair = {trading_pair:String}
        AND source_time_ms >= {start_time_ms:UInt64}
        AND source_time_ms < {end_time_ms:UInt64}
  );

SELECT
    'summary' AS conflict_table,
    capture_bundle_id,
    exchange,
    trading_pair,
    snapshot_id,
    distinct_checksums
FROM market_data.cex_order_book_depth_summary_conflicts
WHERE capture_bundle_id IN ({capture_bundle_ids:Array(String)})
  AND exchange = {exchange:String}
  AND trading_pair = {trading_pair:String}
  AND snapshot_id IN
  (
      SELECT snapshot_id
      FROM market_data.cex_order_book_depth_summary
      WHERE capture_bundle_id IN ({capture_bundle_ids:Array(String)})
        AND exchange = {exchange:String}
        AND trading_pair = {trading_pair:String}
        AND source_time_ms >= {start_time_ms:UInt64}
        AND source_time_ms < {end_time_ms:UInt64}
  );

-- Replay levels. Only checksum-consistent logical rows are exposed here.
SELECT *
FROM market_data.cex_order_book_levels_canonical
WHERE capture_bundle_id IN ({capture_bundle_ids:Array(String)})
  AND exchange = {exchange:String}
  AND trading_pair = {trading_pair:String}
  AND feed = 'ORDERBOOK'
  AND source_time_ms >= {start_time_ms:UInt64}
  AND source_time_ms < {end_time_ms:UInt64}
ORDER BY source_time_ms, snapshot_id, side, level_index;

-- Replay summaries.
SELECT *
FROM market_data.cex_order_book_depth_summary_canonical
WHERE capture_bundle_id IN ({capture_bundle_ids:Array(String)})
  AND exchange = {exchange:String}
  AND trading_pair = {trading_pair:String}
  AND feed = 'ORDERBOOK'
  AND source_time_ms >= {start_time_ms:UInt64}
  AND source_time_ms < {end_time_ms:UInt64}
ORDER BY source_time_ms, snapshot_id;

-- Replay OHLCV using replacement semantics for forming/closed updates.
SELECT *
FROM market_data.cex_ohlcv FINAL
WHERE capture_bundle_id IN ({capture_bundle_ids:Array(String)})
  AND exchange = {exchange:String}
  AND trading_pair = {trading_pair:String}
  AND feed = 'OHLCV'
  AND source_time_ms >= {start_time_ms:UInt64}
  AND source_time_ms < {end_time_ms:UInt64}
ORDER BY source_time_ms, timeframe;
