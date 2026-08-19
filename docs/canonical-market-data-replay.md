# Canonical CEX market-data replay archive

This is the deployment and operations contract for the CEX-broker portions of FIET-901 and FIET-903. FIET-903's broker RPC/capability/current-snapshot/live-stream sub-scope was completed by `cex-broker-order-book-depth-sourcing`; this change adds capture, storage, migration, and replay integrity. It does not add or gate RPCs.

## Deployment identity and credential precedence

TEE and non-TEE deployments run the same broker binary and register the full `ExecuteAction` and `Subscribe` service. Archive role does not reduce that service surface.

Set the deployment-owned archive identity:

```env
CEX_BROKER_ARCHIVE_ENABLED=true
CEX_BROKER_ARCHIVE_SOURCE=broker_read
CEX_BROKER_DEPLOYMENT_ID=market-reader-eu-1
CEX_BROKER_CAPTURE_BUNDLE_ID=cex-2026-08-03-eu-1
CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT=production
CEX_BROKER_ARCHIVE_FORWARDER_URL=http://archive-forwarder:8090/archive
CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH=/var/lib/cex-broker/archive-loss.jsonl
```

`CEX_BROKER_ARCHIVE_SOURCE` is closed to `broker_read|broker_write` and defaults to `broker_write` for existing deployments. The writer stamps this immutable value into envelopes, rows, and loss records. It is never inferred from API-key presence. FIET-901 deployment verification requires the separately deployed broker to use `broker_read`, an explicit deployment ID, and a non-empty deployment-owned capture bundle before continuous capture is declared ready; the core broker does not infer that role or gate its RPC service. If archival is absent or disabled, archive work is a no-op. If an enabled writer lacks complete production market provenance, canonical market archival is skipped with a bounded warning while broker RPCs and stream delivery continue. Development capture explicitly uses `CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT=development` and generates a `development:<deployment>` bundle when none is supplied.

Credential resolution uses the broker's established fixed precedence and requires no archive-specific credential configuration:

1. Use a matching broker account loaded from `.env`/deployment configuration.
2. If no matching environment broker exists, use a complete request `api-key` and `api-secret` pair.
3. If neither source exists, construct a credentialless exchange only for operations that already support public access.

When environment and request credentials are both present, the environment-loaded broker wins. The broker does not classify keys as public, read-only, or write-capable and does not introduce credential-source or permission-attestation settings. For a non-TEE reader, ensure every credential that deployment or its trusted callers may supply has exchange-side trading and withdrawal permissions disabled. Those exchange permissions—not archive source or credential location—establish effective privilege.

## Four-feed collector

The collector is an independent keep-alive client of a separately deployed full broker. Set its broker target and point its canonical configuration at a JSON document containing only feed intent:

```env
CEX_BROKER_URL=cex-broker.internal:8086
CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG=/etc/cex-broker/market-data-subscriptions.json
```

```json
{
  "subscriptions": [
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "ORDERBOOK", "depthLimit": 50 },
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "TICKER" },
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "TRADES" },
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "OHLCV", "timeframe": "1m", "bootstrapLimit": 100 }
  ]
}
```

Run it with `bun run start-market-data-collector`. The collector starts no loopback broker, loads no CEX credentials, sends no API-key metadata, owns no archive writer, and does not connect to ClickHouse. The remote broker resolves its environment-first credentials and, when eligible archival is configured, attaches the production environment, deployment, capture bundle, source, and integrity provenance configured in the preceding section. Collector JSON containing `environment`, `captureBundleId`, or other archive identity is rejected.

Each entry has an independent reconnect supervisor and health state. OHLCV retains bootstrap/catch-up and stamps `broker_bootstrap_fetch_v1` separately from live capture. ORDERBOOK, TICKER, and TRADES record unrecoverable gaps after reconnect rather than synthesize missing events.

The collector is the coverage/liveness subscriber, not the owner of a duplicate-prevention rule. A broker runtime owns canonical public workers and archives an accepted physical observation once before fanout. ORDERBOOK depth is first resolved to a venue acquisition profile and then projected per subscriber. Binance/MEXC 500-level profiles are candidates only: the production enabled-profile set is empty, controlled verification enables them explicitly, and evidence artifacts cannot toggle runtime behavior. Replay intended for Maker must configure archive depth at least to the policy depth (100 in the FIET-1014 gate) and still prove that retained bid/ask boundaries cross every required price band; the ordinary depth 25 is not sufficient merely because rows exist.

An external CCXT or Hummingbot fallback is an optional out-of-band producer of the shared capture contract, not a broker-collector implementation. It must declare its provider, versioned fallback source mode, reason, configured exchange, and configured pair. Cross-venue or cross-pair substitution is rejected.

## Capture and integrity contract

All canonical rows carry source, deployment, capture bundle, exchange, trading pair/source symbol, provider, feed, source mode, source/received timestamps, raw capture ID/scope, schema version, checksum algorithm, raw checksum, normalized checksum, and provenance completeness. The current versions are:

- schema: `1.0.0`
- checksum: `sha256-canonical-json-v1`
- construction: sampled top-N snapshots for live/current broker order books

Raw payloads are redacted before identity/checksum calculation. Canonical JSON sorts object keys, uses finite plain-decimal numbers, normalizes negative zero, omits undefined object values, and excludes checksum fields from their own projections. The TypeScript fixture is `test/fixtures/canonical-market-capture-v1.json`; `research/hummingbot/canonical_capture_fixture.py` is the matching Maker-side verifier.

