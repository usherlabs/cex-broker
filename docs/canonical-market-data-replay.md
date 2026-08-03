# Canonical CEX market-data replay archive

This is the deployment and operations contract for the CEX-broker portions of FIET-901 and FIET-903. FIET-903's broker RPC/capability/current-snapshot/live-stream sub-scope was completed by `cex-broker-order-book-depth-sourcing`; this change adds capture, storage, migration, and replay integrity. It does not add or gate RPCs.

## Deployment identity and credentials

TEE and non-TEE deployments run the same broker binary and register the full `ExecuteAction` and `Subscribe` service. The archive role and credential policy never reduce that service surface.

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

`CEX_BROKER_ARCHIVE_SOURCE` is closed to `broker_read|broker_write` and defaults to `broker_write` for existing deployments. The writer stamps this immutable value into envelopes, rows, and loss records. It is never inferred from API-key presence. Production FIET-901 collector startup requires `broker_read` and a non-empty deployment-owned capture bundle. Development capture explicitly uses `CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT=development` and generates a `development:<deployment>` bundle when none is supplied.

Credential source is separately configured:

```env
CEX_BROKER_CREDENTIAL_SOURCE_POLICY=provisioned_only
CEX_BROKER_PROVISIONED_CREDENTIAL_PROFILE=read_only_key
```

The policy values are `provisioned_only|request_metadata_allowed`; the compatibility default is `request_metadata_allowed`. Profiles are `public|read_only_key`. Under `provisioned_only`, request `api-key` or `api-secret` metadata is rejected with gRPC `PERMISSION_DENIED` before broker construction and only a bounded rejection metric is emitted. A missing `read_only_key` broker fails closed and never becomes a public broker. The `public` profile is limited to typed public market-data operations.

For a non-TEE reader, provision exchange credentials with read-only permissions and disabled trading/withdrawal permissions. That exchange-side permission is the write-operation control; the broker does not expose `readEnabled`/`writeEnabled` gates. Validate the posture non-destructively by checking the provisioned profile, confirming metadata rejection, calling capability/current-snapshot/subscription reads, and reviewing the exchange's API-key permission page or read-only permission endpoint. Do not place an order or move an asset as a validation step.

For `read_only_key`, record how the exchange permission was verified:

```env
CEX_BROKER_CREDENTIAL_ATTESTATION_KIND=operator_provisioning_record
CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE=vault-policy/read-broker-2026-08-03
```

The attestation kind is `exchange_permission_api|operator_provisioning_record`; its reference must identify the permission response or provisioning record without containing a secret. Run `bun scripts/check-read-only-deployment.ts` as the non-destructive configuration preflight. A `public` profile produces the built-in `public_no_credentials` attestation. The check explicitly permits only capability, snapshot, and subscription reads and never calls an exchange write operation.

## Four-feed collector

Point `CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG` at a JSON document:

```json
{
  "environment": "production",
  "captureBundleId": "cex-2026-08-03-eu-1",
  "subscriptions": [
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "ORDERBOOK", "depthLimit": 50 },
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "TICKER" },
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "TRADES" },
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "OHLCV", "timeframe": "1m", "bootstrapLimit": 100 }
  ]
}
```

Each entry has an independent reconnect supervisor and health state. OHLCV retains bootstrap/catch-up and stamps `broker_bootstrap_fetch_v1` separately from live capture. ORDERBOOK, TICKER, and TRADES record unrecoverable gaps after reconnect rather than synthesize missing events.

During migration, `CEX_BROKER_OHLCV_COLLECTOR_CONFIG` remains supported as an OHLCV-only array. Move those entries into the new document and add `feed: "OHLCV"`, a production bundle, and environment. The existing service command/image remains the wrapper for both formats.

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

Export a conflict-free order-book window directly to Maker-compatible Parquet files:

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

The exporter refuses to overwrite existing files or export a selected window with an order-book checksum conflict. The Python verifier checks capture-core field presence and recomputes every normalized-row checksum from the Parquet values.

For complete strategy-pair validation, point `CEX_BROKER_REPLAY_VALIDATION_CONFIG` at a JSON document whose `windows` array contains `captureBundleIds`, `exchange`, `tradingPair`, `startTimeMs`, and `endTimeMs`, then run `bun scripts/validate-canonical-market-replay.ts`. Every configured window must contain raw and normalized ORDERBOOK, TICKER, TRADES, and OHLCV evidence; any missing feed or checksum conflict fails validation.

## Migration, cutover, rollback, and soak

`CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE=legacy|dual|canonical` controls new writes and defaults to `dual` during this migration. The same phase covers both `orderbook_snapshots → levels/summary` and `candles → cex_ohlcv`.

Follow `schema/clickhouse/migrations/canonical_market_data_replay_cutover.sql` phase by phase. Backfill only bounded windows:

```bash
CEX_BROKER_BACKFILL_START_TIME_MS=1700000000000 \
CEX_BROKER_BACKFILL_END_TIME_MS=1700086400000 \
bun run scripts/backfill-canonical-market-data.ts

# Repeat after reviewing dry-run counts:
CEX_BROKER_CANONICAL_BACKFILL_CONFIRM=true \
CEX_BROKER_BACKFILL_START_TIME_MS=1700000000000 \
CEX_BROKER_BACKFILL_END_TIME_MS=1700086400000 \
bun run scripts/backfill-canonical-market-data.ts
```

Legacy backfill stamps `legacy_migration_v1` and `provenance_complete=0`; unavailable bundle/raw ID/raw scope/raw checksum remain `NULL`. Reruns preserve identical logical checksums: order-book canonical views collapse agreeing physical deliveries and OHLCV replacement semantics select the recorded broker version.

Before cutover, run the parity and replay queries for every configured pair/window and complete an agreed production-like soak. Record feed health, last-frame age, reconnects, unrecoverable gaps, received/archived/invalid/sampled rows, queue saturation, journaled rows, checksum conflicts, parity mismatches, and Maker replay consumption. Any unaccounted row, conflict, parity mismatch, stale feed, or persistent journal growth blocks cutover.

Rollback sets write mode back to `legacy` or `dual`, restores the retained legacy names, and identifies affected capture bundles. The runbook uses renames rather than drops; canonical and legacy base data remain recoverable throughout the retention period.
