## ADDED Requirements

### Requirement: Repository services have one architectural authority
The repository SHALL maintain a root `SERVICES_ARCHITECTURE.md` that describes the current process boundaries and uniformly identifies each repository-owned service's purpose, entrypoint, audience, interfaces, credentials, dependencies, persistence, deployment requirement, and failure behavior.

#### Scenario: Operator evaluates a deployment
- **WHEN** an operator needs to deploy the broker, collector, archive-forwarder, or research service
- **THEN** the architecture document MUST identify whether the component is public, internal, operator-only, or research-only
- **AND** it MUST link to the component's detailed operational documentation rather than duplicate every configuration setting

### Requirement: Service and tool boundaries are explicit
The service architecture SHALL distinguish long-running services from examples, migrations, exporters, replay validators, and libraries, and SHALL identify externally owned dependencies and producers without presenting them as CEX Broker services.

#### Scenario: Reader inspects the collector
- **WHEN** a reader compares the full broker and market-data collector
- **THEN** the document MUST state that third-party integrations use the full broker while the collector only keeps configured subscriptions alive
- **AND** it MUST state that continuous capture requires the collector or an equivalent persistent subscriber

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
