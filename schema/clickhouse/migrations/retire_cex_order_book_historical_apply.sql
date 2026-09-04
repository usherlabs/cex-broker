-- DESTRUCTIVE TERMINAL MIGRATION. NEVER EXECUTED BY NORMAL STARTUP.
-- Preconditions are operator-owned: historical writers stopped, broker-only
-- source rejection deployed, backup/export recorded, maintenance approval
-- granted, and the inventory output reviewed.

ALTER TABLE market_data.cex_order_book_levels
    DELETE WHERE source = 'external_backfill';
ALTER TABLE market_data.cex_order_book_depth_summary
    DELETE WHERE source = 'external_backfill';

-- The operator MUST wait until the two mutations above report is_done = 1 and
-- latest_fail_reason is empty before running the statements below.
ALTER TABLE market_data.cex_order_book_levels
    MODIFY TTL toDateTime(fromUnixTimestamp64Milli(source_time_ms)) + INTERVAL 90 DAY;
ALTER TABLE market_data.cex_order_book_depth_summary
    MODIFY TTL toDateTime(fromUnixTimestamp64Milli(source_time_ms)) + INTERVAL 90 DAY;

DROP VIEW IF EXISTS market_data.cex_order_book_levels_replay_qualified;
DROP VIEW IF EXISTS market_data.cex_order_book_depth_summary_replay_qualified;
DROP TABLE IF EXISTS market_data.cex_order_book_capture_promotions;
DROP TABLE IF EXISTS market_data.cex_order_book_capture_qualifications;
DROP TABLE IF EXISTS market_data.cex_order_book_archive_selections;
DROP TABLE IF EXISTS market_data.cex_archive_cluster_identity;

ALTER TABLE market_data.cex_order_book_levels
    DROP COLUMN IF EXISTS capture_origin;
ALTER TABLE market_data.cex_order_book_depth_summary
    DROP COLUMN IF EXISTS capture_origin;
