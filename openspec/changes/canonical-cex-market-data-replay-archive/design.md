## Context

The broker already normalizes and streams ORDERBOOK, TICKER, TRADES, and OHLCV data through `Subscribe`, and its archive writer provides bounded queues, batching, retries, metrics, and a persistent loss-journal contract. The completed `cex-broker-order-book-depth-sourcing` change also provides Maker-compatible current snapshot, capability, live stream, and typed historical-unsupported behavior.

The remaining gap is the archive contract. Common tags and the forwarder envelope currently hardcode `broker_write`; order books are stored as arrays in `market_data.orderbook_snapshots`; OHLCV is stored in `market_data.candles`; and capture bundles, provider provenance, raw-capture identity, and normalized-row checksums are absent. The existing production collector supervises OHLCV only.

This change crosses handlers, helpers, collector and forwarder services, ClickHouse schemas, deployment configuration, and Maker contract fixtures. Domain logic remains below `src/server.ts`: server code only wires deployment configuration into handlers and helpers, preserving the repository dependency direction `server -> handlers -> helpers`.

## Goals / Non-Goals

**Goals:**

- Produce replay-auditable CEX market-data rows for all four required public feeds.
- Distinguish `broker_read` and `broker_write` archival provenance without maintaining separate RPC surfaces or binaries.
- Preserve the existing environment-first credential resolution order and leave effective privilege to exchange key permissions.
- Introduce canonical ClickHouse level, summary, and OHLCV tables compatible with Maker replay semantics.
- Make capture and normalized-row integrity reproducible across TypeScript and Python.
- Preserve current stream delivery and trading behavior when the archive sink is unavailable.
- Migrate legacy tables without fabricating evidence that was not captured.

**Non-Goals:**

- Add read/write RPC action gating, a `readEnabled`/`writeEnabled` switch, or a reduced market-read service surface.
- Change the existing protobuf service or remove generic `Action.Call`.
- Implement exact L2 reconstruction or claim exact continuity for sampled websocket snapshots.
- Implement a historical order-book provider where current capabilities truthfully report unsupported.
- Implement native Hummingbot inside the TypeScript broker; an approved Hummingbot fallback is a separate producer of the shared contract.
- Route DEX, protocol, or on-chain facts through the CEX archive.
- Move Maker coverage planning, prior-as-of joins, or thesis-validity decisions into cex-broker.
- Introduce credential profiles, credential-source policy, permission-attestation configuration, or archive-specific credential routing.
- Keep a runtime legacy/dual/canonical archive write selector after the canonical schema upgrade.

## Decisions

### 1. One full broker service; credentials establish effective privilege

TEE and non-TEE deployments use the same binary and register the same `ExecuteAction` and `Subscribe` implementations. No handler is removed based on deployment environment or archive role.

Credential selection is deduced from the sources actually present, in this fixed order:

1. A matching broker account loaded from environment configuration.
2. Complete request `api-key` and `api-secret` metadata when no matching environment broker exists.
3. Credentialless public exchange construction only where the existing operation supports public access.

An environment-loaded broker always wins when both environment and request credentials are present. This change adds no credential profile, credential-source policy, or permission-attestation configuration. The selected exchange key's permissions establish effective privilege, so a non-TEE read deployment must receive only keys whose exchange-side permissions match its intended read-only posture regardless of whether they arrive from environment configuration or request metadata.

Alternative considered: add broker-side credential profiles or reject one credential source by deployment policy. That duplicates existing credential routing, changes accepted requests, and is intentionally excluded from this archival change.

### 2. Archive source is explicit and independent of operation type

The archive writer is constructed with one immutable source identity. Common archive tags receive that source rather than importing a write-only constant, and the HTTP envelope uses the writer's configured source rather than a literal. The forwarder validates that envelope and row sources agree.

Source is not inferred from TEE state, the selected exchange method, whether credentials are present, or whether an operation happens to be read-only. A write-capable deployment can still archive market observations as `broker_write`; the broker/archiver hosting FIET-901 production subscriptions must be explicitly configured as `broker_read`. FIET-901 production capture startup or deployment validation fails before opening subscriptions when that source is not `broker_read`.

Alternative considered: infer source from `Subscribe` versus `ExecuteAction`. That misclassifies market streams observed by write brokers and cannot describe an explicitly deployed capture role.

### 3. Capture context is created by trusted deployment or collector configuration

A shared market-capture context carries:

- source and deployment id;
- capture bundle id;
- exchange, trading pair/source symbol, asset type, and feed;
- provider and versioned source mode;
- source and received timestamps;
- raw-capture identity/scope/checksum, schema version, and raw/normalized checksum algorithm versions.

The production collector or deployment configuration owns `capture_bundle_id`; it is not accepted from provider payloads. Production startup requires a non-empty value. Bundle rotation remains an orchestration concern, allowing one replay window to reference one or more finite capture bundles without coupling broker row normalization to a Maker run id.

