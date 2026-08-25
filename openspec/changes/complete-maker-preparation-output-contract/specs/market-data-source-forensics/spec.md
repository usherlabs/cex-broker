## ADDED Requirements

### Requirement: Source forensics observes the one current reconstruction path
CEX Broker SHALL produce source-forensics evidence by observing the same
capability-v3 OKX reconstruction implementation used by the backfill file job.
Forensics MUST be a library observer invoked only by the CEX qualification
harness; it MUST NOT add a third preparation executable or a Maker request
field. It MUST NOT select another adapter, loosen validation, synthesize state,
change the required clock or freshness policy, or create a second acceptance
path. Enabling evidence collection, including evidence overflow, MUST NOT
change reconstructed rows, samples, failure classification, detailed subcode,
summary diagnostics, selection, promotion, or export output.

#### Scenario: A qualification run enables the ledger
- **WHEN** the current OKX adapter replays the same provider objects and required clock with source-forensics observation enabled
- **THEN** its reconstruction samples, domain status, subcode, and summary diagnostics MUST be identical to a run without the observer
- **AND** only the additional evidence artifacts and qualification reference MAY differ

#### Scenario: A caller looks for a forensic execution mode
- **WHEN** package bins or the backfill request schema are inspected
- **THEN** they MUST expose no forensic command and no observer-selection field
- **AND** qualification MUST inject the observer through the CEX library boundary

### Requirement: The ledger is published, content-addressed, bounded, and secret-free
Each full-window pair qualification SHALL write one
`https://schemas.usher.so/market-data-source-forensics-ledger/v1` ledger and one
`https://schemas.usher.so/market-data-source-qualification-record/v1` record.
Both schemas MUST be published npm package assets bound by schema manifest v3
and product pin v2. The ledger digest SHALL bind request and idempotency
identities, canonical scope, required-clock identity, current
capability/resource/adapter/acquisition pins, provider-object evidence, ordered
records, summary counts, limits, and completeness verdict. The qualification
record MUST bind the ledger schema identity, safe relative path, SHA-256, byte
count, retained and total record counts, omitted record count, and completeness
verdict.

The ledger limit SHALL be 100,000 retained records and 67,108,864 bytes of its
canonical UTF-8 JSON representation. It MUST contain no credentials, bearer
material, provider rows, response bodies, ClickHouse secrets,
archive-forwarder secrets, or reflected error text.

#### Scenario: The ledger is retained after a failed qualification
- **WHEN** a pair fails sequence, anchoring, source-object, or required-clock qualification
- **THEN** the ledger MUST be file-synced before its qualification record is atomically committed with matching hashes and counts
- **AND** downloaded licensed provider payloads and credentials MUST be removed

#### Scenario: Evidence exceeds a pinned bound
- **WHEN** observation would exceed 100,000 retained records or 67,108,864 canonical JSON bytes
- **THEN** the sink MUST continue observing without throwing into reconstruction, count every omitted record, and finish a valid ledger with `complete = false` and a stable bound-exceeded reason
- **AND** the corresponding incomplete qualification MUST NOT qualify, promote, or support a release claim

### Requirement: Every causal source failure has a typed record
The ledger SHALL use the closed record kinds `sequence_discontinuity`,
`unanchored_target_interval`, `stale_target_interval`,
`future_state_interval`, and `provider_object_checksum_conflict`. Records MUST
be deterministically ordered. Each record MUST bind the pair, failure kind,
relevant provider-object identities and checksums, surrounding complete
snapshot anchors when available, and the affected half-open target interval and
count when applicable. Sequence records MUST bind prior/current sequence values
and event time. Target-interval records MUST bind lag-distribution counts.
Missing information MUST be represented explicitly rather than fabricated.

#### Scenario: An OKX update chain breaks
- **WHEN** an applied update's `prevSeqId` does not match the current `seqId`
- **THEN** the ledger MUST record expected and observed sequence values, event time, implicated provider-object identity/checksum, affected required targets, and the next valid complete snapshot anchor if one exists
- **AND** reconstruction MUST clear current state, remain unanchored until that snapshot, and continue scanning the full clock

