-- Terminal absence verification. Every result set must be empty or zero before
-- the operator records migration success.

SELECT table, count() AS external_rows
FROM
(
    SELECT 'cex_order_book_levels' AS table, source
    FROM market_data.cex_order_book_levels
    UNION ALL
    SELECT 'cex_order_book_depth_summary' AS table, source
    FROM market_data.cex_order_book_depth_summary
)
WHERE source = 'external_backfill'
GROUP BY table
HAVING external_rows != 0;

SELECT name, engine_full
FROM system.tables
WHERE database = 'market_data'
  AND name IN
  (
      'cex_order_book_capture_promotions',
      'cex_order_book_capture_qualifications',
      'cex_order_book_archive_selections',
      'cex_archive_cluster_identity',
      'cex_order_book_levels_replay_qualified',
      'cex_order_book_depth_summary_replay_qualified'
  )
ORDER BY name;

SELECT table, name
FROM system.columns
WHERE database = 'market_data'
  AND table IN ('cex_order_book_levels', 'cex_order_book_depth_summary')
  AND name = 'capture_origin'
ORDER BY table;

SELECT table, mutation_id, command, latest_fail_reason
FROM system.mutations
WHERE database = 'market_data'
  AND table IN ('cex_order_book_levels', 'cex_order_book_depth_summary')
  AND is_done = 0
ORDER BY table, create_time, mutation_id;

SELECT name, engine_full
FROM system.tables
WHERE database = 'market_data'
  AND name IN ('cex_order_book_levels', 'cex_order_book_depth_summary')
  AND
  (
      positionCaseInsensitive(engine_full, 'INTERVAL 90 DAY') = 0
      OR positionCaseInsensitive(engine_full, 'DELETE WHERE') != 0
  )
ORDER BY name;
