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
capability/resource/adapter/acquisition pins, a positive expected/observed
provider-object inventory, provider-object evidence, ordered failure records,
ordered `target_dispositions`, summary counts, limits, and completeness verdict.
`target_dispositions` MUST remain separate from failure `records`, contain
exactly one entry for each original required-clock target when
`disposition_complete = true`, and partition those targets into
`fresh_within_bound`, `valid_inactive_market_state`, or `disqualifying`. The
qualification record MUST bind the ledger schema identity, safe relative path,
SHA-256, byte count, retained and total record counts, omitted record count,
disposition counts, `disposition_complete`, and completeness verdict.

Each disposition SHALL bind original target ID/time and sorted retained
`record_sha256` references. `fresh_within_bound` MUST bind source time and age
with `0 <= age <= 5000`; `valid_inactive_market_state` MUST bind a valid prior
source time, age greater than 5,000 ms, and retained bounded stable-inactivity
evidence; `disqualifying` MAY omit source time and age but MUST reference at
least one retained typed failure record. Contradictory overlapping evidence is
always disqualifying and MUST NOT be silently resolved by precedence.

The ledger limit SHALL be 100,000 retained failure records, exactly the
required-clock `event_count` disposition slots up to 100,000, and 67,108,864
bytes for the entire canonical UTF-8 JSON document. Omitted dispositions MUST
set `disposition_complete = false`. It MUST contain no credentials, bearer
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

#### Scenario: Every required target is reconciled
- **WHEN** a ledger finishes with `disposition_complete = true`
- **THEN** its ordered dispositions MUST contain every required-clock target exactly once and no unknown target
- **AND** total, fresh, inactive, disqualifying, and omitted counts MUST reconcile with the required clock and qualification descriptor

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
classify the record and affected-target evidence as `stable_object_corruption`, `mutable_provider_bytes`,
`provider_row_loss`, `object_boundary_order_defect`,
`valid_inactive_market_state`, or `unresolved`. Re-fetch SHALL be deduplicated by
provider-object identity across overlapping records, while classification MUST
remain record/target scoped rather than selecting one classification for every
record mentioning an object. The classification MUST bind all observed
checksums and supporting anchors and MUST NOT make failed evidence eligible for
promotion.

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

### Requirement: Qualification, derivation, and source enumeration are separate gates
A pair SHALL pass strict CEX source qualification only when
`source_reconstruction_accepted = true`, its ledger and target dispositions are
complete, and every submitted target is `fresh_within_bound` with one
prior-only, non-crossed, two-sided, depth-valid state within 5,000 ms. A
zero-affected unresolved record MAY remain nonblocking for this submitted-clock
predicate.

`derivation_eligible` SHALL instead require a complete ledger, complete exact
required-clock dispositions, zero disqualifying targets, and all disposition
evidence retained. It MAY be true for a nominal clock containing positively
proven inactivity and MUST NOT overload `qualified`.

`candidate_c_source_enumeration_eligible` SHALL require
`derivation_eligible` plus positive complete provider-object/selected-interval
inventory and no unresolved sequence, provider-row-loss, object-boundary,
stable-corruption, checksum, or mutable-byte evidence anywhere in the fixed
window that could hide or alter a policy-neutral OKX change. A zero-affected
unresolved sequence gap therefore MAY leave Candidate A submitted-clock
qualification intact but MUST block Candidate C source enumeration. Positively
classified `valid_inactive_market_state` remains enumeration-eligible.

#### Scenario: One pair remains incomplete
- **WHEN** either pair has at least one affected required target or an incomplete ledger
- **THEN** CEX MUST NOT claim that the two-pair source dependency is qualified
- **AND** Maker MAY retain the pair-specific failure matrix but MUST publish no atomic accepted input

#### Scenario: Both pair ledgers pass
- **WHEN** both complete pair-local ledgers report zero affected required targets under the unchanged clock and freshness rules
- **THEN** CEX MAY proceed with pair-scoped promotion, exact selection, export, and successor release evidence
- **AND** Maker's aggregate acceptance and thesis proof MUST remain separate

#### Scenario: A gap affects no Candidate A target
- **WHEN** a sequence discontinuity re-anchors before the next Candidate A target but could hide an OKX change inside the fixed window
- **THEN** Candidate A's admitted clock MAY still qualify if every submitted target is fresh
- **AND** `candidate_c_source_enumeration_eligible` MUST be false until the discontinuity is positively resolved

### Requirement: Candidate A is bootstrap evidence, not the final nominal clock
The exact 2,808-target ARB-USDC and 932-target ARB-USDT clocks SHALL be treated
as Candidate A bootstrap qualification clocks. Candidate C SHALL be the final
`nominal_policy_opportunity_clock` constructed by Maker from DEX changes,
policy-relevant changes selected from a CEX policy-neutral OKX input tape, and
freshness expiries. Candidate C's fresh subset SHALL be the final
`admitted_policy_required_clock`. CEX targets MUST partition into fresh,
proven-inactive, and disqualifying targets; Maker policy invocations MUST
partition into admitted and `reference_depth_stale` invocations. Completion
requires the Candidate C disqualifying set to be empty.

