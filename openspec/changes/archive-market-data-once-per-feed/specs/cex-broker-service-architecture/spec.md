## MODIFIED Requirements

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
