# strategy-runtime-archive-ingestion Specification

## Purpose

Define the closed FIET Maker strategy envelope, versioned producer identity, provenance validation, and distinct durable-runtime versus synchronous-replay persistence contracts used by the archive-forwarder.

## Requirements

### Requirement: Strategy runtime requests use a closed envelope contract

The archive forwarder MUST accept a strategy request only when its non-empty envelope source belongs to exactly the admitted producer set `{hb_runtime, maker_orchestrator, maker_replay}`, its deployment id is non-empty, it contains between one and 1000 rows, and every row targets an approved strategy table. The selected source MUST remain the truthful producer mode and MUST NOT be inferred, rewritten, or promoted by broker, credential, deployment, or spool configuration.

The approved table set SHALL be exactly `strategy_data.policy_evaluation_events`, `strategy_data.strategy_policy_snapshots`, `strategy_data.market_identity`, `strategy_data.symbol_mapping`, and `strategy_data.inventory_settlement_events`.

Conforming batches from either live runtime producer (`hb_runtime`, `maker_orchestrator`) MUST enter the same durable strategy-spool ownership path and return HTTP 202 without direct synchronous ClickHouse insertion.

#### Scenario: All five strategy tables are submitted
- **WHEN** one `hb_runtime`, `maker_orchestrator`, or `maker_replay` envelope contains conforming rows for all five approved tables
- **THEN** the request MUST pass the common strategy contract validation before its source-specific persistence path is selected

#### Scenario: Maker orchestrator strategy rows are submitted
- **WHEN** one `maker_orchestrator` envelope contains conforming rows for an approved strategy table
- **THEN** the request MUST pass strategy contract validation

#### Scenario: Either live runtime producer transfers durable ownership
- **WHEN** a conforming `hb_runtime` or `maker_orchestrator` strategy envelope is submitted
- **THEN** the forwarder MUST durably admit it to the strategy spool and return HTTP 202 without direct ClickHouse insertion

#### Scenario: Strategy and non-strategy rows are mixed
- **WHEN** a reserved strategy-source envelope contains an approved strategy table and any non-strategy table
- **THEN** the entire request MUST be rejected with HTTP 400 before durable admission or ClickHouse insertion

#### Scenario: Strategy table uses another source
- **WHEN** an envelope under `broker_read`, `broker_write`, or any source outside the admitted producer set targets an approved strategy table
- **THEN** the entire request MUST be rejected with HTTP 400

#### Scenario: Reserved strategy source contains no strategy table
- **WHEN** an envelope from any admitted strategy producer contains only non-strategy rows
- **THEN** the entire request MUST be rejected with HTTP 400
- **AND** it MUST NOT fall through to the generic synchronous archive path

#### Scenario: Envelope identity is empty
- **WHEN** source or deployment id is missing, empty, or whitespace-only
- **THEN** the request MUST be rejected with HTTP 400

### Requirement: Strategy schema versions are validated before ownership

Each `hb_runtime` and `maker_replay` strategy row MUST use a missing/empty legacy version, version `1`, or version `2`. Unknown versions MUST be rejected with HTTP 400 before source-specific path selection. Version validation alone MUST NOT imply durable ownership: only a validated `hb_runtime` batch that commits to SQLite is admitted, while validated `maker_replay` proceeds to synchronous insertion.

Version `2` rows under either source MUST contain non-empty `producer_id`, `producer_run_id`, `stream_name`, and `archive_event_id`, and positive UInt64-compatible integer `stream_seq` and `seq` values.

#### Scenario: Legacy schema version is omitted
- **WHEN** a conforming row under either accepted strategy source omits `schema_version` or supplies an empty value
- **THEN** the forwarder MUST validate it under the legacy compatibility contract before selecting the source-specific persistence path

#### Scenario: Version one row is submitted
- **WHEN** a conforming row under either accepted strategy source supplies `schema_version=1`
- **THEN** the forwarder MUST validate it without requiring v2 producer and stream fields

#### Scenario: Version two identity is complete
- **WHEN** a version `2` row under either accepted strategy source supplies every required producer, stream, event, and sequence identity
- **THEN** the row MUST pass shared strategy validation before path selection