Request-controlled values are limited to feed selection parameters and the existing optional in-flight credential metadata already supported by the broker contract. Archive source, deployment, and capture authority remain server-side.

### 4. Capture-core fields are separate from Maker materialization fields

ClickHouse and Maker parquet share an immutable capture core: market identity, provider, timestamps, evidence modes, depth, raw/snapshot identities, schema version, and checksums. Maker may extend exported rows with run id, coverage-report path, effective as-of lag, future-leakage status, and assumption haircuts.

Maker extensions do not participate in the broker's raw-capture or normalized-row checksum. This avoids inventing run-specific facts during live ingestion and permits multiple replay runs to reuse the same capture. The retained direct ClickHouse-to-Parquet exporter is a FIET-907 reference tool and never enters the live broker capture path.

Alternative considered: copy Maker's current parquet schema verbatim into ClickHouse. That would put fields unknown at capture time into the source-of-record tables and blur immutable evidence with derived replay assessment.

### 5. `cex_stream_events` is the raw-capture ledger

`market_data.cex_stream_events` is extended to hold the redacted broker-visible payload or reproducible capture metadata plus `raw_capture_id`, `raw_capture_scope`, checksum algorithm/version, and raw checksum. Normalized ticker, trade, OHLCV, order-book level, and summary rows reference that identity.

For current CCXT-based feeds, `raw_capture_scope` states that the retained object is CCXT-normalized or broker-visible; it does not claim to contain exchange websocket bytes. This provides honest reproducibility without introducing a second generic raw-event table.

Alternative considered: create a separate raw-order-book table. Reusing the generic stream ledger keeps capture identity consistent across all feeds and reduces duplicate payload contracts.

### 6. Checksums use a versioned cross-language canonical projection

Raw checksums are SHA-256 over a canonical serialization of the redacted broker-visible payload. Raw capture identity is derived from stable market/capture identity fields and the raw checksum, making retries reproducible.

Normalized row checksums are SHA-256 over a versioned semantic projection containing immutable contract fields and normalized feed values. The checksum field itself, ClickHouse ingestion metadata, retry counters, and Maker run extensions are excluded. Numeric and timestamp canonicalization is specified explicitly and locked with TypeScript/Python golden fixtures before production cutover.

Alternative considered: hash ordinary `JSON.stringify` output. Object ordering and numeric representation are not a sufficiently durable cross-language contract.

### 7. The collector becomes a feed-neutral supervisor

The existing OHLCV collector supervision pattern is generalized into a market-data collector with one independent supervisor per configured exchange, pair, feed, and relevant option set. It connects to the deployed full broker and keeps subscriptions alive; the broker's Subscribe handler remains the capture boundary.

Each supervisor exposes feed health, last frame, reconnect count, and archival counters. OHLCV retains bootstrap/catch-up behavior. ORDERBOOK, TICKER, and TRADES record explicit gaps when providers cannot replay a disconnected interval rather than synthesizing data.

The existing OHLCV configuration and image entry point may remain as a compatibility wrapper during migration, but canonical production configuration describes a set of feeds rather than OHLCV-only rows.

The collector does not implement direct CCXT or native Hummingbot fallback producers in this change. If a separately deployed producer writes the shared capture contract, ingestion validates its exchange/pair identity, provider, source mode, and fallback reason and rejects cross-venue substitution.

### 8. Canonical tables favor row-oriented replay shapes

The canonical ClickHouse outputs are:

- `market_data.cex_stream_events` for raw capture metadata/payloads;
- `market_data.cex_order_book_levels` for one side/level row;
- `market_data.cex_order_book_depth_summary` for one snapshot summary;
- `market_data.cex_ticker_events`;
- `market_data.cex_trades`;
- `market_data.cex_ohlcv`.

Level and summary tables use deterministic snapshot identity and repeat the capture-core provenance necessary for independent parquet export. ClickHouse-native timestamp and numeric types may differ physically from Arrow types, but exported values and field semantics must satisfy the shared fixtures.

The order-book level and summary base tables remain append-only `MergeTree` evidence stores so retries and checksum conflicts are not erased by background replacement merges. Their physical `ORDER BY` keys begin with exchange, trading pair, capture bundle, and source time and include the deterministic logical identity:

- level: capture bundle, exchange, pair, raw capture, snapshot, schema version, side, and level index;
- summary: capture bundle, exchange, pair, raw capture, snapshot, and schema version.

`market_data.cex_order_book_levels_canonical` and `market_data.cex_order_book_depth_summary_canonical` expose one logical row only when all physical deliveries for that logical key agree on `normalized_row_checksum`. Separate conflict views group physical rows by logical key and report more than one distinct checksum. Conflicted keys are excluded from canonical views, emit an operational alert/metric, and make replay validation fail for the affected capture bundle. The forwarder rejects a same-batch logical-key conflict before insertion; cross-batch conflicts remain preserved and visible in ClickHouse.

