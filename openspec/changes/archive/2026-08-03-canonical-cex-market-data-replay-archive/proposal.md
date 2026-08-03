## Why

The broker already exposes the required CEX market-data streams and truthful order-book RPC capabilities, but its archive plane still identifies all rows as `broker_write`, uses legacy ClickHouse table shapes, and cannot prove which capture bundle or normalized rows were used by replay. FIET-901 and the remaining FIET-903 storage scope need a canonical, provenance-complete ingestion contract that production capture and Maker replay can share.

## What Changes

- Add deployment-controlled archive provenance for `broker_read` and `broker_write` without changing which RPCs the broker service registers.
- Keep the same full broker service in TEE and non-TEE deployments and preserve the established credential resolution order: a matching environment-loaded broker takes precedence, request metadata is used only when no environment broker exists, and public construction is the final fallback for supported public operations. Effective privilege comes from the selected exchange key's permissions, not broker-side profiles or gates.
- Define capture-bundle, provider, source-mode, construction-mode, gap-policy, raw-capture, schema-version, and deterministic checksum fields shared across CEX market-data outputs.
- Generalize production collection from OHLCV-only supervision to configured `ORDERBOOK`, `TICKER`, `TRADES`, and `OHLCV` feeds for every strategy exchange/pair.
- Keep direct CCXT/Hummingbot fallback producers outside this broker implementation while requiring any externally supplied fallback rows admitted to the shared contract to preserve venue/pair provenance.
- Add canonical ClickHouse outputs for order-book levels, order-book depth summaries, and OHLCV, and upgrade stream, ticker, and trade outputs with replay provenance.
- Normalize sampled top-N order books deterministically and retain truthful evidence semantics; exact L2 and broker historical snapshots remain unsupported unless their advertised capability is implemented and continuity is proven.
- Require a bounded ClickHouse table-to-table migration of legacy `market_data.orderbook_snapshots` and `market_data.candles` before deploying the upgraded canonical-only writer, without fabricating unavailable legacy provenance.
- Add cross-language contract fixtures and end-to-end validation from broker capture through ClickHouse to Maker-compatible replay rows.
- Retain the direct ClickHouse-to-Parquet reference exporter as a FIET-907 consumer-side tool; it is not part of the broker runtime or live capture path.
- Leave Maker `strategy_data.*` archive-forwarder delivery, schema-version validation, and durable acceptance to the dedicated `maker-archive-forwarder-conformance` change.

## Capabilities

### New Capabilities

- `cex-market-data-replay-capture`: Production collection and archival of broker-read CEX streams with bundle identity, provider provenance, checksums, established credential precedence, and non-blocking durability.
- `cex-order-book-replay-archive`: Canonical order-book level and depth-summary tables, deterministic normalization, evidence-quality rules, integrity metadata, and legacy table migration.

### Modified Capabilities

- None.

## Impact

- Archive source types, common tags, batching envelopes, loss journals, and archive-forwarder validation.
- `Subscribe` market-data capture helpers and the existing OHLCV collector service, generalized to all required public market feeds.
- ClickHouse market-data schemas, supported-table allowlists, compatibility views, migrations, and research/replay queries.
- Order-book normalization and archive row builders; the completed order-book RPC/capability behavior remains backward compatible.
- Documentation and regression coverage for environment-first credential precedence without new credential profile, source-policy, or attestation configuration.
- Maker-facing schema fixtures, a retained FIET-907 reference exporter, and integration tests for canonical parquet-compatible replay rows.
- The Maker `hb_runtime` forwarder wire contract and spool are explicitly outside this change and tracked by `maker-archive-forwarder-conformance`.
