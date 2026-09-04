-- Read-only inventory for the terminal CEX order-book historical-schema
-- retirement. Run and preserve this output before backup or destructive work.
-- This file intentionally contains SELECT statements only.

SELECT
    table,
    countIf(source = 'external_backfill') AS external_rows,
    count() AS physical_rows
FROM
(
    SELECT 'cex_order_book_levels' AS table, source
    FROM market_data.cex_order_book_levels
    UNION ALL
    SELECT 'cex_order_book_depth_summary' AS table, source
    FROM market_data.cex_order_book_depth_summary
)
GROUP BY table
ORDER BY table;

SELECT
    name,
    engine,
    engine_full,
    metadata_modification_time
FROM system.tables
WHERE database = 'market_data'
  AND name IN
  (
      'cex_order_book_levels',
      'cex_order_book_depth_summary',
      'cex_order_book_capture_promotions',
      'cex_order_book_capture_qualifications',
      'cex_order_book_archive_selections',
      'cex_archive_cluster_identity',
      'cex_order_book_levels_replay_qualified',
      'cex_order_book_depth_summary_replay_qualified'
  )
ORDER BY name;

SELECT
    table,
    name,
    type,
    default_kind,
    default_expression
FROM system.columns
WHERE database = 'market_data'
  AND table IN ('cex_order_book_levels', 'cex_order_book_depth_summary')
  AND name = 'capture_origin'
ORDER BY table;

SELECT
    table,
    mutation_id,
    command,
    create_time,
    is_done,
    latest_fail_reason
FROM system.mutations
WHERE database = 'market_data'
  AND table IN ('cex_order_book_levels', 'cex_order_book_depth_summary')
ORDER BY table, create_time, mutation_id;
