## MODIFIED Requirements

### Requirement: All four public feeds traverse the complete integrated archive lifecycle
The archive E2E suite SHALL drive deterministic ORDERBOOK, TICKER, TRADES, and OHLCV frames through a controlled fake `Exchange`, the normal broker gRPC server and Subscribe handler, the production multi-feed gRPC Subscribe client implemented by `MarketDataCollector`, the production archive writer and `node:http` transport, the production HTTP forwarder handler and router, and the ClickHouse Local adapter. It SHALL also overlap an independent logical client with at least one collector feed to prove broker-owned physical sharing and single archive ownership. `OhlcvCollector` MUST remain a compatibility value alias rather than the canonical E2E type. A research watcher, fake gRPC service, or path bypassing the production HTTP handler SHALL NOT satisfy this requirement.

#### Scenario: Deterministic archive configuration is provisioned
- **WHEN** the lifecycle harness prepares to start before releasing any fake-exchange frame
- **THEN** it MUST set `CEX_BROKER_ARCHIVE_ENABLED=true`, `CEX_BROKER_MARKET_ARCHIVE_ENABLED=true`, `CEX_BROKER_ARCHIVE_SOURCE=broker_read`, and `CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT=production`, provision a unique writable `CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH`, local `CEX_BROKER_ARCHIVE_FORWARDER_URL`, and fixed non-empty `CEX_BROKER_DEPLOYMENT_ID` and `CEX_BROKER_CAPTURE_BUNDLE_ID`
- **AND** it MUST either disable archive authentication at both ends or give `CEX_BROKER_ARCHIVE_FORWARDER_TOKEN` and `ARCHIVE_FORWARDER_TOKEN` the same fixed value
- **AND** missing or inconsistent setup MUST fail before any frame is released or lifecycle assertion is reported as passing

#### Scenario: Multi-feed lifecycle starts
- **WHEN** the test configures one deterministic exchange, pair, capture bundle, and all four public feed subscriptions
- **THEN** `MarketDataCollector` MUST open four gRPC Subscribe streams against a server created through normal production wiring
- **AND** the server MUST obtain frames from the injected controlled fake exchange through the real Subscribe handler

#### Scenario: Independent client overlaps the collector
- **WHEN** an independent gRPC client opens an ORDERBOOK subscription matching the collector's canonical feed before the controlled frame is released
- **THEN** the harness MUST observe two logical subscriptions but exactly one physical ORDERBOOK watch invocation
- **AND** explicit and omitted client depth options MUST NOT split that physical watch

#### Scenario: Deterministic frames are released
- **WHEN** the fake exchange releases the fixed ORDERBOOK, TICKER, TRADES, and OHLCV payloads
- **THEN** the collector MUST observe a valid response for every feed, the overlapping client MUST observe its shared frame, and the writer MUST send archive rows through its real queue, batching, and HTTP transport
- **AND** the controlled ORDERBOOK observation MUST enter the physical archive path once rather than once per logical client
- **AND** the test MUST use explicit subscription, frame, flush, spool, and query barriers rather than arbitrary sleeps

#### Scenario: Core broker has no archive configuration
- **WHEN** the normal full broker starts outside the E2E composition without archive configuration
- **THEN** gRPC construction and service registration MUST succeed and archival behavior MUST remain disabled
- **AND** the E2E configuration contract MUST NOT become a production broker startup requirement

#### Scenario: Lifecycle rows reach storage
- **WHEN** the writer reports successful forwarding for the deterministic lifecycle
- **THEN** ClickHouse Local queries MUST find the expected feed-specific rows under the fixed deployment and capture identity
- **AND** the test MUST wait on explicit frame, flush, and query barriers rather than arbitrary sleeps

#### Scenario: Removed archive and credential configuration remains absent
- **WHEN** the suite audits executable production code, test support, scripts, workflows, and operational configuration
- **THEN** every path MUST avoid reading, setting, or branching on `CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE`, `CEX_BROKER_CREDENTIAL_SOURCE_POLICY`, `CEX_BROKER_PROVISIONED_CREDENTIAL_PROFILE`, `CEX_BROKER_CREDENTIAL_ATTESTATION_KIND`, or `CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE`
- **AND** server and handler wiring MUST NOT accept an equivalent credential-policy, profile, permission-attestation, or market write-mode object
