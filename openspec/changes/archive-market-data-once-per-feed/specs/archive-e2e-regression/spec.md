## MODIFIED Requirements

### Requirement: All four public feeds traverse the complete integrated archive lifecycle
The archive E2E suite SHALL drive deterministic ORDERBOOK, TICKER, TRADES, and OHLCV frames through a controlled fake `Exchange`, the normal broker gRPC server and Subscribe handler, the production multi-feed gRPC Subscribe client implemented by `MarketDataCollector`, the production archive writer and `node:http` transport, the production HTTP forwarder handler and router, and the ClickHouse Local adapter. It SHALL overlap independent logical clients with collector feeds to prove broker-owned physical sharing and single archive ownership. It SHALL also compare conservative depth-isolated and explicitly candidate-enabled Binance/MEXC profile-coalesced collection over the same bounded deterministic observation window and publish CEX-owned Proof A for logical payloads, L2 immediate-hedgeability input coverage, archive replay inputs, and reduced physical work. It MUST NOT implement or invoke FIET Maker policy logic. `OhlcvCollector` MUST remain a compatibility value alias rather than the canonical E2E type. A research watcher, fake gRPC service, arbitrary sleep-only comparison, or path bypassing the production HTTP handler SHALL NOT satisfy this requirement.

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
- **WHEN** an independent gRPC client opens an ORDERBOOK subscription whose options resolve to the same acquisition profile as the collector before the controlled frame is released
- **THEN** the harness MUST observe two logical subscriptions but exactly one physical ORDERBOOK watch invocation
- **AND** compatible explicit and omitted client depth options MUST NOT split that physical watch

#### Scenario: Deterministic frames are released
- **WHEN** the fake exchange releases the fixed ORDERBOOK, TICKER, TRADES, and OHLCV payloads
- **THEN** the collector MUST observe a valid response for every feed, the overlapping client MUST observe its shared frame, and the writer MUST send archive rows through its real queue, batching, and HTTP transport
- **AND** the controlled ORDERBOOK observation MUST enter the physical archive path once rather than once per logical client
- **AND** the test MUST use explicit subscription, frame, flush, spool, and query barriers rather than arbitrary sleeps

#### Scenario: OHLCV client overlaps the collector
- **WHEN** a zero-bootstrap independent OHLCV client creates the worker before a positive-bootstrap collector attaches for the same timeframe
- **THEN** the harness MUST observe two logical subscriptions, one physical OHLCV watch/tracker, and one successfully archived bootstrap owned by the collector request
- **AND** both clients MUST continue receiving live OHLCV frames after bootstrap completion or non-fatal bootstrap retry

#### Scenario: Conservative and coalesced models are compared
- **WHEN** the harness runs `MarketDataCollector` against conservative and candidate coalesced broker compositions fed the same ordered event tape for the configured observation duration and minimum frame count
- **THEN** it MUST compare ordered logical ORDERBOOK payloads per subscription after deterministic normalization and MUST find them equivalent
- **AND** it MUST compare canonicalized unique archive rows after removing deployment/run identity and MUST find the same market-data outcomes
- **AND** it MUST separately prove that the coalesced composition used fewer physical watch iterations and archive offers without producing an additional canonical event

#### Scenario: Policy-visible tape exercises depth changes
- **WHEN** Proof A runs the conservative and candidate compositions for either venue
- **THEN** the common ordered tape MUST contain at least five observations at policy-visible depth 100 with material bid and ask quantity changes while preserving required price-band coverage
- **AND** a tape that only shifts prices while leaving depth quantities constant MUST NOT satisfy the cross-repository verification input contract

#### Scenario: Acquisition profiles cover every Maker measurement band
- **WHEN** the comparison configures Maker policy depth P and candidate bands including the immediate sell-into-bids and buy-from-asks band used to cap DEX liquidity
- **THEN** every conservative and coalesced snapshot MUST prove bid and ask coverage through each band boundary or explicit visible-book exhaustion
- **AND** the gate MUST fail when a retained side stops inside a required band even when it contains P levels
- **AND** diagnostics MUST identify venue profile, band, side, boundary, farthest retained price, and retained count

#### Scenario: Archived depth reproduces live policy inputs
- **WHEN** the gate rehydrates ORDERBOOK evidence from canonical ClickHouse rows captured for a Maker policy with requested depth P
- **THEN** archive depth MUST be at least P unless explicit exhaustion or retained boundary evidence proves every required band complete
- **AND** rehydrated mid price, per-band bid and ask displayed depth, limiting side, and coverage verdict MUST equal the corresponding live snapshot inputs
- **AND** a negative fixture using the ordinary 25-level archive cap against a policy requiring deeper evidence MUST fail replay sufficiency rather than pass by row presence alone

#### Scenario: CEX Proof A is published deterministically
- **WHEN** the Binance and MEXC CEX comparisons complete
- **THEN** the gate MUST publish one UTF-8 JSON evidence file whose top level contains `schemaVersion: cex-orderbook-coalescing-evidence/v1`, `policyDepth: 100`, `archiveDepth`, `bandsBps`, and ordered `cases[]`
- **AND** `cases[]` MUST contain exactly one Binance and one MEXC item with `venue`, `profileId: <venue>:l2-diff:500`, ordered `observations[]`, `cexVerdicts`, and `insufficientReplayCase`
- **AND** observations MUST contain conservative/coalesced live and rehydrated policy-visible snapshots, coverage/exhaustion evidence, and snapshot hashes; `cexVerdicts` MUST cover logical payload equality, canonical archive equality, live/replay input equality, band coverage, and reduced physical work; and `insufficientReplayCase` MUST carry the separate 25-level diagnostics
- **AND** the existing `canonicalSerialize` representation followed by exactly one LF byte MUST define the whole-file SHA-256 bytes; the evidence MUST omit a self-hash and nondeterministic path, host, deployment, run, and wall-clock metadata
- **AND** CEX Broker MUST export policy-visible input facts only and MUST NOT calculate Maker envelope caps, authored positions, widths, or rebalance decisions

#### Scenario: Binance resolver passes the equivalence gate
- **WHEN** the candidate composition enables the Binance acquisition-profile resolver for compatible explicit and omitted depths
- **THEN** the collector comparison MUST satisfy logical/archive equality, band coverage, archive replay sufficiency, and reduced physical work in the Binance Proof A case
- **AND** passing this CEX-owned case MUST NOT enable Binance coalescing by default in this change
- **AND** the gate MUST fail on a missing, reordered, changed, or additional logical/canonical market event

#### Scenario: MEXC resolver passes the equivalence gate
- **WHEN** the candidate composition enables the MEXC acquisition-profile resolver for compatible explicit and omitted depths
- **THEN** the collector comparison MUST satisfy logical/archive equality, band coverage, archive replay sufficiency, and reduced physical work in the MEXC Proof A case
- **AND** passing this CEX-owned case MUST NOT enable MEXC coalescing by default in this change
- **AND** the gate MUST fail on a missing, reordered, changed, or additional logical/canonical market event

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
