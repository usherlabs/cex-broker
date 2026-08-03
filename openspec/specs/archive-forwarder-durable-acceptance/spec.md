# archive-forwarder-durable-acceptance Specification

## Purpose
TBD - created by archiving change maker-archive-forwarder-conformance. Update Purpose after archive.
## Requirements
### Requirement: Accepted Maker batches are durable before acknowledgement

The forwarder MUST atomically persist a validated Maker envelope and one pending work item per represented strategy table before returning HTTP 202. It MUST NOT acknowledge acceptance when the spool transaction has not committed.

#### Scenario: Strategy batch is durably admitted
- **WHEN** a conforming Maker batch commits to the SQLite spool
- **THEN** the forwarder MUST return HTTP 202 without waiting for ClickHouse

#### Scenario: ClickHouse is unavailable during admission
- **WHEN** ClickHouse is unavailable but the spool is writable and within quota
- **THEN** the forwarder MUST still durably admit the batch and return HTTP 202

#### Scenario: Spool is unavailable
- **WHEN** the spool cannot open, write, or commit
- **THEN** the forwarder MUST return HTTP 503 and MUST NOT claim ownership

### Requirement: Spool bounds are fixed and atomic

The strategy spool SHALL use a fixed 1 GiB quota and fixed 72-hour retention. Admission accounting, expiry cleanup, and quota reservation MUST be serialized so concurrent requests cannot over-admit. Neither value SHALL be configurable through environment variables.

#### Scenario: Admission fits quota
- **WHEN** the committed spool bytes plus the new batch's deterministic accounted bytes do not exceed 1 GiB
- **THEN** the batch MUST be eligible for atomic admission

#### Scenario: Admission exceeds quota
- **WHEN** accepting a batch would exceed the fixed quota
- **THEN** the forwarder MUST return HTTP 429 without persisting any part of that batch

#### Scenario: Work reaches retention limit
- **WHEN** pending or terminal work reaches 72 hours since admission
- **THEN** it MUST be expired transactionally and the loss MUST be recorded in bounded telemetry

### Requirement: Spool storage is restart recoverable

The forwarder MUST use Bun SQLite with WAL, foreign keys, a busy timeout, and full synchronous durability. `ARCHIVE_FORWARDER_SPOOL_PATH` SHALL select the database path and SHALL default to `./archive-forwarder-spool.sqlite`; production documentation MUST require persistent storage for that path.

#### Scenario: Forwarder restarts with pending work
- **WHEN** a process exits after acknowledgement and restarts with the same spool path
- **THEN** every incomplete table work item MUST remain eligible for drainage

#### Scenario: Local path is not configured
- **WHEN** the service starts without `ARCHIVE_FORWARDER_SPOOL_PATH`
- **THEN** it MUST use `./archive-forwarder-spool.sqlite`

#### Scenario: SQLite is corrupt or read-only
- **WHEN** startup or a health transaction detects corruption or inability to write
- **THEN** strategy admission MUST fail closed with HTTP 503 and health MUST report the spool unhealthy

### Requirement: Delivery retries are isolated and idempotent

The worker MUST track completion independently for each table in a batch. Transient failures MUST retry after exponential delays starting at 1 second, doubling to a 60-second cap, with ±20 percent jitter until retention expiry. Successful siblings MUST NOT be retried.

Each table work item MUST use one stable ClickHouse `insert_deduplication_token`, and each strategy table MUST enable non-replicated deduplication over a window large enough for the admitted delivery horizon.

#### Scenario: One table fails after siblings succeed
- **WHEN** a multi-table batch inserts some table groups and one table returns a transient error
- **THEN** only the failed table work item MUST be rescheduled

#### Scenario: Insert outcome is ambiguous across restart
- **WHEN** ClickHouse commits a table insert but the worker exits before recording completion
- **THEN** the restarted retry MUST use the same deduplication token and MUST not create duplicate logical delivery rows

#### Scenario: Permanent ClickHouse failure occurs
- **WHEN** a table insert fails with a schema, authentication, or other classified permanent error
- **THEN** the work MUST become terminal, MUST NOT hot-loop, and MUST remain observable until expiry

#### Scenario: All table work completes
- **WHEN** every represented table work item is marked complete
- **THEN** the spool MUST transactionally remove the completed batch and its work records

### Requirement: Health reports acceptance capacity separately from ClickHouse drainage

Health MUST expose spool writability, queued batches, queued table work, accounted bytes, oldest age, terminal/expired work, and a bounded last-error class. ClickHouse unavailability with a healthy spool MUST return HTTP 200 with degraded status; an unhealthy spool MUST return HTTP 503.

#### Scenario: ClickHouse is down and spool is healthy
- **WHEN** the health endpoint cannot ping ClickHouse but can validate spool writability
- **THEN** it MUST return HTTP 200 and report degraded drainage with durable admission available

#### Scenario: Spool is unhealthy
- **WHEN** the health endpoint cannot validate the spool
- **THEN** it MUST return HTTP 503 even if ClickHouse is reachable

### Requirement: Durable acceptance emits bounded operational telemetry

The forwarder MUST record bounded-cardinality counters and gauges for admitted/rejected strategy batches and rows, quota rejections, spool failures, pending work, accounted bytes, oldest age, retry attempts, table completions, terminal failures, expirations, and last successful drain.

#### Scenario: Retry telemetry is emitted
- **WHEN** one table work item is rescheduled
- **THEN** retry metrics MUST use only approved table and bounded error-class labels

#### Scenario: Untrusted request values are submitted
- **WHEN** a client supplies arbitrary source, table, deployment, or error text
- **THEN** unbounded values MUST NOT become persistent metric labels

### Requirement: CI proves the durability and ClickHouse contract

Required CI MUST run the legacy/v1/v2/mixed/unknown/missing-identity/all-five-table matrix, SQLite quota/expiry/restart/corruption/write-failure/partial-retry tests, and real ClickHouse 24.8 schema/insert/deduplication tests. ClickHouse integration tests MUST fail rather than skip when the required CI service is unavailable.

#### Scenario: ClickHouse service is missing in CI
- **WHEN** the mandatory integration job cannot reach ClickHouse 24.8
- **THEN** the job MUST fail

#### Scenario: Durable fault matrix passes
- **WHEN** repository CI completes successfully
- **THEN** it MUST provide evidence for quota, retention, restart recovery, partial retry isolation, spool failure, and deduplicated real inserts

### Requirement: Release evidence closes the cross-service contract

CEX Broker and Maker completion MUST reference a published CEX Broker package and image with the same unused patch version above `0.2.36`, an immutable image digest, the CEX PR and required Actions evidence, Maker's updated dependency and lockfile, and strict validation in both repositories.

#### Scenario: CEX conformance release is published
- **WHEN** the CEX implementation and required CI pass
- **THEN** package and image evidence MUST identify the same version and immutable digest

#### Scenario: Maker task 8.6 is completed
- **WHEN** Maker consumes the conformance release and its strict checks pass
- **THEN** its OpenSpec evidence MUST record the CEX commit/PR/Actions/version/digest and task 8.6 MAY be marked complete

#### Scenario: Production observation has not run
- **WHEN** repository conformance is complete but FIET-937's observation window remains pending
- **THEN** this change MAY complete while FIET-937 continues to block deployment cutover

