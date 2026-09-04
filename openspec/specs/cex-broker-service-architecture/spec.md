# cex-broker-service-architecture Specification

## Purpose

Define the authoritative service, tool, dependency, and deployment boundaries for the CEX Broker repository.
## Requirements
### Requirement: Repository services have one architectural authority

The repository SHALL maintain a root `SERVICES_ARCHITECTURE.md` that describes the current process boundaries and uniformly identifies each repository-owned service's purpose, entrypoint, audience, interfaces, credentials, dependencies, persistence, deployment requirement, and failure behavior.

#### Scenario: Operator evaluates a deployment

- **WHEN** an operator needs to deploy the broker, collector, archive-forwarder, or research service
- **THEN** the architecture document MUST identify whether the component is public, internal, operator-only, or research-only
- **AND** it MUST link to the component's detailed operational documentation rather than duplicate every configuration setting

### Requirement: Service and tool boundaries are explicit

The service architecture SHALL distinguish long-running services from examples, migrations, exporters, replay validators, and libraries, and SHALL identify externally owned dependencies and producers without presenting them as CEX Broker services. It SHALL distinguish logical broker clients from broker-owned physical public-feed workers and archive paths.

#### Scenario: Reader inspects the collector

- **WHEN** a reader compares the full broker and market-data collector
- **THEN** the document MUST state that third-party integrations use the full broker while the collector keeps configured logical subscriptions alive for capture coverage and liveness
- **AND** it MUST state that continuous capture requires the collector or an equivalent persistent subscriber
- **AND** it MUST NOT present a single collector instance as necessary to prevent duplicate physical exchange watches or archive captures, because the full broker owns canonical feed sharing

#### Scenario: Reader compares collector and Maker subscriptions

- **WHEN** the collector and Maker subscribe to the same canonical public feed, including ORDERBOOK options that resolve to a compatible venue acquisition profile
- **THEN** the document MUST show two independent logical gRPC subscriptions attached to one broker-owned physical exchange watcher and archive path
- **AND** it MUST preserve the collector's liveness responsibility and Maker's third-party client boundary

#### Scenario: Reader inspects ORDERBOOK depth handling

- **WHEN** a reader compares compatible and incompatible ORDERBOOK requests
- **THEN** the document MUST show subscriber depth as a projection after venue acquisition-profile resolution rather than a universal physical key rule
- **AND** it MUST show conservative separate workers for absent or inactive candidates, explicitly enabled candidate profiles for controlled Binance/MEXC evidence, and an empty production enabled-profile set pending a later activation change

#### Scenario: Reader inspects cross-repository verification ownership

- **WHEN** a reader follows the Binance/MEXC coalescing verification gate
- **THEN** the document MUST assign broker payload/archive equality, band coverage, replay sufficiency, the 25-level negative, reduced physical work, and Proof A publication to CEX Broker
- **AND** it MUST assign real Layer 12 policy evaluation and hash-bound Proof B production to the separate FIET Maker workstream
- **AND** it MUST assign broker topology, collector/Maker overlap, durable spool drainage, and ClickHouse delivery to CEX-owned Proof C
- **AND** it MUST state that production activation is a later CEX change rather than an automatic consequence of any artifact being present

#### Scenario: Reader inspects ClickHouse clients

- **WHEN** a reader follows archive or research data flows
- **THEN** the document MUST distinguish the archive-forwarder's trusted write boundary from direct readers and externally owned metrics producers
- **AND** it MUST not imply that every ClickHouse client is routed through the archive-forwarder

### Requirement: Supported deployment profiles are documented

The service architecture SHALL document minimal broker, archived broker, continuous FIET-901 capture, and research-only deployment profiles with their required and optional components.

#### Scenario: Minimal broker deployment is selected

- **WHEN** an operator needs only the third-party gRPC integration surface
- **THEN** the document MUST show that the full broker can run without the collector, archive-forwarder, or ClickHouse
- **AND** it MUST explain that continuous archival is not provided by that minimal profile

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

CEX-owned migration and replay diagnostics SHALL operate directly against CEX-owned ClickHouse hot tables and SHALL remain separate from the live gRPC server. Service-owned operator, maintenance, replay, migration, and image-smoke tools SHALL live under `services/<service>/scripts/`; repository-wide, cross-service, release, E2E, and fixture-generation tools SHALL remain under root `scripts/`. Service-local operator scripts SHALL NOT be packaged into the production service image. CEX SHALL NOT proxy Maker historical data through a file exporter, preparation package, or runtime repository dependency.

#### Scenario: Reader distinguishes service-owned tooling from service runtime

- **WHEN** a reader inspects `services/archive-forwarder/scripts/`
- **THEN** the architecture SHALL identify those files as operator tools rather than archive-forwarder startup modules
- **AND** the production archive-forwarder image SHALL omit that scripts directory