#### Scenario: Candidate A dispositions are complete
- **WHEN** both sparse Candidate A clocks have complete derivation-eligible ledgers
- **THEN** they MAY support bootstrap admitted-clock qualification and input-tape production
- **AND** they MUST NOT support a full-timeline or final nominal-clock claim

### Requirement: Candidate C receives a source-complete policy-neutral OKX input tape
CEX SHALL produce a Candidate C input tape only when the bootstrap admitted
clock passed strict qualification, provider-object enumeration is positively
complete, `candidate_c_source_enumeration_eligible = true`, and the exported
tape contains the complete policy-neutral OKX top-100 state/freshness-change
stream for the fixed window. The tape SHALL contain one bound initialization
state and one canonical state after every sequence-valid OKX event group that
changes the top-100 book or advances the valid source time/sequence used for
freshness. It MUST scan the complete provider window independently of the
submitted Candidate A targets and MUST NOT filter changes using Maker policy.

The tape SHALL use a new pinned qualification capability and construction-mode
identity; it MUST NOT label these rows `sampled_top_n_snapshot`. It SHALL enter
Parquet through the normal archive-forwarder, promotion, qualification,
exact-selection, replay-qualified-view, and exporter-v2 machinery in the
disposable `sandbox/cex-archive-local` archive. No qualification-only Parquet
writer MAY claim normal selection, receipt, promotion, or exporter identities.
The existing levels and depth-summary Parquet projection schemas MAY be reused
because the tape emits canonical full book states with the same physical
columns, but the tape manifest MUST bind construction identity, canonical
schema, capability, adapter and acquisition policies, complete
expected/observed object inventory, sandbox selection/receipt/export
identities, artifact hashes, exact state count, and fixed window. This adds no
package schema: schema manifest v3 remains exactly twelve entries, while
dependent policy and product-pin identities MUST be regenerated before the
release commit is frozen.

Tape acquisition SHALL submit at most four complete states per reconstructor
yield, 1,000 canonical rows and 5,242,880 JSON bytes per forwarder batch, and
one in-flight forwarder request. Every submitted batch MUST be acknowledged
before reading the next provider object. The tape SHALL contain exactly one
initialization/support state, which MAY precede the window, followed only by
state changes with source times in `[window.start, window.end)`; it MUST emit no
event at the exclusive end boundary.

`candidate_c_input_tape_eligible` SHALL require bootstrap admitted
qualification, `candidate_c_source_enumeration_eligible`, positive complete
inventory, a complete state-change projection, and matching pinned schema,
construction-mode, capability, policy, and artifact identities.

#### Scenario: Candidate A export contains only sampled states
- **WHEN** the ordinary clock-bound backfill exports only the 2,808 or 932 Candidate A snapshots
- **THEN** that export MUST be ineligible as a Candidate C input tape
- **AND** Maker MUST NOT infer omitted OKX change timestamps from it

#### Scenario: Expected and observed source inventories differ
- **WHEN** any expected provider object or selected interval is missing, duplicated, mutable, or not bound to its observed checksum
- **THEN** `candidate_c_input_tape_eligible` MUST be false even if no submitted clock target was affected
- **AND** no Candidate C materialization may use that tape

#### Scenario: Tape production fails after retaining partial evidence
- **WHEN** provider acquisition, reconstruction, forwarder admission, promotion, selection, or export fails for either pair
- **THEN** the affected pair MUST commit no tape Parquet or success manifest
- **AND** the two-pair harness MUST commit a durable failure verdict naming the pair, a stable reason, the hashes of retained partial evidence, and any earlier passing pair manifest and artifact hashes
- **AND** pair-prefixed Parquet names MUST prevent one pair from overwriting the other
- **AND** success and failure finalization MUST remove the stale opposite top-level verdict

### Requirement: Maker derivation is versioned and capacity-preflighted
CEX's repository-only qualification harness SHALL validate the Maker-owned
`reference-depth-clock-derivation-descriptor/v1` against a pinned schema ID and
canonical hash without adding it to the normal request or twelve-entry package
manifest. The descriptor SHALL bind its bootstrap/final stage, materializer
identity/version, Maker policy/configuration fingerprint, sole scheduler
identity, DEX input hashes, eligible bootstrap tape and CEX evidence identities,
original and admitted clocks/projections, exact target mapping, blocked
dispositions hash, exact CEX-target and Maker-invocation counts, current policy
pins, depth 100, `fill_gaps`, 5,000 ms, and the freshness-expiry rule.

Maker SHALL materialize Candidate C without truncation. If its exact CEX target
count exceeds the current 100,000-target resource ceiling, CEX MUST fail closed
before request construction and require a coordinated representation,
partitioning, or resource-policy specification decision. Economically distinct
Maker invocations MUST NOT be deduplicated to fit the ceiling.

#### Scenario: Freshness reaches exactly 5,000 ms
- **WHEN** a controller evaluation observes `target_time - prior_source_time = 5000`
- **THEN** it remains fresh and no expiry target is created at that instant
- **AND** expiry is the first actual `native_chronological_scheduler_v2` controller opportunity for which age is strictly greater than 5,000 ms, with a same-timestamp qualifying source update processed first
