## 1. Cross-Repository Contract

- [x] 1.1 Copy the pinned Maker v2 archive envelope fixture byte-for-byte and add a fixture equality guard against Maker commit `563594435853c88cca5b187b8c999f845e31136b`.
- [x] 1.2 Add contract tests for legacy/empty, v1, v2, unknown version, missing v2 identity, mixed table, mixed source, empty envelope identity, and all-five-table requests.
- [x] 1.3 Implement a closed `hb_runtime` strategy request classifier and versioned row validator without changing non-strategy routing.

## 2. Strategy ClickHouse Schema

- [x] 2.1 Add the six common v2 producer/stream identity columns to all five strategy table create statements and additive migrations.
- [x] 2.2 Add the pinned policy-decision columns and content/revision/market-mapping columns to their respective tables and migrations.
- [x] 2.3 Enable a non-replicated insert deduplication window on all five strategy tables and make schema application idempotent on legacy databases.
- [x] 2.4 Add real ClickHouse tests for fresh schema, legacy upgrade, v1/v2 inserts, all five tables, and stable-token deduplication.

## 3. Durable SQLite Admission

- [x] 3.1 Add a Bun SQLite spool schema with atomic batch/work records, deterministic byte accounting, per-table state, dedupe tokens, and startup migration.
- [x] 3.2 Configure WAL, foreign keys, busy timeout, and full synchronous durability; add `ARCHIVE_FORWARDER_SPOOL_PATH` with local fallback `./archive-forwarder-spool.sqlite`.
- [x] 3.3 Enforce fixed 1 GiB quota and 72-hour retention in serialized admission/cleanup transactions with no environment overrides.
- [x] 3.4 Return HTTP 202 only after durable strategy admission, HTTP 429 on quota exhaustion, HTTP 503 on spool failure, and HTTP 400 for contract failures.
- [x] 3.5 Preserve direct synchronous ClickHouse behavior for every non-strategy request.

## 4. Drainage And Recovery

- [x] 4.1 Extend the ClickHouse inserter to accept a stable per-table `insert_deduplication_token`.
- [x] 4.2 Implement a worker that drains due table work independently and transactionally removes fully completed batches.
- [x] 4.3 Implement transient retry delays of 1/2/4/8/16/32/60 seconds with ±20 percent jitter through expiry.
- [x] 4.4 Classify permanent failures as terminal and retain them observably until expiry without hot-looping.
- [x] 4.5 Start and stop the worker with the forwarder lifecycle and recover pending work from the configured spool after restart.
- [x] 4.6 Add deterministic tests for partial success, isolated retry, ambiguous commit dedupe token reuse, restart recovery, expiry, and completion cleanup.

## 5. Health, Telemetry, And Deployment

- [x] 5.1 Extend health with spool writability and bounded queue/age/byte/terminal state; return degraded HTTP 200 for ClickHouse-down/spool-healthy and 503 for spool-unhealthy.
- [x] 5.2 Add bounded telemetry for admissions, rejections, quota, spool failures, depth, bytes, oldest age, retry, completion, terminal failure, expiry, and successful drain.
- [x] 5.3 Add fault tests for quota boundaries, concurrent admission, corruption, read-only/write/commit failures, and telemetry label bounds.
- [x] 5.4 Document the ownership boundary, fixed SLOs, retry/error semantics, local fallback, and required production persistent volume.
- [x] 5.5 Update Docker/compose deployment to persist the spool without introducing any new core `CEX_BROKER_*` environment option.

## 6. Mandatory Verification

- [x] 6.1 Add a required ClickHouse 24.8 CI service/job and make integration availability failure fatal in CI.
- [x] 6.2 Run the forwarder unit/contract/fault suite, real ClickHouse integration suite, repository tests, lint, formatting check, type-check/build, and strict OpenSpec validation.
- [x] 6.3 Verify the implementation against both new capability specs and resolve every critical or warning-level divergence.

## 7. Coordinated Release And Maker Closure

- [ ] 7.1 Select the smallest unused patch above `0.2.36`, update CEX package/image metadata, and publish matching version/digest evidence after required Actions pass.
- [ ] 7.2 Update Maker's CEX Broker dependency and lockfile, run Maker strict checks, record CEX commit/PR/Actions/version/digest evidence, and complete Maker task 8.6.
- [ ] 7.3 Update FIET-937 with the retained production observation cutover gate, link FIET-901/FIET-903 to the scope transition, and comment FIET-909 with conformance evidence while leaving FIET-924 closed.
- [ ] 7.4 Sync and archive this change only after both repositories satisfy the cross-service definition of done.
