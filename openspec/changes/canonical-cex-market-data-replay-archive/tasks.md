## 1. Capture Contract And Golden Fixtures

- [x] 1.1 Define the versioned capture-core field registry, including source, deployment, capture bundle, market identity, provider, source mode, timestamps, raw identity/scope, schema version, and integrity fields.
- [x] 1.2 Define and test the closed archive-source, feed, source-mode, construction-mode, and gap-policy registries, including explicit legacy migration values.
- [x] 1.3 Define the canonical timestamp and numeric representation used by raw and normalized checksum projections.
- [x] 1.4 Add a deterministic canonical serialization and SHA-256 helper with unit tests for key ordering, numeric edge cases, timestamp normalization, omitted mutable fields, and checksum self-exclusion.
- [x] 1.5 Add redacted raw-capture identity/checksum helpers that distinguish CCXT-normalized objects from exchange wire frames.
- [x] 1.6 Add versioned TypeScript golden fixtures covering stream, ticker, trade, OHLCV, order-book level, and order-book summary rows with expected identities and checksums.
- [x] 1.7 Add or coordinate the matching Python/Maker fixture verifier and prove it reproduces every capture-core checksum.

## 2. Archive Source And Credential Resolution

- [x] 2.1 Add `broker_read` and `broker_write` archive source types and deployment configuration, retaining `broker_write` as the compatibility default for existing deployments.
- [x] 2.2 Refactor common archive tags to accept the immutable writer/deployment source instead of importing a write-only constant.
- [x] 2.3 Make archive HTTP envelopes and loss-journal records use the configured writer source and add tests for both source values.
- [x] 2.4 Validate envelope/row source consistency in the archive forwarder and add bounded error/metric tests for mismatches.
- [x] 2.5 Preserve the fixed credential resolution order: matching environment-loaded broker first, complete request metadata only when no environment broker exists, and credentialless public construction last for operations that already support it.
- [x] 2.6 Add handler regression tests proving environment-loaded credentials cannot be replaced by request credentials and credentials are never logged or archived.
- [x] 2.7 Remove archive-specific credential profiles, credential-source policy, and permission-attestation configuration; document that selected exchange-key permissions establish effective privilege.
- [x] 2.8 Add regression coverage proving TEE/non-TEE and archive source do not change registered RPCs or action handlers.

## 3. Capture Context And Stream Ledger

- [x] 3.1 Introduce a shared market-capture context in helpers and thread it through handlers without adding domain logic to `src/server.ts`.
- [x] 3.2 Require and validate a deployment/collector-owned `capture_bundle_id` for production capture while preserving an explicit development-only configuration path.
- [x] 3.3 Resolve and record actual provider identity and versioned source mode for broker live, current snapshot, and OHLCV bootstrap inputs.
- [x] 3.4 Extend `cex_stream_events` row construction with capture-core provenance, redacted payload metadata, raw identity/scope, checksum algorithm/version, and raw checksum.
- [x] 3.5 Archive raw ledger entries for ORDERBOOK, TICKER, TRADES, and OHLCV frames and link every normalized row to the corresponding raw capture.
- [x] 3.6 Add tests proving capture source, deployment, bundle, and provider provenance cannot be overridden by provider payload or untrusted request fields.
- [x] 3.7 Validate exchange/pair, provider, source mode, and fallback reason when an external fallback producer is admitted, without implementing direct CCXT or Hummingbot fallback inside the broker collector.

## 4. Canonical ClickHouse Schemas

