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

### Requirement: The published subpath exposes the complete final-v1 library boundary
The dedicated package subpath SHALL export strict request/result codecs, schema
and policy manifests, RFC 8785 identity helpers, the domain runner, and a
dependency factory. Its implementation and generated declarations MUST NOT
import broker/server modules. Schemas, policies, fixtures, and declarations
MUST be present in the published npm tarball.

#### Scenario: Fiet TEE bundles the subpath
- **WHEN** a consumer imports or bundles the package subpath
- **THEN** it MUST obtain all final-v1 artifacts without starting the gRPC server
- **AND** package smoke tests MUST reject server-side imports or missing assets

### Requirement: Market-data vendor backfill is a bounded archive tool
The service architecture SHALL document `market-data-vendor-backfill` and
`cex-canonical-orderbook-export` as CEX-owned bounded preparation executables,
not long-running services. CEX Broker MUST own their file/CLI boundaries,
provider adapters, canonicalization, forwarder submission, qualified archive
preflight, promotion verification, exact export, packaging, and release pins.
The backfill tool MUST have provider-read, qualified-archive-read, and
archive-forwarder-write access but no direct ClickHouse write authority; the
exporter MUST have qualified-archive-read access only. Fiet TEE MUST NOT own or
wrap either product.

#### Scenario: Reader locates the preparation boundary
- **WHEN** an operator compares the commands with the broker, collector, and archive-forwarder
- **THEN** the architecture MUST state that neither command is an always-on service, broker RPC/action, collector responsibility, or vendor-fetch feature of the forwarder
- **AND** it MUST state that only the forwarder owns ClickHouse writes

#### Scenario: Forwarder durability ownership is inspected
- **WHEN** an operator evaluates a failed market-data backfill submission
- **THEN** documentation MUST assign bounded deterministic retry and resubmission to the backfill producer
- **AND** it MUST NOT claim that the strategy-runtime SQLite spool owns vendor market-data batches

### Requirement: Cross-repository backfill proof ownership is explicit
The architecture SHALL assign CEX Broker ownership of both packaged preparation
executables, the promotion receipt, exact canonical export, and immutable npm
product pin. Fiet Maker SHALL own archive-first dispatch, independent
post-promotion archive re-query, actual loader consumption, final artifact
construction, required-clock proof, and policy proof. Fiet TEE SHALL have no
ownership in this preparation path.

#### Scenario: FIET-1017 evidence is assembled
- **WHEN** a cross-repository gate verifies promoted vendor-origin history
- **THEN** it MUST bind the published CEX tarball and executable identities, CEX promotion receipt and exact export, Maker post-promotion query, and Maker consumer artifact
- **AND** CEX Broker MUST NOT import or invoke Maker application or policy code
