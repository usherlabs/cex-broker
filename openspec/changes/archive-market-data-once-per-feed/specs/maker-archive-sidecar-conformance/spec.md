## MODIFIED Requirements

### Requirement: Production-compatible Maker conformance exercises live and durable boundaries
The production-compatible profile SHALL run the Maker Layer 12 live/sandbox boundary against the sidecar broker, with `hb_runtime` strategy rows posted to the archive-forwarder and durably admitted to SQLite before HTTP 202. The collector SHALL remain an independent broker client that keeps configured market subscriptions alive; it MUST NOT be represented as the third-party Maker client. Conformance evidence SHALL distinguish logical gRPC subscriptions and deliveries from physical exchange watches and archive captures. It SHALL treat normalized L2 displayed depth inside each configured price band as the immediate hedgeability cap on counterpart DEX liquidity and SHALL NOT require L3 order identity for that calculation.

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

#### Scenario: L2 depth caps counterpart DEX liquidity
- **WHEN** Layer 12 evaluates a candidate DEX position band from a reference CEX ORDERBOOK snapshot
- **THEN** immediate sell capacity MUST derive from aggregate displayed bids inside the band and immediate buy capacity MUST derive from aggregate displayed asks inside the band
- **AND** the resulting envelope cap MUST use the policy's limiting-side, participation, safety, and range-conversion rules without requiring individual CEX order IDs or queue position

#### Scenario: Conservative and coalesced position-policy evaluations agree
- **WHEN** the production-compatible verifier evaluates live reference snapshots and independently rehydrated archive inputs for the same ordered tape, policy depth, candidate bands, commitment, and previous position state through conservative and Binance/MEXC coalesced broker compositions
- **THEN** it MUST compare band depths, limiting side, envelope liquidity cap, selected width ticks, and rebalance decision at every evaluation
- **AND** live-versus-rehydrated policy results MUST agree within each composition
- **AND** any difference MUST fail conformance even if normalized broker payloads and canonical archive rows otherwise compare equal

#### Scenario: Replay depth is insufficient for the position policy
- **WHEN** archived ORDERBOOK levels do not reach a required policy band and do not carry explicit exhaustion evidence
- **THEN** production-compatible replay MUST fail with band and side diagnostics rather than derive a thesis-equivalent position from incomplete depth
- **AND** the verifier MUST distinguish this coverage failure from an L3 capability requirement

#### Scenario: Production-compatible verification runs
- **WHEN** Maker execution completes and the sidecar worker drains admitted work
- **THEN** verification MUST query the expected market and all required strategy tables, confirm v2 producer/stream identity, and prove spool queue/table work reached completed state
- **AND** one isolated table retry or restart-recovery case MUST prove stable deduplication without duplicate logical strategy events
- **AND** logical subscription/delivery counts MUST be reported separately from physical watch/archive counts

#### Scenario: HTTP 202 is the only available evidence
- **WHEN** a live batch was admitted but no completed spool and ClickHouse query evidence exists
- **THEN** production-compatible conformance MUST fail as incomplete
- **AND** admission MUST be reported separately from delivery
