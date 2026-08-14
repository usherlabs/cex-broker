## MODIFIED Requirements

### Requirement: Service and tool boundaries are explicit
The service architecture SHALL distinguish long-running services from examples, migrations, exporters, replay validators, and libraries, and SHALL identify externally owned dependencies and producers without presenting them as CEX Broker services. It SHALL distinguish logical broker clients from broker-owned physical public-feed workers and archive paths.

#### Scenario: Reader inspects the collector
- **WHEN** a reader compares the full broker and market-data collector
- **THEN** the document MUST state that third-party integrations use the full broker while the collector keeps configured logical subscriptions alive for capture coverage and liveness
- **AND** it MUST state that continuous capture requires the collector or an equivalent persistent subscriber
- **AND** it MUST NOT present a single collector instance as necessary to prevent duplicate physical exchange watches or archive captures, because the full broker owns canonical feed sharing

#### Scenario: Reader compares collector and Maker subscriptions
- **WHEN** the collector and Maker subscribe to the same canonical public feed
- **THEN** the document MUST show two independent logical gRPC subscriptions attached to one broker-owned physical exchange watcher and archive path
- **AND** it MUST preserve the collector's liveness responsibility and Maker's third-party client boundary

#### Scenario: Reader inspects ClickHouse clients
- **WHEN** a reader follows archive or research data flows
- **THEN** the document MUST distinguish the archive-forwarder's trusted write boundary from direct readers and externally owned metrics producers
- **AND** it MUST not imply that every ClickHouse client is routed through the archive-forwarder
