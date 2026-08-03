## Context

Maker's `ArchiveEmitter` sends one HTTP attempt from a bounded, non-blocking in-memory queue. It cannot safely retry after an ambiguous response because the CEX Broker forwarder currently groups a request by table and inserts those groups sequentially: some tables may commit before a later table fails. The forwarder returns 200 only after synchronous ClickHouse completion and has no restart-recoverable ownership boundary.

The pinned cross-repository contract is Maker commit `563594435853c88cca5b187b8c999f845e31136b`, especially `packages/hb-maker-shared/tests/fixtures/archive_forwarder_envelope.json`, `archive_emitter.py`, and the upstream schema fixture. The five replay-critical targets are `strategy_data.policy_evaluation_events`, `strategy_data.strategy_policy_snapshots`, `strategy_data.market_identity`, `strategy_data.symbol_mapping`, and `strategy_data.inventory_settlement_events`.

The archive forwarder also accepts market-data, broker-account, and broker-execution rows. Those producers already have their own queue/retry/loss-journal contracts and must not inherit Maker-specific latency, quota, or retention behavior.

## Goals / Non-Goals

**Goals:**

- Establish durable forwarder ownership before Maker discards an emitted batch.
- Keep multi-table retries independent and idempotent across process restarts.
- Enforce one versioned Maker wire/schema contract in CEX Broker and Maker tests.
- Bound disk use and retention with observable, typed admission failures.
- Keep health truthful during ClickHouse outages and spool failures.
- Coordinate a CEX release and Maker dependency/evidence update.

**Non-Goals:**

- Change Maker's non-blocking controller-tick architecture or add producer retries.
- Spool `broker_read`, `broker_write`, `maker_replay`, account, execution, or market-data traffic.
- Add broker RPCs, handler gates, credential policy, or core `CEX_BROKER_*` settings.
- Make the spool quota or retention operator-configurable.
- Replace ClickHouse, materialize Parquet, or perform FIET-937's production observation window.

## Decisions

### 1. Strategy-only admission is a closed contract

A request uses the durable path only when `source=hb_runtime` and every row targets one of the five `strategy_data.*` tables. A mixed strategy/non-strategy `hb_runtime` request is rejected, as is a strategy table under any other source. This avoids silently splitting one producer request across ownership models.

Alternative considered: spool every archive row. That would duplicate the broker writers' existing durability machinery, couple unrelated failure domains, and make a Maker quota incident affect trading-path archives.

### 2. SQLite is the acceptance boundary

The forwarder uses Bun's built-in `bun:sqlite`. Admission serializes the validated envelope canonically and commits a batch row plus one pending work item per represented table in a single transaction. Only after the transaction is durable does the server return HTTP 202.

SQLite runs with WAL, foreign keys, a busy timeout, and full synchronous durability. The database path is the sole new runtime option: `ARCHIVE_FORWARDER_SPOOL_PATH`, defaulting locally to `./archive-forwarder-spool.sqlite`. Production deployment mounts that path on persistent storage. The archive forwarder option is deliberately not a `CEX_BROKER_*` variable.

Alternative considered: a JSONL spool. It is easy to append but requires custom indexes, atomic per-table completion, compaction, corruption recovery, and quota accounting that SQLite already supplies.

### 3. Capacity and retention are fixed contract values

The spool admits at most 1 GiB of accounted payload and metadata and retains pending work for at most 72 hours. These values are constants, not environment knobs. Admission performs expiry cleanup and quota reservation in the same serialized transaction. Quota exhaustion returns 429 without accepting ownership; an unavailable/unwritable spool returns 503.

Expired work is terminally recorded in bounded telemetry before deletion. The API never returns 202 for a batch that was not durably committed.

Alternative considered: configurable values. Cross-service completion needs one predictable delivery envelope; deployment-specific tuning would make Maker's effective loss window unknowable.

### 4. Retry state is per batch and table

Each admitted batch is split into at most five work records. A successful table insert marks only that work record complete. Failed tables retry without replaying successful siblings. Once all work completes, the batch and its work records are deleted transactionally.