Exact L2 is future-facing and non-blocking for this delivery. The broker reports it unsupported and never silently labels sampled evidence exact. A future exact producer must supply complete continuity proof.

## ClickHouse and replay

Canonical storage is:

- `market_data.cex_stream_events` for the redacted raw ledger
- `market_data.cex_ticker_events`, `market_data.cex_trades`, and `market_data.cex_ohlcv`
- append-only `market_data.cex_order_book_levels` and `market_data.cex_order_book_depth_summary`

`cex_ohlcv` uses `ReplacingMergeTree(broker_version)`; `cex_ohlcv_closed` applies `FINAL` and closed-bar semantics. Order-book physical duplicates remain auditable. The `_canonical` views expose one checksum-consistent logical row, while `_conflicts` expose keys with multiple checksums. Same-batch conflicts are rejected by the forwarder; cross-batch conflicts remain stored and must block the affected replay bundle.

Use `schema/clickhouse/canonical_market_data_replay.sql` for bounded bundle/exchange/pair/source-time replay. Its conflict preflights must return no rows before consuming the canonical views.

The retained FIET-907 reference exporter materializes a conflict-free order-book window directly from ClickHouse to Maker-compatible Parquet files:

```bash
CEX_BROKER_REPLAY_EXPORT_DIRECTORY=/tmp/maker-capture \
CEX_BROKER_REPLAY_CAPTURE_BUNDLE_IDS=cex-2026-08-03-eu-1 \
CEX_BROKER_REPLAY_EXCHANGE=binance \
CEX_BROKER_REPLAY_TRADING_PAIR=BTC-USDT \
CEX_BROKER_REPLAY_START_TIME_MS=1785715200000 \
CEX_BROKER_REPLAY_END_TIME_MS=1785801600000 \
bun scripts/export-canonical-orderbook-parquet.ts

uv run --project research/python --extra dev \
  python research/hummingbot/order_book_parquet_fixture.py \
  /tmp/maker-capture/order_book_levels.parquet \
  /tmp/maker-capture/order_book_depth_summary.parquet
```

The exporter refuses to overwrite existing files or export a selected window with an order-book checksum conflict. The Python verifier checks capture-core field presence and recomputes every normalized-row checksum from the Parquet values. Neither tool calls the broker or an exchange. Fixture materialization, coverage reports, and replay-bundle assembly are owned by [FIET-907](https://linear.app/usherlabs/issue/FIET-907/clickhouse-backtest-fixture-materializers-and-coveragereplay-bundles), not by the live capture runtime.

For complete strategy-pair validation, point `CEX_BROKER_REPLAY_VALIDATION_CONFIG` at a JSON document whose `windows` array contains `captureBundleIds`, `exchange`, `tradingPair`, `startTimeMs`, and `endTimeMs`, then run `bun scripts/validate-canonical-market-replay.ts`. Every configured window must contain raw and normalized ORDERBOOK, TICKER, TRADES, and OHLCV evidence; any missing feed or checksum conflict fails validation.

## Migration, cutover, rollback, and deployment observation

The upgraded broker always writes the latest canonical schema. There is no runtime legacy/dual/canonical write setting. Upgrading an existing legacy deployment therefore requires the ClickHouse table migration before the new broker version is deployed.

Follow `schema/clickhouse/migrations/canonical_market_data_replay_cutover.sql` phase by phase: apply canonical DDL, quiesce legacy writers, migrate every retained bounded window, validate parity, switch consumers, and only then deploy the canonical-only broker.

```bash
CEX_BROKER_MIGRATION_START_TIME_MS=1700000000000 \
CEX_BROKER_MIGRATION_END_TIME_MS=1700086400000 \
bun run scripts/migrate-legacy-market-data-to-canonical.ts

# Repeat after reviewing dry-run counts:
CEX_BROKER_CANONICAL_MIGRATION_CONFIRM=true \
CEX_BROKER_MIGRATION_START_TIME_MS=1700000000000 \
CEX_BROKER_MIGRATION_END_TIME_MS=1700086400000 \
bun run scripts/migrate-legacy-market-data-to-canonical.ts
```

The script reads `market_data.orderbook_snapshots` and `market_data.candles` directly from ClickHouse and writes their canonical equivalents. It never reads fixture files and never calls a broker or exchange. Legacy migration stamps `legacy_migration_v1` and `provenance_complete=0`; unavailable bundle/raw ID/raw scope/raw checksum remain `NULL`. Reruns preserve identical logical checksums: order-book canonical views collapse agreeing physical deliveries and OHLCV replacement semantics select the recorded broker version.

Before cutover, run the parity and replay queries for every configured pair/window and complete the FIET-937 production observation window. Record feed health, last-frame age, reconnects, unrecoverable gaps, received/archived/invalid/sampled rows, queue saturation, journaled rows, checksum conflicts, parity mismatches, and Maker replay consumption. Any unaccounted row, conflict, parity mismatch, stale feed, or persistent journal growth blocks deployment cutover. This operational gate is not an implementation-completion requirement for the archived OpenSpec change and repository checks do not claim that it has occurred.

Rollback stops the upgraded broker, restores retained legacy names if necessary, and rolls back to the previous legacy-writing application version. The runbook uses renames rather than drops; canonical and legacy base data remain recoverable throughout the retention period.
