## MODIFIED Requirements

### Requirement: Accepted Maker batches are durable before acknowledgement

For this capability, an accepted Maker batch means only a validated `source=hb_runtime` envelope containing approved strategy tables. The forwarder MUST atomically persist that envelope and one pending work item per represented strategy table before returning HTTP 202. It MUST NOT acknowledge acceptance when the spool transaction has not committed, and it MUST NOT apply this ownership contract to `maker_replay`.

#### Scenario: Live strategy batch is durably admitted
- **WHEN** a conforming `hb_runtime` batch commits to the SQLite spool
- **THEN** the forwarder MUST return HTTP 202 without waiting for ClickHouse

#### Scenario: ClickHouse is unavailable during live admission
- **WHEN** ClickHouse is unavailable but the spool is writable and within quota
- **THEN** the forwarder MUST still durably admit the `hb_runtime` batch and return HTTP 202

#### Scenario: Spool is unavailable
- **WHEN** the spool cannot open, write, or commit a conforming `hb_runtime` batch
- **THEN** the forwarder MUST return HTTP 503 and MUST NOT claim ownership

#### Scenario: Replay batch is received
- **WHEN** a conforming `maker_replay` strategy batch reaches the forwarder
- **THEN** this durable-acceptance requirement MUST NOT apply and HTTP 202 MUST NOT be returned
- **AND** the request MUST use the synchronous strategy replay contract

### Requirement: Durable acceptance emits bounded operational telemetry

The forwarder MUST record bounded-cardinality counters and gauges for admitted/rejected `hb_runtime` strategy batches and rows, quota rejections, spool failures, pending work, accounted bytes, oldest age, retry attempts, table completions, terminal failures, expirations, and last successful drain. These durable-acceptance metrics MUST exclude `maker_replay`; replay direct-insert telemetry is owned by the strategy ingestion contract.

#### Scenario: Live retry telemetry is emitted
- **WHEN** one `hb_runtime` table work item is rescheduled
- **THEN** retry metrics MUST use only approved table and bounded error-class labels
- **AND** no replay counter may be incremented

#### Scenario: Untrusted request values are submitted
- **WHEN** a client supplies arbitrary source, table, deployment, producer, stream, or error text
- **THEN** unbounded values MUST NOT become persistent metric labels

#### Scenario: Replay is inserted directly
- **WHEN** a `maker_replay` batch succeeds or fails through synchronous insertion
- **THEN** spool admission, pending-work, quota, retry, completion, expiry, and drain metrics MUST remain unchanged
- **AND** only the bounded replay telemetry defined by strategy ingestion may change

## ADDED Requirements

### Requirement: Replay strategy traffic never consumes durable spool ownership

`maker_replay` batches SHALL remain outside the SQLite ownership boundary. Their validation and synchronous insertion MUST create no spool batch, table work item, accounted byte, retention record, retry schedule, deduplication token, terminal work, or expiry record.

#### Scenario: Replay succeeds while spool contains runtime work
- **WHEN** a valid `maker_replay` batch is inserted while unrelated `hb_runtime` work is pending
- **THEN** the replay request MUST return its synchronous result without changing any spool state
- **AND** the unrelated runtime work MUST retain its original ownership and schedule

#### Scenario: Replay insertion fails
- **WHEN** direct ClickHouse insertion fails for `maker_replay`
- **THEN** the forwarder MUST return synchronous failure without admitting or retrying the batch in SQLite
- **AND** the replay producer retains retry ownership