Transient failures retry after 1, 2, 4, 8, 16, 32, then 60 seconds, capped at 60 seconds, with ±20% jitter until expiry. Schema/authentication and other permanent ClickHouse errors are retained as terminal failures until expiry and exposed through health/telemetry rather than hot-looped.

Each table work item receives a stable SHA-256 deduplication token derived from its persisted batch identity and table name. The ClickHouse insert sets `insert_deduplication_token`; strategy tables enable a sufficiently large non-replicated deduplication window so an ambiguous insert can be retried without duplicating rows.

Alternative considered: whole-envelope retry. It is simpler but repeats already-successful tables and cannot isolate one poisoned table.

### 5. Wire versions are explicit and backward compatible

Missing/empty `schema_version` and version `1` remain accepted as legacy rows. Version `2` requires non-empty `producer_id`, `producer_run_id`, `stream_name`, and `archive_event_id`, plus positive integer `stream_seq` and `seq`. Unknown versions fail with HTTP 400. Envelope `source` and `deployment_id` must be non-empty, rows must be non-empty and no more than 1000, and row source/deployment values must agree when supplied.

The Maker golden envelope is copied byte-for-byte into the CEX fixture and guarded by a cross-repository checksum/equality test. Schema changes are additive: v2 identity fields are added with compatibility defaults, along with the pinned policy and identity/mapping columns. Historical v1 rows remain readable.

### 6. Health distinguishes acceptance from drainage

Spool health tests open/write/transaction capability and exposes queued batches, queued table work, accounted bytes, oldest age, expired/terminal counts, and last error class using bounded labels. ClickHouse-down plus spool-healthy returns HTTP 200 with degraded status because the forwarder can still durably accept Maker work. Spool-unhealthy returns HTTP 503. Non-strategy direct traffic retains its existing synchronous response contract.

### 7. Release evidence closes both repositories

CEX Broker publishes the smallest unused patch above `0.2.36`, with package and image using the same version and recorded digest. Mandatory CI includes contract, SQLite fault/restart, and real ClickHouse 24.8 tests. Maker then updates its package/lock pin, reruns its strict validation, records the CEX PR/Actions/version/digest evidence, and completes task 8.6. FIET-909 receives the conformance evidence; FIET-937 retains the separate production observation gate.

## Risks / Trade-offs

- [SQLite file is on ephemeral storage] -> Production compose/runbooks require a persistent mount and health reports the resolved path class without leaking secrets.
- [Quota fills during a long ClickHouse outage] -> Fixed admission accounting returns 429 before ownership and exposes depth/oldest-age metrics for alerting.
- [ClickHouse commits then the worker crashes] -> Stable per-table deduplication tokens and non-replicated dedup settings suppress retry duplicates.
- [A malformed Maker row poisons retries] -> Validate the versioned contract before admission and classify permanent ClickHouse errors as terminal rather than hot-looping.
- [Schema drift reappears] -> Pin the exact Maker fixture and require both repositories' tests against the same v2 field set.
- [SQLite corruption prevents recovery] -> Fail closed with 503, report spool unhealthy, preserve the file for operator recovery, and never fall back to memory-only acceptance.
- [Fixed retention expires evidence during an extended outage] -> Alert on oldest age and terminal expiry; 72 hours is the explicit service SLO rather than hidden indefinite retention.

## Migration Plan

1. Apply additive `strategy_data.*` DDL and deduplication settings on ClickHouse 24.8.
2. Deploy the forwarder with a persistent `ARCHIVE_FORWARDER_SPOOL_PATH`; startup validates/migrates the SQLite schema before listening.
3. Verify legacy/v1/v2 contract cases and an all-five-table v2 envelope against real ClickHouse.
4. Exercise ClickHouse outage, restart recovery, partial-table retry, quota, retention, and corruption/write-failure behavior.
5. Publish the coordinated CEX Broker package/image version and evidence.
6. Update Maker's dependency/lock/evidence at the pinned branch and complete its remaining conformance task.
7. Roll back the application only after stopping admission and preserving the spool volume; the additive ClickHouse columns remain compatible with the prior forwarder.

## Open Questions

None. The wire shape, ownership boundary, storage choice, quota, retention, retry schedule, and release boundary are fixed by this change.
