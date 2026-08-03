## ADDED Requirements

### Requirement: Strategy runtime requests use a closed envelope contract

The archive forwarder MUST accept a strategy runtime request only when its non-empty envelope source is `hb_runtime`, its deployment id is non-empty, it contains between one and 1000 rows, and every row targets an approved strategy runtime table.

The approved table set SHALL be exactly `strategy_data.policy_evaluation_events`, `strategy_data.strategy_policy_snapshots`, `strategy_data.market_identity`, `strategy_data.symbol_mapping`, and `strategy_data.inventory_settlement_events`.

#### Scenario: All five strategy tables are submitted
- **WHEN** one `hb_runtime` envelope contains conforming rows for all five approved tables
- **THEN** the request MUST pass strategy contract validation

#### Scenario: Strategy and non-strategy rows are mixed
- **WHEN** an `hb_runtime` envelope contains an approved strategy table and any non-strategy table
- **THEN** the entire request MUST be rejected with HTTP 400 before durable admission or ClickHouse insertion

#### Scenario: Strategy table uses another source
- **WHEN** an envelope under `broker_read`, `broker_write`, or another source targets an approved strategy table
- **THEN** the entire request MUST be rejected with HTTP 400

#### Scenario: Envelope identity is empty
- **WHEN** source or deployment id is missing, empty, or whitespace-only
- **THEN** the request MUST be rejected with HTTP 400

### Requirement: Strategy schema versions are validated before ownership

Each strategy row MUST use a missing/empty legacy version, version `1`, or version `2`. Unknown versions MUST be rejected with HTTP 400 before the forwarder accepts ownership.

Version `2` rows MUST contain non-empty `producer_id`, `producer_run_id`, `stream_name`, and `archive_event_id`, and positive UInt64-compatible integer `stream_seq` and `seq` values.

#### Scenario: Legacy schema version is omitted
- **WHEN** a conforming strategy row omits `schema_version` or supplies an empty value
- **THEN** the forwarder MUST admit it under the legacy compatibility contract

#### Scenario: Version one row is submitted
- **WHEN** a conforming strategy row supplies `schema_version=1`
- **THEN** the forwarder MUST admit it without requiring v2 producer and stream fields

#### Scenario: Version two identity is complete
- **WHEN** a version `2` row supplies every required producer, stream, event, and sequence identity
- **THEN** the forwarder MUST admit it

#### Scenario: Version two identity is incomplete
- **WHEN** any required v2 identity is blank, missing, non-integral, zero, negative, or outside UInt64 range
- **THEN** the entire request MUST be rejected with HTTP 400

#### Scenario: Unknown version is submitted
- **WHEN** a strategy row supplies any schema version other than legacy/empty, `1`, or `2`
- **THEN** the entire request MUST be rejected with HTTP 400

### Requirement: Envelope and row provenance agree

When a strategy row supplies `source` or `deployment_id`, its value MUST equal the corresponding envelope value. Credentials and broker configuration MUST NOT supply or override these Maker identities.

#### Scenario: Row source differs from envelope
- **WHEN** a row declares a source other than the envelope source
- **THEN** the entire request MUST be rejected before admission

#### Scenario: Row deployment differs from envelope
- **WHEN** a row declares a deployment id other than the envelope deployment id
- **THEN** the entire request MUST be rejected before admission

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

The CEX Broker contract fixture MUST equal the pinned Maker `archive_forwarder_envelope.json` and contract tests MUST validate every fixture row without local field translation.

#### Scenario: Pinned Maker fixture is checked in CEX Broker
- **WHEN** the cross-repository contract test runs
- **THEN** it MUST prove fixture equality and successful v2 validation

#### Scenario: Fixture contract drifts
- **WHEN** Maker or CEX changes a table, schema version, or required identity without the matching repository change
- **THEN** a required contract check MUST fail

### Requirement: Non-strategy archive behavior remains compatible

Requests that contain no strategy table and do not use `hb_runtime` MUST retain the existing direct ClickHouse insertion and synchronous success/failure contract.

#### Scenario: Broker market rows are submitted
- **WHEN** a valid `broker_read` or `broker_write` request contains only supported non-strategy rows
- **THEN** the forwarder MUST insert them through the existing direct path and MUST NOT consume strategy spool quota