#### Scenario: Maker replay version two identity is incomplete
- **WHEN** a `maker_replay` version `2` row has a required identity that is blank, missing, non-integral, zero, negative, or outside UInt64 range
- **THEN** the entire request MUST be rejected with HTTP 400 before direct insertion
- **AND** the strategy spool MUST remain unchanged

#### Scenario: Live runtime version two identity is incomplete
- **WHEN** an `hb_runtime` version `2` row has a required identity that is blank, missing, non-integral, zero, negative, or outside UInt64 range
- **THEN** the entire request MUST be rejected with HTTP 400 before spool admission

#### Scenario: Unknown version is submitted
- **WHEN** a strategy row under either accepted source supplies any schema version other than legacy/empty, `1`, or `2`
- **THEN** the entire request MUST be rejected with HTTP 400 before persistence

### Requirement: Envelope and row provenance agree

For every admitted strategy producer, when a strategy row supplies `source` or `deployment_id`, its value MUST equal the corresponding envelope value before source-specific path selection. Credentials and broker configuration MUST NOT supply, infer, override, or promote these producer identities.

#### Scenario: Maker replay row source differs from envelope
- **WHEN** a `maker_replay` row declares a source other than its envelope source
- **THEN** the entire request MUST be rejected before direct insertion
- **AND** the spool and ClickHouse MUST remain unchanged for that request

#### Scenario: Row source differs across live runtime producers
- **WHEN** an `hb_runtime` envelope contains a row declaring `maker_orchestrator`, or a `maker_orchestrator` envelope contains a row declaring `hb_runtime`
- **THEN** the entire request MUST be rejected before spool admission

#### Scenario: Row deployment differs from envelope
- **WHEN** a row under either accepted strategy source declares a deployment id other than the envelope deployment id
- **THEN** the entire request MUST be rejected before admission or direct insertion

### Requirement: Strategy tables implement the pinned additive schema

All five strategy tables MUST expose compatibility-defaulted `producer_id`, `producer_run_id`, `stream_name`, `stream_seq`, `seq`, and `archive_event_id` columns. Policy rows MUST expose the pinned policy decision fields, and policy snapshots, market identity, and symbol mapping MUST expose the pinned content/revision/market mapping fields.

DDL upgrades MUST use additive idempotent migration statements so existing v1 data remains readable and a new deployment writes the latest schema.

#### Scenario: Existing v1 tables are upgraded
- **WHEN** schema initialization runs against strategy tables created by the prior release
- **THEN** every pinned v2 column MUST be added without rewriting or dropping historical rows

#### Scenario: Fresh strategy database is initialized
- **WHEN** schema initialization runs on an empty ClickHouse 24.8 database
- **THEN** all five tables MUST be insert-compatible with the pinned Maker v2 rows

### Requirement: The Maker fixture is the cross-repository wire evidence

The existing CEX Broker contract fixture MUST remain byte-equivalent to Maker's pinned `archive_forwarder_envelope.json` for the `hb_runtime` v2 wire contract, and contract tests MUST validate every fixture row without local field translation. `maker_replay` MUST use the same approved tables, row fields, schema versions, and v2 identity rules, but a source-adjusted CEX replay test fixture MUST NOT be represented as byte-equivalent Maker evidence unless Maker publishes a corresponding replay fixture.

#### Scenario: Pinned live-runtime Maker fixture is checked
- **WHEN** the cross-repository contract test runs
- **THEN** it MUST prove fixture equality and successful `hb_runtime` v2 validation
- **AND** the validated batch MUST remain eligible only for the durable path

#### Scenario: Replay fixture shares the row contract
- **WHEN** CEX tests construct or load a `maker_replay` batch from the same versioned row field contract
- **THEN** every row MUST pass the same schema and provenance validation without local field translation beyond the explicitly different source/run values
- **AND** the test MUST not claim Maker fixture equality unless a pinned Maker replay fixture exists

#### Scenario: Fixture contract drifts
- **WHEN** Maker or CEX changes a table, schema version, or required identity without the matching repository change
- **THEN** a required contract check MUST fail

### Requirement: Non-strategy archive behavior remains compatible