#### Scenario: CEX diagnostic reads hot data directly

- **WHEN** a CEX operator runs a supported hot-archive diagnostic or migration tool
- **THEN** the tool SHALL query or mutate the named ClickHouse objects directly
- **AND** it SHALL NOT require Maker code, a Maker checkout, or a generated canonical Parquet artifact

#### Scenario: Downstream consumers own their own readers

- **WHEN** a downstream system consumes the CEX hot archive
- **THEN** it SHALL use the published ClickHouse schema/query contract independently
- **AND** CEX SHALL NOT provide a historical file handoff as a substitute for that reader

### Requirement: Maker profiles document truthful runtime boundaries

CEX documentation SHALL describe only the production-compatible Maker conformance profile that exercises shared live gRPC and durable strategy-write wires. It SHALL identify historical sourcing, reconstruction, policy equivalence, and replay materialization as Maker-owned behavior outside the CEX sidecar.

#### Scenario: Production-compatible profile is documented

- **WHEN** an operator reviews CEX-to-Maker conformance instructions
- **THEN** the documented sidecar profile SHALL be `production_compatible`
- **AND** its pass condition SHALL be the shared-wire Proof C result

#### Scenario: Thesis materialization is independent

- **WHEN** Maker materializes or replays a thesis
- **THEN** the documented workflow SHALL NOT require `--cex-repo`, a CEX package, a CEX executable, a sidecar result, or a CEX-generated Parquet file

### Requirement: Cross-repository conformance ownership is explicit

Cross-repository conformance SHALL follow only the shared wires. CEX SHALL own feed/coalescing Proof A in its local regression suite, Maker SHALL own policy-equivalence Proof B, and the production-compatible sidecar SHALL own shared live-and-durable-wire Proof C. Hot summary reader parity SHALL use the versioned summary-v2 fixture/query contract and MAY additionally use an optional cross-repository SQL compatibility job.

#### Scenario: Sidecar success does not aggregate unrelated proofs

- **WHEN** the production-compatible sidecar completes Proof C successfully
- **THEN** the sidecar SHALL succeed without executing or evaluating Proof A, Proof B, FIET-907 loaders, Maker replay policy, or canonical Parquet output

#### Scenario: Hot reader parity is independently testable

- **WHEN** a downstream repository validates its ClickHouse hot reader
- **THEN** it SHALL be able to pin or copy the versioned fixture and verify its digest
- **AND** it SHALL NOT need a running CEX sidecar or CEX runtime dependency

### Requirement: CEX Broker owns only the live hot market-data boundary

CEX Broker SHALL own live exchange acquisition, current/live broker RPCs, and policy-neutral ClickHouse hot writes. It SHALL NOT own vendor-object acquisition, historical reconstruction, source-tape or required-clock qualification, backtest preparation, Maker policy materialization, or FIET-907 sourcing.

#### Scenario: Live order-book behavior remains available

- **WHEN** a supported client requests the current ORDERBOOK snapshot or subscribes to live ORDERBOOK updates
- **THEN** CEX Broker SHALL serve the existing live gRPC contract
- **AND** an enabled archive deployment MAY persist one bounded hot observation for the physical live feed

#### Scenario: Historical preparation is outside the broker product

- **WHEN** an operator installs, packs, or runs the CEX Broker release
- **THEN** the release SHALL expose no vendor backfill, historical reconstruction, source-tape, required-clock, canonical Parquet, or Maker preparation executable, subpath, or service

### Requirement: Superseded internal boundaries use a hard cutover

When this repository supersedes an internal contract, it SHALL remove the obsolete implementation, writer, reader, schema alias, compatibility view, adapter, and documentation unless an operator has explicitly approved a backward-compatibility requirement. A repository instruction SHALL record this default.

#### Scenario: No implicit compatibility surface survives

- **WHEN** summary v2 and the live/hot ownership boundary become authoritative
- **THEN** reviewers SHALL find no active summary-v1 producer, reader, alias, compatibility view, historical preparation adapter, or deprecated command retained for convenience

#### Scenario: Compatibility requires an operator decision

- **WHEN** an implementation proposes to keep a superseded surface
- **THEN** the change SHALL identify the operator requirement, bounded lifetime, owner, and removal condition
- **AND** absence of those facts SHALL require deletion

### Requirement: Service image smoke is time bounded

The archive-forwarder image smoke SHALL probe health from inside the container with a per-attempt timeout and SHALL retain bounded total attempts and cleanup.

#### Scenario: Health endpoint accepts but does not complete

- **WHEN** an in-container health request hangs
- **THEN** that attempt SHALL abort within two seconds
- **AND** the smoke loop SHALL continue or fail within its bounded deadline while cleanup remains active