#### Scenario: A later snapshot precedes the next required target
- **WHEN** a sequence gap is followed by a complete snapshot before any required target is sampled
- **THEN** the discontinuity record MUST report zero affected required targets and bind the later anchor
- **AND** the re-anchored required target MAY qualify under the unchanged production rules

#### Scenario: Required clocks remain stale without a sequence gap
- **WHEN** a prior-only state exists but exceeds the 5,000 ms bound for a maximal run of required targets
- **THEN** one `stale_target_interval` record MUST bind the target range/count, source anchor, provider-object evidence, and lag distribution
- **AND** the interval MUST remain failed rather than being interpolated or converted to future state

#### Scenario: A future state is observed for a target
- **WHEN** an observed source time is later than one or more required target times
- **THEN** one maximal `future_state_interval` record MUST bind those targets, source evidence, and lag counts
- **AND** future state MUST NOT satisfy or be rewritten as prior-only coverage

#### Scenario: One provider object identity yields conflicting bytes
- **WHEN** the same provider-object identity produces two readable checksums
- **THEN** a `provider_object_checksum_conflict` record MUST retain the safe identity, all observed checksums, attempt count, quarantine state, and affected targets
- **AND** neither byte version MAY be admitted to a promoted capture

### Requirement: Implicated objects receive a durable source classification
For each failure record, CEX qualification SHALL re-fetch only the implicated
original and adjacent bounded hourly objects under the current retry policy and
classify the evidence as `stable_object_corruption`, `mutable_provider_bytes`,
`provider_row_loss`, `object_boundary_order_defect`,
`valid_inactive_market_state`, or `unresolved`. The classification MUST bind all
observed checksums and supporting anchors and MUST NOT make failed evidence
eligible for promotion.

#### Scenario: Re-fetch returns different bytes
- **WHEN** the same provider-object identity produces a checksum different from an earlier readable attempt
- **THEN** the record MUST classify `mutable_provider_bytes`, retain the observed checksums without payload content, and mark the object quarantined
- **AND** neither version MAY be admitted to a promoted capture

#### Scenario: Stable objects suggest an adapter boundary defect
- **WHEN** original and adjacent objects retain stable checksums and a bounded diagnostic replay suggests that alternate source ordering would close the reported gap
- **THEN** the ledger MAY classify `object_boundary_order_defect` as a diagnostic hypothesis and identify the affected adapter version
- **AND** that replay MUST NOT repair or certify any interval; only a production-path fix followed by complete-window requalification MAY pass

#### Scenario: Stable valid objects contain no fresh market update
- **WHEN** original and adjacent objects have stable checksums, valid schema and sequence evidence, no missing rows or complete snapshot defect, and the last valid prior state remains older than 5,000 ms for the affected targets
- **THEN** the ledger MUST classify `valid_inactive_market_state` with its object, anchor, target, and lag evidence
- **AND** those targets MUST remain failed and non-promotable under the unchanged freshness rule

### Requirement: Passing qualification proves zero unresolved source gaps
A pair SHALL pass CEX source qualification only when its ledger is complete and
has no sequence-discontinuity, unanchored, stale, future-state,
checksum-conflict, or unresolved record affecting the required clock, and every
required target has one prior-only, non-crossed, two-sided, depth-valid state
within 5,000 ms. The same requirements SHALL apply independently to ARB-USDT
and ARB-USDC over one common 20-to-30-complete-UTC-day window. A complete UTC
day SHALL mean `[00:00:00Z, next 00:00:00Z)` in which every pair-local required
target qualifies; it SHALL NOT require every nominal hourly provider object to
exist when the exact required clock is otherwise covered.

#### Scenario: One pair remains incomplete
- **WHEN** either pair has at least one affected required target or an incomplete ledger
- **THEN** CEX MUST NOT claim that the two-pair source dependency is qualified
- **AND** Maker MAY retain the pair-specific failure matrix but MUST publish no atomic accepted input

#### Scenario: Both pair ledgers pass
- **WHEN** both complete pair-local ledgers report zero affected required targets under the unchanged clock and freshness rules
- **THEN** CEX MAY proceed with pair-scoped promotion, exact selection, export, and successor release evidence
- **AND** Maker's aggregate acceptance and thesis proof MUST remain separate
