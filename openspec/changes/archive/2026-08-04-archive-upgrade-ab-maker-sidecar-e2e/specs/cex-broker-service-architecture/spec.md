## ADDED Requirements

### Requirement: Test compositions are distinct from deployable services

`SERVICES_ARCHITECTURE.md` SHALL document the archive A/B harness and Maker archive-conformance sidecar as bounded test/operator compositions rather than repository-owned production services. It MUST identify their process members, lifecycle commands, external dependencies, persistence, intended audience, failure behavior, and cleanup ownership without implying that a normal broker deployment requires them.

#### Scenario: Reader inspects the conformance sidecar
- **WHEN** a reader compares the sidecar composition with the full broker, collector, and archive-forwarder
- **THEN** the document MUST state that the sidecar orchestrates those production components for deterministic tests but is not itself a production service
- **AND** it MUST link to the detailed E2E and cross-repository runbook

#### Scenario: Reader selects a minimal broker deployment
- **WHEN** the reader needs only the normal third-party gRPC broker
- **THEN** the architecture MUST continue to show that archival configuration, collector, archive-forwarder, ClickHouse, A/B harness, and sidecar are optional
- **AND** the broker MUST not be documented as failing startup when those components or settings are absent

### Requirement: Migration and replay tools retain direct ClickHouse boundaries

The architecture authority SHALL distinguish the legacy-to-canonical database migration, replay validators, and Parquet exporters from live broker capture and archive-forwarder ingestion. It MUST state that these bounded tools access ClickHouse directly, that the migration is table-to-table/database-to-database rather than CEX credential backfill, and that Parquet materialization is a FIET-907 consumer concern.

#### Scenario: Reader inspects the migration
- **WHEN** a reader follows the A/B upgrade flow
- **THEN** the document MUST show `develop` DDL/data initialization followed by direct ClickHouse schema and table migration on the B-side
- **AND** it MUST not show the migration reconnecting to an exchange or loading file-based market backfill

#### Scenario: Reader inspects the Parquet exporter
- **WHEN** a reader follows native Maker replay preparation
- **THEN** the document MUST show the retained reference exporter querying canonical ClickHouse tables directly and label it as a FIET-907 compatibility tool
- **AND** it MUST leave full fixture materialization, coverage, and replay-bundle assembly outside live CEX Broker service ownership

### Requirement: Maker profiles document truthful runtime boundaries

The architecture authority SHALL document native replay and production-compatible Maker integration as separate profiles. Native replay MUST show ClickHouse-to-FIET-907-to-Parquet consumption and `maker_replay` reporting without claiming a live broker connection. The production-compatible profile MUST show the Layer 12 runtime using the normal broker gRPC boundary and `hb_runtime` using the durable archive spool, while the collector independently keeps archival subscriptions alive.

#### Scenario: Reader inspects native emulation
- **WHEN** the reader follows the native Hummingbot backtest data flow
- **THEN** the architecture MUST state that the runtime is offline and consumes materialized replay fixtures
- **AND** it MUST distinguish its synchronous `maker_replay` reports from live `hb_runtime` durable acceptance

#### Scenario: Reader inspects production-compatible Maker
- **WHEN** the reader follows the Layer 12 live/sandbox flow
- **THEN** the architecture MUST identify Maker as the third-party broker client and the collector as a separate internal keep-alive subscriber
- **AND** it MUST show HTTP 202 spool admission and later ClickHouse drainage as distinct events

### Requirement: Cross-repository conformance ownership is explicit

The architecture and linked runbook SHALL assign CEX Broker ownership of the sidecar service composition, schemas, migration, archive contracts, and verifier, and FIET Maker ownership of its `develop`-based orchestration, runtime/materializer invocation, and Maker-specific assertions. Both sides MUST record resolved commits in shared evidence rather than depending on an unpinned branch name.

#### Scenario: Cross-repository job is maintained
- **WHEN** either repository changes a wire field, schema version, source contract, sidecar interface, or required assertion
- **THEN** the documented owner MUST update its implementation and coordinate the pinned cross-repository evidence
- **AND** copied schemas or duplicate CEX service orchestration in Maker MUST not become an alternative authority

#### Scenario: Production observation is considered
- **WHEN** deterministic sidecar conformance is used to close this change
- **THEN** the architecture MUST state that production soak is outside this change's definition of done
- **AND** it MUST not describe deterministic CI as production observation