Requests that contain no strategy table and do not use any admitted strategy producer (`hb_runtime`, `maker_orchestrator`, or `maker_replay`) MUST retain the existing direct ClickHouse insertion and synchronous success/failure contract.

#### Scenario: Broker market rows are submitted
- **WHEN** a valid `broker_read` or `broker_write` request contains only supported non-strategy rows
- **THEN** the forwarder MUST insert them through the existing direct path and MUST NOT consume strategy spool quota

#### Scenario: Broker non-strategy insert fails
- **WHEN** direct ClickHouse insertion fails for a valid broker market, account, or execution request
- **THEN** the forwarder MUST report synchronous failure under the existing contract
- **AND** it MUST NOT durably admit the request to the strategy spool

### Requirement: Strategy source selects one closed persistence and acknowledgement contract

`hb_runtime` and `maker_orchestrator` SHALL remain the one-attempt live runtime sources: each valid batch MUST be durably admitted to the configured SQLite strategy spool before HTTP 202 and MUST drain asynchronously as isolated per-table work with stable ClickHouse deduplication tokens. `maker_replay` SHALL remain a bounded offline source: each valid batch MUST insert through the direct ClickHouse path, return HTTP 200 only after all inserts succeed, return HTTP 500 on insertion failure, and consume no spool quota.

#### Scenario: Live runtime batch is valid
- **WHEN** a conforming `hb_runtime` batch is received while the spool is writable and within quota
- **THEN** the forwarder MUST return HTTP 202 after atomic durable admission without waiting for ClickHouse
- **AND** completion MUST remain observable separately through spool drainage and queried ClickHouse rows

#### Scenario: Live runtime spool is unavailable
- **WHEN** a conforming `hb_runtime` batch cannot be durably admitted because the spool is absent, corrupt, read-only, or over quota
- **THEN** the forwarder MUST return the existing typed 503 or 429 rejection
- **AND** it MUST NOT fall back to direct insertion or acknowledge ownership

#### Scenario: Maker replay batch is valid
- **WHEN** a conforming `maker_replay` batch is received and direct ClickHouse insertion succeeds
- **THEN** the forwarder MUST return HTTP 200 with the synchronous insert result
- **AND** the spool's accounted bytes, queued batches, and queued table work MUST remain unchanged

#### Scenario: Maker replay insertion fails
- **WHEN** direct ClickHouse insertion of a conforming `maker_replay` batch fails for any represented strategy table
- **THEN** the forwarder MUST return HTTP 500 and MUST NOT report durable acceptance
- **AND** the producer MAY replay the bounded batch under its own run recovery policy

#### Scenario: Replay source is promoted to runtime
- **WHEN** a component attempts to rewrite `maker_replay` as `hb_runtime` to gain spool semantics or runtime classification
- **THEN** provenance verification MUST fail
- **AND** no inferred or rewritten source may be persisted

### Requirement: Replay and runtime strategy telemetry remain distinguishable and bounded

Durable `hb_runtime` admission, rejection, spool, retry, completion, terminal, expiry, and drain metrics SHALL retain their existing semantics and MUST NOT count `maker_replay`. Synchronous replay SHALL expose fixed counters for successfully inserted replay batches and rows plus replay insertion failures. All replay labels MUST be limited to approved strategy tables and bounded error classes; request-supplied source, deployment, producer, stream, event, or error text MUST NOT become metric labels.

#### Scenario: Maker replay insert succeeds
- **WHEN** a valid replay batch is inserted synchronously
- **THEN** replay batch and row success counters MUST increase
- **AND** runtime admission, spool, and drain metrics MUST remain unchanged

#### Scenario: Maker replay insert fails
- **WHEN** a replay table insert fails
- **THEN** a replay failure counter MUST use only the approved table and bounded error-class labels
- **AND** untrusted request values or raw error text MUST NOT become persistent metric labels

#### Scenario: Live runtime batch is admitted and drained
- **WHEN** an `hb_runtime` batch commits to the spool and later completes
- **THEN** existing runtime admission and drainage telemetry MUST increase
- **AND** replay success/failure counters MUST remain unchanged
