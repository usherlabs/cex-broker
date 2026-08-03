-- Operator-run migration template. This file is intentionally not part of
-- automatic schema startup: every phase has an observation/approval boundary.
-- No phase drops a legacy or canonical table.

-- PHASE 1: apply schema/clickhouse/market_data.sql, then deploy:
--   CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE=dual
-- This dual-writes orderbook_snapshots + canonical levels/summary and
-- candles + cex_ohlcv. Keep the legacy consumer unchanged.

-- PHASE 2: backfill one bounded source-time partition at a time with
-- scripts/backfill-canonical-market-data.ts. Re-running a window is safe:
-- append-only order-book duplicates collapse in canonical views when their
-- checksums agree, and cex_ohlcv uses ReplacingMergeTree(broker_version).
-- Backfill rows use source_mode=legacy_migration_v1,
-- provenance_complete=0, and NULL bundle/raw identity/raw checksum.

-- PHASE 3: parity checks. Zero mismatches are required for the agreed soak.
SELECT
    legacy.exchange,
    replaceAll(legacy.symbol, '/', '-') AS trading_pair,
    legacy.event_time_ms,
    count() AS legacy_rows,
    countIf(canonical.snapshot_id != '') AS canonical_rows,
    countIf(
        legacy.best_bid != canonical.best_bid OR
        legacy.best_ask != canonical.best_ask OR
        legacy.bid_levels != canonical.bid_level_count OR
        legacy.ask_levels != canonical.ask_level_count
    ) AS value_mismatches
FROM market_data.orderbook_snapshots AS legacy
LEFT JOIN market_data.cex_order_book_depth_summary_canonical AS canonical
  ON canonical.exchange = legacy.exchange
 AND canonical.trading_pair = replaceAll(legacy.symbol, '/', '-')
 AND canonical.source_time_ms = legacy.event_time_ms
 AND canonical.source_mode = 'legacy_migration_v1'
WHERE legacy.event_time_ms >= {start_time_ms:UInt64}
  AND legacy.event_time_ms < {end_time_ms:UInt64}
GROUP BY legacy.exchange, trading_pair, legacy.event_time_ms
HAVING canonical_rows != legacy_rows OR value_mismatches != 0;

SELECT
    legacy.exchange,
    replaceAll(legacy.symbol, '/', '-') AS trading_pair,
    legacy.timeframe,
    legacy.open_time_ms,
    countIf(
        legacy.open != canonical.open OR
        legacy.high != canonical.high OR
        legacy.low != canonical.low OR
        legacy.close != canonical.close OR
        legacy.volume != canonical.volume OR
        legacy.is_closed != canonical.is_closed OR
        legacy.broker_version != canonical.broker_version
    ) AS value_mismatches
FROM market_data.candles FINAL AS legacy
LEFT JOIN market_data.cex_ohlcv FINAL AS canonical
  ON canonical.exchange = legacy.exchange
 AND canonical.trading_pair = replaceAll(legacy.symbol, '/', '-')
 AND canonical.timeframe = legacy.timeframe
 AND canonical.open_time_ms = legacy.open_time_ms
 AND canonical.source_mode = 'legacy_migration_v1'
WHERE legacy.open_time_ms >= {start_time_ms:UInt64}
  AND legacy.open_time_ms < {end_time_ms:UInt64}
GROUP BY legacy.exchange, trading_pair, legacy.timeframe, legacy.open_time_ms
HAVING value_mismatches != 0;

-- PHASE 4: validate schema/clickhouse/canonical_market_data_replay.sql for every
-- configured pair/bundle/window, then switch consumers to canonical names.

-- PHASE 5: after the retention-period approval, stop the producer dual-write:
--   CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE=canonical
-- The following optional compatibility cutover preserves the old query names.
-- Execute as a reviewed maintenance operation, not during service startup.
--
-- RENAME TABLE
--   market_data.orderbook_snapshots TO market_data.orderbook_snapshots_legacy,
--   market_data.candles TO market_data.candles_legacy,
--   market_data.candles_closed TO market_data.candles_closed_legacy;
--
-- CREATE VIEW market_data.orderbook_snapshots AS
-- SELECT
--   any(summary.source) AS source,
--   any(summary.deployment_id) AS deployment_id,
--   '' AS account_selector,
--   summary.exchange,
--   any(summary.asset_type) AS asset_type,
--   any(summary.source_symbol) AS symbol,
--   summary.source_time_ms AS event_time_ms,
--   any(summary.received_time_ms) AS received_time_ms,
--   any(summary.best_bid) AS best_bid,
--   any(summary.best_ask) AS best_ask,
--   any(summary.best_bid_amount) AS bid_size,
--   any(summary.best_ask_amount) AS ask_size,
--   any(summary.mid_price) AS mid,
--   any(summary.spread_bps) AS spread_bps,
--   any(summary.depth_limit) AS depth_limit,
--   any(summary.bid_level_count) AS bid_levels,
--   any(summary.ask_level_count) AS ask_levels,
--   arrayMap(x -> x.2, arraySort(x -> x.1, groupArrayIf((level.level_index, level.price), level.side = 'bid'))) AS bids_price,
--   arrayMap(x -> x.2, arraySort(x -> x.1, groupArrayIf((level.level_index, level.amount), level.side = 'bid'))) AS bids_size,
--   arrayMap(x -> x.2, arraySort(x -> x.1, groupArrayIf((level.level_index, level.price), level.side = 'ask'))) AS asks_price,
--   arrayMap(x -> x.2, arraySort(x -> x.1, groupArrayIf((level.level_index, level.amount), level.side = 'ask'))) AS asks_size,
--   any(summary.sequence) AS sequence
-- FROM market_data.cex_order_book_depth_summary_canonical AS summary
-- INNER JOIN market_data.cex_order_book_levels_canonical AS level USING
--   (capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id, schema_version)
-- GROUP BY summary.exchange, summary.trading_pair, summary.source_time_ms, summary.snapshot_id;
--
-- CREATE VIEW market_data.candles AS
-- SELECT
--   source, deployment_id, '' AS account_selector, exchange, asset_type,
--   source_symbol AS symbol, timeframe, open_time_ms, open, high, low, close,
--   volume, quote_volume, is_closed, broker_version
-- FROM market_data.cex_ohlcv FINAL;
--
-- CREATE VIEW market_data.candles_closed AS
-- SELECT * FROM market_data.candles WHERE is_closed = 1;

-- ROLLBACK: first restore CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE=legacy (or dual).
-- If compatibility names were switched, rename—not drop—the canonical views,
-- then restore the retained legacy objects:
--
-- RENAME TABLE
--   market_data.orderbook_snapshots TO market_data.orderbook_snapshots_canonical_compat,
--   market_data.candles TO market_data.candles_canonical_compat,
--   market_data.candles_closed TO market_data.candles_closed_canonical_compat,
--   market_data.orderbook_snapshots_legacy TO market_data.orderbook_snapshots,
--   market_data.candles_legacy TO market_data.candles,
--   market_data.candles_closed_legacy TO market_data.candles_closed;
-- Canonical base tables and all affected capture bundles remain intact.
