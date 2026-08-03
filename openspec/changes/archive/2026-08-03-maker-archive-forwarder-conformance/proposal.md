## Why

Maker emits replay-critical `hb_runtime` observations once and does not own downstream retries, while the archive forwarder currently acknowledges only after direct ClickHouse insertion and can partially commit a multi-table batch. The CEX Broker must provide a versioned, durable acceptance boundary so Maker delivery is recoverable, schema-conformant, and independently retryable without changing the broker's other archive paths.

## What Changes

- Pin the Maker-to-forwarder envelope, five-table allowlist, schema-version rules, and v2 producer/stream identities using a shared golden fixture.
- Add an atomic SQLite spool for conforming `hb_runtime` strategy batches, acknowledge durable acceptance with HTTP 202, and keep all non-strategy archive traffic on the existing direct ClickHouse path.
- Enforce a fixed 1 GiB spool quota and 72-hour retention, restart recovery, per-table completion, stable ClickHouse deduplication tokens, isolated exponential retry, and explicit 429/503 failure semantics.
- Add additive `strategy_data.*` schema-v2 columns and ClickHouse non-replicated deduplication settings without rewriting historical rows.
- Expose spool health and bounded telemetry; ClickHouse unavailability degrades health while a writable spool remains available and does not make admission unavailable.
- Make real ClickHouse 24.8 and SQLite durability/fault coverage mandatory in CI, and publish matching CEX Broker package/image version evidence for Maker task 8.6.
- Keep the production observation window as FIET-937's deployment cutover gate rather than an OpenSpec implementation task.

## Capabilities

### New Capabilities

- `strategy-runtime-archive-ingestion`: Versioned Maker `hb_runtime` envelope, table, field, source-isolation, and ClickHouse schema contract.
- `archive-forwarder-durable-acceptance`: Durable strategy-only admission, bounded spool, retry, restart recovery, health, and operational error contract.

### Modified Capabilities

- None.

## Impact

- `services/archive-forwarder/` request validation, health, telemetry, ClickHouse insertion, and a new Bun SQLite spool/worker.
- `schema/clickhouse/strategy_data.sql`, the Maker golden fixture, Docker deployment mounts, and archive-forwarder operations documentation.
- CI gains a required ClickHouse 24.8 service and non-skipping integration contract.
- CEX Broker package/image release metadata and the Maker dependency/lock/evidence record are coordinated across repositories.
- No protobuf, broker RPC, credential selection, trading handler, market-data archival, or core `CEX_BROKER_*` environment configuration changes.
