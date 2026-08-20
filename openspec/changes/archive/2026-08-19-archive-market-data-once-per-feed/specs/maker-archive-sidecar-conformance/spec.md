## MODIFIED Requirements

### Requirement: Production-compatible Maker conformance exercises live and durable boundaries
The production-compatible profile SHALL run the Maker Layer 12 live/sandbox boundary against the sidecar broker, with `hb_runtime` strategy rows posted to the archive-forwarder and durably admitted to SQLite before HTTP 202. The collector SHALL remain an independent broker client that keeps configured market subscriptions alive; it MUST NOT be represented as the third-party Maker client. CEX-owned Proof C SHALL establish logical-versus-physical feed ownership and the durable spool/ClickHouse boundary. The final CEX verifier SHALL combine Proof C and freshly generated CEX Proof A with a separately produced, hash-bound FIET Maker Proof B v2 attachment. CEX Broker MUST NOT execute Maker position-policy logic or require Maker Proof B to reproduce CEX topology/archive facts.

#### Scenario: Production-compatible profile runs
- **WHEN** Layer 12 starts with the sidecar broker endpoint and shared run identity
- **THEN** its CEX interactions MUST traverse the normal broker gRPC surface while the collector independently sustains archival subscriptions
- **AND** retained evidence MUST distinguish the real Hummingbot connector subscription from the Layer 12 reference-depth snapshot action used by policy authoring
- **AND** live strategy batches MUST receive HTTP 202 only after durable spool admission

#### Scenario: Collector and Maker overlap on a public feed
- **WHEN** the independent collector and real Maker connector subscribe to the same exchange, resolved symbol, market type, and public feed with options that resolve to one explicitly enabled candidate acquisition profile
- **THEN** CEX-owned Proof C MUST record both logical subscriptions and MUST prove Maker receives the shared feed frame
- **AND** the controlled exchange MUST record one physical CCXT watch and one archive decision for the canonical observation rather than treating Maker as an additional physical producer
- **AND** ClickHouse evidence MUST contain one canonical broker capture for the controlled physical observation

#### Scenario: One controlled venue establishes Proof C
- **WHEN** the production-compatible sidecar uses one controlled Binance candidate profile to prove the real cross-repository broker and archive topology
- **THEN** that topology proof MAY satisfy Proof C without duplicating the full sidecar run for MEXC
- **AND** the final verifier MUST still require independent Binance and MEXC cases in both Proof A and Proof B because venue-specific data and policy equivalence are not delegated to Proof C

#### Scenario: Candidate depth profile overlaps in controlled verification
- **WHEN** collector explicit depth and Maker omitted depth target a Binance or MEXC candidate that the controlled sidecar composition explicitly enables and the profile guarantees coverage of both requests plus archive depth
- **THEN** Proof C MUST identify the resolved profile and prove the two logical clients share it
- **AND** Maker and collector payloads MUST retain their respective omitted-depth and explicit-depth response contracts
- **AND** controlled evidence enablement MUST NOT alter the empty production enabled-profile default

#### Scenario: Maker Proof B attachment is supplied
- **WHEN** the final production-compatible CEX verifier consumes Maker policy-equivalence evidence
- **THEN** `profileEvidence.immediateHedgeability` MUST be an attachment descriptor with schema `fiet-maker-immediate-hedgeability-attachment/v1`, a path under the run-owned artifact directory, and a claimed `sha256`
- **AND** the verifier MUST reject path traversal or a path outside that directory, recompute the attachment's whole-file SHA-256, and require it to equal the claimed hash before parsing the document
- **AND** the document MUST use schema `fiet-maker-immediate-hedgeability/v2`

#### Scenario: Maker Proof B is bound to current CEX Proof A
- **WHEN** the CEX verifier validates the parsed Maker Proof B attachment
- **THEN** `sourceCexEvidence.schemaVersion` MUST equal `cex-orderbook-coalescing-evidence/v1` and `sourceCexEvidence.sha256` MUST equal the freshly recomputed hash of the current real Proof A file
- **AND** Proof B MUST contain `policyConfigSha256`, artifact hashes, and exactly one Binance and one MEXC case whose profile IDs are `<venue>:l2-diff:500`
- **AND** each case MUST contain four isolated live Layer 12 evaluation streams for conservative/coalesced multiplied by live/rehydrated inputs, with cap, width, authored position, limiting side, rebalance, equivalence verdict, and diagnostic-hash evidence
- **AND** an attachment bound only to a synthetic or stale Proof A fixture MUST fail final CEX verification

#### Scenario: Proof ownership is enforced
- **WHEN** the verifier inspects Maker Proof B
- **THEN** it MUST reject `sharedObservation`, `logicalDeliveries`, `physicalWatches`, `archiveDecisions`, `logicalPayloadsEqual`, and `canonicalArchiveEqual` wherever the Proof B contract forbids copied CEX facts
- **AND** logical subscription/watch/archive counts, spool state, and ClickHouse delivery MUST be taken only from CEX-owned Proof C
- **AND** broker payload/archive equality, band coverage, replay sufficiency, and physical-work reduction MUST be taken only from CEX-owned Proof A

#### Scenario: Replay depth is insufficient for the position policy
- **WHEN** Proof A's negative 25-level ORDERBOOK frame does not reach a required policy band and does not carry explicit exhaustion evidence
- **THEN** the final verifier MUST require coverage rejection before that frame is offered to Layer 12 as exact replay evidence
- **AND** the failure MUST include band and side diagnostics and MUST be distinguished from an L3 capability requirement

#### Scenario: Production-compatible verification runs
- **WHEN** Maker execution completes and the sidecar worker drains admitted work
- **THEN** Proof C verification MUST query the expected market and all required strategy tables, confirm v2 producer/stream identity, and prove spool queue/table work reached completed state
- **AND** one isolated table retry or restart-recovery case MUST prove stable deduplication without duplicate logical strategy events
- **AND** the final verifier MUST require passing current Proof A, hash-bound Proof B, and local Proof C while reporting their hashes and verdicts separately
- **AND** passing all three proofs MUST NOT activate Binance or MEXC coalescing; activation belongs to a later CEX change that pins accepted evidence hashes

#### Scenario: HTTP 202 is the only available evidence
- **WHEN** a live batch was admitted but no completed spool and ClickHouse query evidence exists
- **THEN** production-compatible conformance MUST fail as incomplete
- **AND** admission MUST be reported separately from delivery