- [x] 4.1 Add append-only `MergeTree` DDL for `market_data.cex_order_book_levels` with capture-core, evidence, level, checksum, partitioning, retention, and the documented logical key in its ordering strategy.
- [x] 4.2 Add append-only `MergeTree` DDL for `market_data.cex_order_book_depth_summary` with capture-core, evidence, summary, checksum, partitioning, retention, and the documented logical key in its ordering strategy.
- [x] 4.3 Add `cex_order_book_levels_canonical` and `cex_order_book_depth_summary_canonical` dedup views plus conflict views that preserve physical duplicates, exclude conflicting logical keys, and expose distinct checksums.
- [x] 4.4 Add `market_data.cex_ohlcv` as `ReplacingMergeTree(broker_version)` with canonical provenance, integrity, timeframe, bar values, deterministic keys, and a `FINAL` closed-candle compatibility view.
- [x] 4.5 Add capture-core and raw-link fields to `cex_stream_events`, `cex_ticker_events`, and `cex_trades` using backward-compatible schema migration statements.
- [x] 4.6 Extend broker archive table types, market-table guards, archive-forwarder allowlists, and per-table limits for all canonical tables.
- [x] 4.7 Add ClickHouse schema-application and insert integration tests for canonical tables, canonical/conflict views, and nullable legacy provenance cases.
- [x] 4.8 Reject same-batch order-book logical-key/checksum conflicts in the archive forwarder and verify producer retry/loss-journal accounting.
- [x] 4.9 Add canonical replay-window queries that use deduplicated views, filter by capture bundle/exchange/pair/feed/source time, and fail affected bundles when conflict views are non-empty.

## 5. Canonical Market Row Builders

- [x] 5.1 Upgrade ticker, trade, and raw stream builders to emit capture-core fields and deterministic normalized-row checksums.
- [x] 5.2 Replace canonical candle output with a `cex_ohlcv` row builder while retaining migration-only legacy candle parsing.
- [x] 5.3 Add OHLCV tests for bootstrap versus live source modes, forming/closed bar replacement semantics, raw linkage, and checksums.
- [x] 5.4 Implement deterministic order-book validation that rejects the entire snapshot for missing sides, non-positive/non-finite values, non-monotonic side ordering, crossed/locked books, invalid timestamps, or invalid depth without silently reordering levels.
- [x] 5.5 Implement deterministic snapshot identity plus one-row-per-level output with side, level index, price, amount, notional, mid-price, spread, sequence, and checksums.
- [x] 5.6 Implement one-row-per-snapshot depth summaries with best bid/ask, spread, staleness, counts, deterministic measurement bands, band depth, and checksum.
- [x] 5.7 Add order-book tests for invalid evidence, depth truncation, measurement bands, idempotent identities, raw linkage, and TypeScript/Maker fixture parity.
- [x] 5.8 Enforce sampled top-N classification for current live captures and test that exact L2 cannot be emitted without complete continuity proof.
- [x] 5.9 Preserve typed historical/exact unsupported behavior and add regression tests proving explicit exact requests are never silently downgraded.

## 6. Subscribe And Snapshot Capture Integration

- [x] 6.1 Route ORDERBOOK subscription captures through the canonical raw, level, and summary builders while preserving existing stream response compatibility.
- [x] 6.2 Route TICKER, TRADES, and OHLCV subscription captures through the upgraded raw and normalized builders.
- [x] 6.3 Archive typed current order-book snapshot responses through the canonical path when a trusted production capture context is configured.
- [x] 6.4 Keep all capture calls asynchronous to gRPC stream delivery and add tests showing archive failures do not fail or delay successful response frames.
- [x] 6.5 Add bounded-cardinality metrics for received, sampled-out, archived, invalid, queue-saturated, journaled, and checksum-conflict rows by source and feed.

## 7. Multi-Feed Production Collector

- [x] 7.1 Generalize OHLCV-only collector configuration into validated exchange/pair/feed entries with order-book depth and OHLCV timeframe/bootstrap options.
- [x] 7.2 Implement independent supervisors for ORDERBOOK, TICKER, TRADES, and OHLCV while reusing the existing bounded reconnect/backoff lifecycle.
- [x] 7.3 Pass trusted capture-bundle and feed provenance from collector configuration into broker capture context and fail FIET-901 production startup/deployment validation unless the hosting broker archiver source is `broker_read`.
- [x] 7.4 Add feed-health state, last-frame time, reconnect count, and explicit unrecoverable-gap metrics and logs.
- [x] 7.5 Preserve OHLCV bootstrap/catch-up and distinguish bootstrap source mode from live source mode.
- [x] 7.6 Record gaps rather than synthesizing missed ORDERBOOK, TICKER, or TRADES events when provider catch-up is unavailable.
- [x] 7.7 Retain an OHLCV-compatible configuration/image wrapper during migration and document its replacement path.
- [x] 7.8 Add collector tests for concurrent pairs/feeds, isolated supervisor failure, reconnection, shutdown, missing bundle rejection, non-`broker_read` production rejection, and configuration validation.

