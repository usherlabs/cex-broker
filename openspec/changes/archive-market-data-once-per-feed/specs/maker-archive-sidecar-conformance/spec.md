## MODIFIED Requirements

### Requirement: Production-compatible Maker conformance exercises live and durable boundaries
The production-compatible profile SHALL run the Maker Layer 12 live/sandbox boundary against the sidecar broker, with `hb_runtime` strategy rows posted to the archive-forwarder and durably admitted to SQLite before HTTP 202. The collector SHALL remain an independent broker client that keeps configured market subscriptions alive; it MUST NOT be represented as the third-party Maker client. Conformance evidence SHALL distinguish logical gRPC subscriptions and deliveries from physical exchange watches and archive captures.

#### Scenario: Production-compatible profile runs
- **WHEN** Layer 12 starts with the sidecar broker endpoint and shared run identity
- **THEN** its CEX interactions MUST traverse the normal broker gRPC surface while the collector independently sustains archival subscriptions
- **AND** retained evidence MUST distinguish the real Hummingbot connector subscription from the Layer 12 reference-depth snapshot action used by policy authoring
- **AND** live strategy batches MUST receive HTTP 202 only after durable spool admission

#### Scenario: Collector and Maker overlap on a public feed
- **WHEN** the independent collector and real Maker connector subscribe to the same exchange, resolved symbol, market type, and public feed with options that resolve to one compatible acquisition profile
- **THEN** evidence MUST record both logical subscriptions and MUST prove Maker receives the shared feed frame
- **AND** the controlled exchange MUST record one physical CCXT watch for the canonical feed rather than treating Maker as an additional watch-call increase
- **AND** ClickHouse evidence MUST contain one canonical broker capture for the controlled physical observation

#### Scenario: Binance or MEXC depth profiles overlap
- **WHEN** collector explicit depth and Maker omitted depth target Binance or MEXC and the verified resolver guarantees one profile covers both plus archive depth
- **THEN** production-compatible evidence MUST identify the resolved profile and prove the two logical clients share it
- **AND** Maker and collector payloads MUST retain their respective omitted-depth and explicit-depth response contracts

#### Scenario: Production-compatible verification runs
- **WHEN** Maker execution completes and the sidecar worker drains admitted work
- **THEN** verification MUST query the expected market and all required strategy tables, confirm v2 producer/stream identity, and prove spool queue/table work reached completed state
- **AND** one isolated table retry or restart-recovery case MUST prove stable deduplication without duplicate logical strategy events
- **AND** logical subscription/delivery counts MUST be reported separately from physical watch/archive counts

#### Scenario: HTTP 202 is the only available evidence
- **WHEN** a live batch was admitted but no completed spool and ClickHouse query evidence exists
- **THEN** production-compatible conformance MUST fail as incomplete
- **AND** admission MUST be reported separately from delivery
