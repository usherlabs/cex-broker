## ADDED Requirements

### Requirement: Source forensics observes the one current reconstruction path
CEX Broker SHALL produce source-forensics evidence by observing the same
capability-v3 OKX reconstruction implementation used by the backfill file job.
Forensics MUST be a library observer invoked by the CEX qualification and
source-tape package-library operations; it MUST NOT add a third preparation
executable or a Maker-policy request field. It MUST NOT select another adapter,
loosen validation, synthesize state,
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

### Requirement: Qualification, source partitioning, and source enumeration are separate CEX facts
A pair SHALL pass strict CEX source qualification only when
`source_reconstruction_accepted = true`, its ledger and target dispositions are
complete, and every submitted target is `fresh_within_bound` with one
prior-only, non-crossed, two-sided, depth-valid state within the request's bound.
A zero-affected unresolved record MAY remain nonblocking for this submitted-clock
predicate.

`source_partition_complete` SHALL instead require a complete ledger, complete
exact required-clock dispositions, zero disqualifying targets, and all
disposition evidence retained. It MAY be true for a required clock containing
positively proven inactivity and MUST NOT overload `qualified`.

`source_event_enumeration_eligible` SHALL require positive complete
provider-object and selected-interval inventory plus no unresolved sequence,
provider-row-loss, object-boundary, stable-corruption, checksum, mutable-byte,
or omitted-evidence condition anywhere in the requested window that could hide,
omit, reorder, or alter a policy-neutral source event. A zero-affected
unresolved sequence gap therefore MAY leave submitted-clock qualification
intact but MUST block source-event enumeration. Positively classified
`valid_inactive_market_state` remains enumeration-eligible.

These are source facts, not Maker decisions. CEX MUST NOT emit
`derivation_eligible`, Candidate-role, admitted-clock, policy-invocation, or
`reference_depth_stale` verdicts.

#### Scenario: One pair remains incomplete
- **WHEN** a pair has at least one disqualifying required target or an incomplete ledger
- **THEN** that pair MUST remain unqualified and retain its pair-local evidence
- **AND** CEX MUST NOT infer or emit an aggregate verdict for any sibling pair

#### Scenario: A gap affects no submitted target
- **WHEN** a sequence discontinuity re-anchors before the next submitted target but could hide an OKX change inside the requested window
- **THEN** the required clock MAY still qualify if every submitted target is fresh
- **AND** `source_event_enumeration_eligible` MUST be false until the discontinuity is positively resolved

### Requirement: CEX required clocks are role-neutral
CEX SHALL bind and qualify the exact supplied required-clock bytes, target IDs,
target times, projection hash, pair, window, construction mode, current policy
pins, and freshness bound. The ledger codec MUST receive that authoritative
clock context and reject an unknown, duplicated, omitted, changed, or
misordered target. Every disposition's retained record references MUST resolve
and the referenced record interval MUST contain or affect that target.

CEX MUST NOT distinguish bootstrap, nominal, or admitted Maker clocks in its
request or qualification logic. Candidate A/B/C names,
`nominal_policy_opportunity_clock`, `admitted_policy_required_clock`, Maker
scheduler/configuration fingerprints, DEX inputs, target-to-invocation
projections, blocked dispositions, and Maker derivation descriptors remain
outside CEX qualification authority.

#### Scenario: Two Maker clock roles contain identical CEX inputs
- **WHEN** two requests supply byte-identical required clocks and CEX policy inputs but Maker assigns them different orchestration roles
- **THEN** CEX qualification behavior and identities MUST be identical
- **AND** no role selector or Maker descriptor may alter the CEX outcome

### Requirement: The package exposes a source-complete policy-neutral OKX tape operation
CEX SHALL expose a server-independent package-library operation that produces a
complete policy-neutral OKX top-100 state/freshness-change stream for one pair
and bounded window when provider-object enumeration is positively complete and
`source_event_enumeration_eligible = true`. The tape SHALL contain one bound
initialization state and one canonical state after every sequence-valid OKX
event group that changes the top-100 book or advances the valid source
time/sequence used for freshness. It MUST scan the complete provider window
independently of any submitted required-clock targets and MUST NOT filter
changes using Maker policy.

