## MODIFIED Requirements

### Requirement: Archive source identity is deployment controlled
The archive plane SHALL support broker deployment source identities
`broker_read` and `broker_write` plus the bounded-tool producer identity
`external_backfill`. `broker_read` and `broker_write` MUST be selected from
immutable broker deployment configuration and propagated consistently to every
row and batch envelope. `external_backfill` MUST be constructible only by the
dedicated market-data backfill capture path and MUST NOT be accepted as
`CEX_BROKER_ARCHIVE_SOURCE` for the normal broker writer. Archive source SHALL
remain producer-role provenance, while vendor identity SHALL remain in
`provider`; source SHALL NOT determine whether the full broker exposes its gRPC
service.

#### Scenario: Read broker archives a market frame
- **WHEN** a broker configured with archive source `broker_read` archives a market-data frame
- **THEN** every normalized row and its archive envelope MUST contain `source = "broker_read"`
- **AND** clients MUST NOT be able to override that source through request fields or metadata

#### Scenario: Envelope and row sources disagree
- **WHEN** an archive batch contains a row whose source differs from the envelope source
- **THEN** the archive forwarder MUST reject the inconsistent batch or row before ClickHouse insertion
- **AND** it MUST emit a bounded diagnostic without exposing credentials or raw secrets

#### Scenario: FIET-901 production capture uses the read archive source
- **WHEN** deployment verification evaluates the broker/archiver hosting FIET-901 continuous production subscriptions
- **THEN** it MUST require archive source `broker_read`, an explicit deployment identity, and an explicit capture bundle before declaring the deployment ready
- **AND** the core broker MUST NOT infer or enforce that deployment role from subscription traffic
- **AND** unrelated TEE or write-broker deployments MAY continue to archive their own market observations as `broker_write`

#### Scenario: Bounded backfill constructs external provenance
- **WHEN** the dedicated backfill core canonicalizes a supported vendor dataset
- **THEN** its rows and forwarder envelope MUST use `source = "external_backfill"`
- **AND** the provider field MUST identify the vendor independently
- **AND** normal broker configuration MUST reject `external_backfill` as a deployment source

### Requirement: Capture output is replay-consumable
The system SHALL prove that canonical ClickHouse rows can be selected by
exchange, pair, capture bundle, and replay window and converted into
Maker-compatible inputs without losing source identity or checksum
verifiability. Broker-origin canonical rows retain their existing replay
eligibility. External-backfill rows MUST be selected for replay only through
qualification-aware views after a passing promotion record binds their exact
capture scope.

#### Scenario: Replay selects a capture window
- **WHEN** a replay consumer queries one or more eligible capture bundles for an exchange, pair, and time window
- **THEN** the query MUST return only matching source-time rows
- **AND** every returned normalized row MUST retain enough metadata to verify its capture linkage and checksum

#### Scenario: Unqualified external capture is queried
- **WHEN** an external-backfill bundle has physical canonical rows but no passing
  promotion record
- **THEN** replay-qualified readers and exporters MUST return none of those rows
- **AND** operational verification MAY still query the physical and unqualified
  canonical evidence by capture identity

#### Scenario: Cross-language contract fixture is validated
- **WHEN** CI runs the broker-to-Maker replay contract fixtures
- **THEN** the ClickHouse row projection and Maker reader MUST agree on field semantics, timestamps, source modes, and checksum values

#### Scenario: FIET-907 materializes Parquet fixtures
- **WHEN** the retained reference exporter produces Maker-compatible fixtures
- **THEN** it MUST query qualification-aware canonical ClickHouse views directly without calling the broker or a connected exchange
- **AND** fixture materialization, coverage, and replay-bundle assembly MUST remain FIET-907 consumer-side ownership

## ADDED Requirements

### Requirement: Capture origin is distinct from producer admission source
Order-book capture rows SHALL retain `source = external_backfill` as the bounded
producer/admission role and SHALL add `capture_origin = production_capture |
vendor_historical_backfill`. The vendor source mode SHALL be
`vendor_historical_backfill_v1`. Existing immutable rows SHALL derive a
deterministic origin from `source` without changing their existing checksums.

#### Scenario: Existing row lacks explicit origin
- **WHEN** an existing broker-origin or provisional external row is read
- **THEN** its origin MUST be derived deterministically from immutable `source`
- **AND** existing row and capture-bundle checksums MUST remain unchanged

#### Scenario: Provisional vendor row is inspected
- **WHEN** a row uses the superseded provisional vendor source mode or receipt
- **THEN** it MUST remain auditable
- **AND** it MUST NOT qualify under the final v1 contract without a new explicit qualification event

### Requirement: External historical capture provenance is generic and reproducible
Every external-backfill order-book row SHALL identify the content-addressed
capture bundle, dedicated tool deployment/product identity, exchange, trading
pair and source symbol, market type, provider, ORDERBOOK feed, versioned
historical-vendor source mode, provider source and received timestamps,
`vendor_normalized_dataset_file` raw-capture scope, dataset/object checksum,
canonical schema version, checksum algorithm, and normalized-row checksum.

#### Scenario: Vendor-normalized data is the earliest retained evidence
- **WHEN** the provider supplies normalized dataset files rather than exchange
  wire frames
- **THEN** raw-capture scope MUST state `vendor_normalized_dataset_file`
- **AND** the archive MUST NOT claim exchange-wire provenance
- **AND** the promotion receipt MUST bind the contributing dataset object
  identities and checksums
