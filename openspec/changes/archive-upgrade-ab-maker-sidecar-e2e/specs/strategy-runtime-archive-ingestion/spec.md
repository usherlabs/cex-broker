## MODIFIED Requirements

### Requirement: Strategy runtime requests use a closed envelope contract

The archive forwarder MUST accept a strategy request only when its non-empty envelope source is exactly `hb_runtime` or `maker_replay`, its deployment id is non-empty, it contains between one and 1000 rows, and every row targets an approved strategy table. The selected source MUST remain the truthful producer mode and MUST NOT be inferred, rewritten, or promoted by broker, credential, deployment, or spool configuration.

The approved table set SHALL be exactly `strategy_data.policy_evaluation_events`, `strategy_data.strategy_policy_snapshots`, `strategy_data.market_identity`, `strategy_data.symbol_mapping`, and `strategy_data.inventory_settlement_events`.

#### Scenario: All five strategy tables are submitted
- **WHEN** one `hb_runtime` or `maker_replay` envelope contains conforming rows for all five approved tables
- **THEN** the request MUST pass the common strategy contract validation before its source-specific persistence path is selected

#### Scenario: Strategy and non-strategy rows are mixed
- **WHEN** a reserved strategy-source envelope contains an approved strategy table and any non-strategy table
- **THEN** the entire request MUST be rejected with HTTP 400 before durable admission or ClickHouse insertion

#### Scenario: Strategy table uses another source
- **WHEN** an envelope under `broker_read`, `broker_write`, or any source other than `hb_runtime` or `maker_replay` targets an approved strategy table
- **THEN** the entire request MUST be rejected with HTTP 400

#### Scenario: Reserved strategy source contains no strategy table
- **WHEN** an `hb_runtime` or `maker_replay` envelope contains only non-strategy rows
- **THEN** the entire request MUST be rejected with HTTP 400
- **AND** it MUST NOT fall through to the generic synchronous archive path

#### Scenario: Envelope identity is empty
- **WHEN** source or deployment id is missing, empty, or whitespace-only
- **THEN** the request MUST be rejected with HTTP 400

### Requirement: Non-strategy archive behavior remains compatible

Requests that contain no strategy table and do not use either reserved strategy source (`hb_runtime` or `maker_replay`) MUST retain the existing direct ClickHouse insertion and synchronous success/failure contract.

#### Scenario: Broker market rows are submitted
- **WHEN** a valid `broker_read` or `broker_write` request contains only supported non-strategy rows
- **THEN** the forwarder MUST insert them through the existing direct path and MUST NOT consume strategy spool quota

#### Scenario: Broker non-strategy insert fails
- **WHEN** direct ClickHouse insertion fails for a valid broker market, account, or execution request
- **THEN** the forwarder MUST report synchronous failure under the existing contract
- **AND** it MUST NOT durably admit the request to the strategy spool

## ADDED Requirements

### Requirement: Strategy source selects one closed persistence and acknowledgement contract

`hb_runtime` SHALL remain the one-attempt live runtime source: each valid batch MUST be durably admitted to the configured SQLite strategy spool before HTTP 202 and MUST drain asynchronously as isolated per-table work with stable ClickHouse deduplication tokens. `maker_replay` SHALL remain a bounded offline source: each valid batch MUST insert through the direct ClickHouse path, return HTTP 200 only after all inserts succeed, return HTTP 500 on insertion failure, and consume no spool quota.

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