`market_data.cex_ohlcv` uses `ReplacingMergeTree(broker_version)` because forming and closed versions of the same candle are legitimate state updates. Its canonical closed-candle view uses `FINAL`, preserving the established candle query semantics.

Alternative considered: use `ReplacingMergeTree` for order-book rows. That can collapse conflicting deliveries before an integrity detector observes them, so append-only evidence plus canonical/conflict views is preferred.

### 9. Sampled top-N remains the implemented order-book evidence mode

Live and current broker order books are classified as `sampled_top_n_snapshot` unless a future implementation supplies a valid initial snapshot, ordered deltas, complete sequence range, clean continuity status, and `exact_l2_reconstruction_complete=true`. Exact mode uses fail-fast gap semantics.

An explicit exact request returns the existing typed unsupported result when capability is false. Capability discovery may lead the caller to select sampled mode on a subsequent request, but the broker never silently downgrades an explicit exact run.

Source-mode and gap-policy values are versioned closed registries shared with Maker. Unknown values fail validation rather than entering ClickHouse as free-form evidence claims.

### 10. Existing archive durability machinery is extended, not replaced

Market rows continue through the bounded `BrokerExecutionArchiver` queue and archive forwarder. The writer becomes source-aware, and metrics add source/feed labels within bounded-cardinality sets. The forwarder allowlist and DDL are expanded for canonical tables.

Sink failures remain asynchronous to stream delivery. Queue overflow, terminal retries, and bounded shutdown continue to use the persistent loss journal, preserving the current strategy-runtime isolation.

## Risks / Trade-offs

- [A non-TEE deployment receives a write-capable key] -> Restrict permissions at the exchange and control which secrets trusted callers or deployment configuration can supply; the broker does not infer or attest key scope.
- [Environment and request credentials are both present] -> Select the environment-loaded broker deterministically and lock the precedence with handler regression tests.
- [A reviewer reintroduces credential-policy configuration as archival scope] -> Keep the no-profile/no-policy decision normative in this design, delta spec, tasks, and operations documentation.
- [TypeScript and Python checksum results diverge] -> Freeze numeric/timestamp canonicalization with shared golden fixtures before enabling production writes.
- [Per-level rows and retained raw payloads increase volume] -> Keep configurable top-N sampling, bounded payloads, batching, partitioning, retention policy, and feed-volume metrics.
- [Legacy writes race the table migration] -> Quiesce legacy writers before migrating every retained partition and block upgraded deployment until parity validation passes.
- [Legacy migration appears provenance-complete] -> Stamp a legacy source mode and explicit incomplete-provenance flag; leave unavailable raw identity/checksum fields null.
- [Capture bundles become unbounded] -> Require deployment/orchestration ownership and documented rotation; replay manifests may combine multiple finite bundles.
- [Schema changes drift from Maker] -> Maintain shared capture-core fixtures and make contract tests a required check in both repositories.
- [Duplicate order-book deliveries disagree] -> Preserve physical rows in append-only tables, exclude conflicts from canonical views, alert on conflict views, and fail replay validation for affected bundles.

## Migration Plan

1. Freeze the capture-core schema, enum registry, canonicalization algorithm, and TypeScript/Python golden fixtures.
2. Make common archive tags, writer envelopes, loss-journal entries, and forwarder validation source-aware while defaulting existing deployments to `broker_write` for compatibility.
3. Apply forwarder support and ClickHouse DDL for the canonical tables while the existing legacy-writing broker remains deployed.
4. Quiesce legacy writers and run the bounded ClickHouse table-to-table migration for every retained order-book and candle partition with explicit legacy/incomplete provenance.
5. Validate migration parity, canonical/conflict views, and replay queries. Any missing row, mismatch, or conflict blocks deployment of the upgraded broker.
6. Switch consumers to canonical tables and deploy the upgraded broker and generalized collector. The upgraded version writes only the latest canonical schema; the FIET-901 collector uses `broker_read`, a required capture bundle, and the complete strategy pair/feed configuration.
7. Observe feed health, queue behavior, checksum verification, and Maker consumption through the agreed soak window.
8. Retain compatibility views and untouched legacy base data for the agreed retention period.

Rollback stops the upgraded broker, restores retained legacy query names when necessary, and rolls the application back to the previous legacy-writing version. Canonical and legacy data remain intact, and affected capture bundles remain identifiable. There is no runtime archive write-mode switch.

## Open Questions

No architecture question blocks implementation. Deployment owners must choose the production capture-bundle rotation interval and retention window before rollout; the broker contract only requires that each production row carry a valid deployment-owned bundle id.
