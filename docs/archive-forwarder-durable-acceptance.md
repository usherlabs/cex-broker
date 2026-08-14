# Maker archive-forwarder durable acceptance

## Purpose and ownership boundary

Maker's runtime archive bridge makes one non-blocking HTTP attempt. The archive
forwarder therefore owns a conforming request only after it commits the request
to its SQLite spool. It then returns HTTP 202 and drains each represented table
to ClickHouse independently. Maker does not retry an acknowledged batch.

The durable path is deliberately narrow: `source=hb_runtime` and exclusively these five
tables:

- `strategy_data.policy_evaluation_events`
- `strategy_data.strategy_policy_snapshots`
- `strategy_data.market_identity`
- `strategy_data.symbol_mapping`
- `strategy_data.inventory_settlement_events`

Mixed requests are rejected atomically. Strategy tables under sources other than
`hb_runtime` and `maker_replay` are rejected. Valid `maker_replay` rows share the
same schema/provenance checks but use direct synchronous ClickHouse insertion:
HTTP 200 means stored, HTTP 500 means the replay producer retains retry ownership,
and HTTP 202 is never returned. `broker_read`, `broker_write`, account, execution,
market-data, and replay requests do not consume spool capacity.

## Wire versions

The envelope requires non-empty `source`, non-empty `deployment_id`, and 1–1000
rows. Missing/empty `schema_version` and version `1` use the legacy contract.
Version `2` additionally requires non-empty `producer_id`, `producer_run_id`,
`stream_name`, and `archive_event_id`, plus positive integer `stream_seq` and
`seq`. Unknown versions and row/envelope provenance mismatches return HTTP 400.

`test/fixtures/archive_forwarder_envelope.json` is byte-identical to the fixture
at Maker commit `563594435853c88cca5b187b8c999f845e31136b`; its pinned SHA-256 is
`784f647e048052a6c3382309b1a86abfbe08bc162363ead9fc88eaa1ba3d50c9`.

## Spool storage and fixed service limits

The forwarder uses Bun SQLite with WAL, foreign keys, a 5-second busy timeout,
and `synchronous=FULL`. Local runs default to:

```text
./archive-forwarder-spool.sqlite
```

Production must configure and persist:

```text
ARCHIVE_FORWARDER_SPOOL_PATH=/var/lib/archive-forwarder/spool.sqlite
```

Mount `/var/lib/archive-forwarder` on durable storage. The supplied Dockerfile
and compose service do so. This is an archive-forwarder service option, not a
core broker `CEX_BROKER_*` option.

Quota is fixed at 1 GiB of deterministic payload/metadata accounting. Retention
is fixed at 72 hours from admission. Neither has an environment override. Quota
reservation, expiry cleanup, batch insertion, and per-table work insertion are
transactional.

## Responses and retry behavior

- `202`: the complete Maker batch is durably owned; ClickHouse completion may be pending.
- `400`: invalid envelope, table/source mix, provenance, or schema version/identity.
- `429`: accepting the batch would exceed the fixed spool quota; ownership was not accepted.
- `503`: the spool is missing, corrupt, unwritable, or cannot commit; ownership was not accepted.

Those 202/429/503 ownership responses apply to `hb_runtime`. A conforming
`maker_replay` request returns 200 after direct insertion or 500 on insertion
failure, without creating batches, work, bytes, retries, deduplication tokens,
terminal state, or expiry state in the spool.

Transient ClickHouse failures retry after 1, 2, 4, 8, 16, 32, then 60 seconds,
with ±20% jitter, through retention expiry. Completion is tracked per table, so
a failed table never replays successful siblings. Schema and authentication
failures become terminal and remain visible until expiry instead of hot-looping.

Each batch/table work item persists one stable SHA-256 deduplication token. The
worker passes it as `insert_deduplication_token`, while every strategy table has
`non_replicated_deduplication_window=1000000`. A crash after a ClickHouse commit
but before SQLite completion therefore retries with the same token.

## Health and operations

`GET /health` reports ClickHouse/schema readiness separately from spool
writability and exposes queued batches/work, terminal/expired work, accounted
bytes, oldest age, and the last bounded error class.

- ClickHouse down + spool healthy: HTTP 200, `status=degraded`, durable admission available.
- ClickHouse ready + spool healthy: HTTP 200, `status=ok`.
- Spool unhealthy: HTTP 503, `status=unavailable`, even when ClickHouse is reachable.

On restart, the service attempts to open/migrate the spool before listening and
resumes incomplete work after ClickHouse schema readiness. If the persisted file
is unavailable or corrupt, the service remains up only to expose unavailable
health and the existing direct path; strategy admission fails with 503 until an
operator preserves/repairs the file and restarts. Never delete or replace a spool
file with pending work during rollback. Stop admission, preserve the volume, and
retain the additive ClickHouse columns.

The production feed/archive observation window is a separate FIET-937 cutover
gate. Repository conformance checks do not claim that observation has run.