## 8. Legacy Migration And Cutover

- [x] 8.1 Require this cutover order for existing deployments: apply canonical DDL, quiesce legacy writers, migrate every retained legacy window in ClickHouse, validate parity, switch consumers, and only then deploy the canonical-only broker.
- [x] 8.2 Add parity queries and metrics comparing legacy snapshots/candles with canonical summaries, levels, and OHLCV rows.
- [x] 8.3 Add idempotent table-to-table migration paths from `orderbook_snapshots` and `candles` that stamp legacy source mode and incomplete provenance while leaving unavailable capture bundles/raw identities/raw checksums null.
- [x] 8.4 Leave unavailable legacy raw identities/checksums null and test that migrated rows cannot be mistaken for provenance-complete captures.
- [x] 8.5 Add compatibility views for legacy order-book queries plus `candles`/`candles_closed` names and closure semantics for the agreed migration retention period.
- [x] 8.6 Document and test cutover and rollback procedures without a runtime legacy/dual/canonical archive write mode and without dropping legacy or canonical data.

## 9. End-To-End And Operational Verification

- [x] 9.1 Add an archive-forwarder/ClickHouse integration test that captures all four feeds and verifies raw-to-normalized linkage and checksum recomputation.
- [x] 9.2 Add a fault-injection test proving forwarder/ClickHouse unavailability does not terminate stream delivery and that retry or persistent loss journaling accounts for every failed row.
- [x] 9.3 Add idempotency tests proving physical level/summary duplicates remain auditable, canonical views return one checksum-consistent row, same-batch conflicts are rejected, and cross-batch conflicts remain observable and block replay.
- [x] 9.4 Retain the direct ClickHouse-to-Parquet reference exporter and checksum verifier, and record fixture materialization, coverage, and replay-bundle ownership under FIET-907.
- [x] 9.5 Validate a complete replay query across configured strategy pairs, capture bundles, and replay windows, including failure when a selected bundle has an order-book checksum conflict.
- [x] 9.6 Add non-destructive regression coverage for environment-first credential precedence, request-metadata fallback, and public fallback without credential profile, source-policy, or permission-attestation configuration.
- [ ] 9.7 Run a documented production-like soak covering feed health, reconnects, queue saturation, parity, loss journaling, and replay consumption before canonical cutover.

## 10. Documentation And Final Validation

- [x] 10.1 Document archive source, capture bundle, fixed environment-first credential precedence, external-fallback scope, feed configuration, checksum version, canonical/conflict views, FIET-907 exporter ownership, and mandatory ClickHouse migration in the broker README and service documentation.
- [x] 10.2 Document that TEE and non-TEE use the same full RPC surface and that non-TEE read-only posture depends on the actual selected exchange-key permissions rather than broker-side credential classification.
- [x] 10.3 Record FIET-903's broker RPC/capability sub-scope as complete and link the remaining canonical storage work to this change.
- [x] 10.4 Run the repository unit, integration, type-check, lint, and formatting commands required by CI.
- [x] 10.5 Run `openspec validate canonical-cex-market-data-replay-archive --strict` and resolve every validation error before implementation handoff.

## 11. Design Correction Audit

- [x] 11.1 Retain the direct ClickHouse-to-Parquet reference tools and reference them in FIET-907 as consumer-side materialization utilities outside the broker runtime.
- [x] 11.2 Remove the credential-profile, credential-source-policy, and permission-attestation implementation and lock the environment-first precedence rule in code, tests, design, delta specs, and operations documentation.
- [x] 11.3 Rename the legacy backfill implementation and configuration to migration terminology and document that it reads and writes ClickHouse tables without broker, exchange, or fixture-file input.
- [x] 11.4 Remove runtime archive write modes, make upgraded writers canonical-only, and require the bounded legacy-to-canonical ClickHouse migration before deployment.
- [x] 11.5 Record these decisions normatively so they survive OpenSpec sync/archive and are visible to subsequent human and agent reviewers.
- [x] 11.6 Re-run repository checks and strict OpenSpec validation after the correction.