The tape SHALL use the pinned policy-neutral qualification capability and
construction-mode identity; it MUST NOT label these rows
`sampled_top_n_snapshot`. It SHALL enter Parquet through the normal
archive-forwarder, promotion, qualification, exact-selection,
replay-qualified-view, and exporter-v2 machinery in the disposable
`sandbox/cex-archive-local` archive. No qualification-only Parquet writer MAY
claim normal selection, receipt, promotion, or exporter identities. The
existing levels and depth-summary Parquet projection schemas MAY be reused
because the tape emits canonical full book states with the same physical
columns. Existing qualification-record and exporter-result documents SHALL bind
the construction identity, canonical schema, capability, adapter and
acquisition policies, complete expected/observed object inventory, sandbox
selection/receipt/export identities, artifact hashes, exact state count, and
window. This adds no package schema: schema manifest v3 remains exactly twelve
entries.

Tape acquisition SHALL yield at most four complete states from the
reconstructor before downstream backpressure is observed, submit at most 1,000
canonical rows and 5,242,880 JSON bytes per forwarder batch, and allow exactly
one forwarder request in flight. Every submitted batch MUST be acknowledged
before the next provider object is read. The tape SHALL contain exactly one
initialization/support state, which MAY precede the window, followed only by
state changes with source times in `[window.start, window.end)`; it MUST emit no
event at the exclusive end boundary.

`source_tape_eligible` SHALL require `source_event_enumeration_eligible`,
positive complete inventory, a complete state-change projection, and matching
pinned schema, construction-mode, capability, policy, archive, selection,
export, and artifact identities. It MUST NOT require or interpret a Maker
bootstrap/admitted clock or Maker derivation descriptor.

#### Scenario: A clock-bound export contains only sampled states
- **WHEN** an ordinary clock-bound backfill exports only states selected at its required targets
- **THEN** that export MUST be ineligible as a source-complete tape
- **AND** a caller MUST NOT infer omitted OKX change timestamps from it

#### Scenario: Expected and observed source inventories differ
- **WHEN** any expected provider object or selected interval is missing, duplicated, mutable, or not bound to its observed checksum
- **THEN** `source_tape_eligible` MUST be false even if no submitted clock target was affected
- **AND** no success tape artifact may be committed

#### Scenario: Tape archive semantics are verified
- **WHEN** the source tape is routed through the disposable archive and exported
- **THEN** streaming expected-versus-observed semantic digests MUST bind every canonical state and boundary
- **AND** seam and coverage verdicts MUST be calculated from actual tape rows and source inventory rather than counts, empty boundary digests, or asserted booleans

#### Scenario: Tape production fails after a valid attempt directory exists
- **WHEN** provider acquisition, reconstruction, forwarder admission, promotion, selection, or export throws or returns an invalid outcome for one pair
- **THEN** that pair MUST commit a durable closed failure result naming the stable reason and retained partial-evidence hashes
- **AND** it MUST commit no tape Parquet or success manifest, while pair-prefixed paths prevent collision with independent attempts

### Requirement: Maker derivation and capacity semantics remain outside CEX
CEX SHALL treat Maker derivation and capacity semantics as external caller
concerns. Maker MAY use the source-complete tape and CEX target dispositions to
construct its own policy clocks, invocation projections, blocked outcomes, and
versioned derivation descriptor. CEX MUST NOT ship or validate the Maker
descriptor schema as qualification authority and MUST NOT validate scheduler
ordering, DEX input, Maker policy/configuration, target-to-invocation, or
blocked-outcome semantics.

Maker SHALL preflight its untruncated target count before request construction.
CEX SHALL independently reject any received required clock above the current
100,000-target resource ceiling. CEX MUST NOT merge or deduplicate targets to
fit, but it has no authority over the number of Maker policy invocations mapped
to one CEX target.

#### Scenario: A Maker descriptor is invalid
- **WHEN** a Maker-owned derivation descriptor has an invalid scheduler,
  DEX-input, mapping, or blocked-outcome binding
- **THEN** Maker MUST reject it before consumer proof
- **AND** CEX MUST NOT acquire that semantic validation responsibility
