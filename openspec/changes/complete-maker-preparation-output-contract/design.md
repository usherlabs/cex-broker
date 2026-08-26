## Context

The implementation baseline is `@usherlabs/cex-broker@0.2.50` plus the OKX
streaming, sequence, re-anchoring, retry, quarantine, diagnostics, and
archive-forwarder image work from PR #155, aligned in this worktree at
`7db59163428087edc67752d00619ea883d6354dd`. That code
can express bounded failure summaries and already contains the exact-selection,
promotion, exporter, packaging, and release-evidence foundations, but the full
Maker acceptance output does not exist: the current CryptoHFTData window fails
832 ARB-USDC clocks and one ARB-USDT clock at 5,000 ms, PR #155 is unpublished,
and the exporter descriptor does not bind a Parquet schema identity.

The current implementation also accepts capability v1/v2/v3 and resource v1/v2
independently. That permits mixed tuples and lets a legacy request create a
split identity chain: the file-job envelope reports the current pair while a
promotion receipt copies the accepted request pins. The target state is one
exact live capability-v3/resource-v2 tuple. Old archive rows and receipts remain
append-only evidence, but a vendor bundle needs a new current qualification
receipt before it can support a current successful selection.

Maker consumes one pair-scoped CEX result at a time. It owns package resolution,
process supervision, independent post-promotion validation, row adaptation, the
real loader, its four final files, and atomic two-pair publication. CEX owns the
provider source, reconstruction, qualification, exact selection, promotion,
export, release, and CEX-side evidence.

## Goals / Non-Goals

**Goals:**

- Establish one coherent current policy and producer identity chain from request
  through result, receipt, export, conformance fixture, package, and product pin.
- Preserve the v0.2.50 caller-owned attempt boundary, no-follow path checks,
  exporter read-only authority, and existing `cex-broker` bin behavior.
- Generate complete, bounded source-forensics evidence without creating a
  second reconstruction algorithm or acceptance path.
- Produce a source-complete, policy-neutral OKX top-100 state-change tape so
  Maker can materialize Candidate C without inferring changes from Candidate A
  samples.
- Preserve the small atomic backfill result and Maker-consumed summary
  diagnostics while providing detailed qualification evidence separately.
- Give each exported Parquet projection an immutable physical schema identity
  and bind it in exporter result v2.
- Produce and independently audit a registry successor that can be invoked from
  a clean Node 22 extraction and consumed by Maker.
- Make the exact reported unit-suite failure and all broader package/source
  acceptance gates explicit implementation work.

**Non-Goals:**

- Changing the 5,000 ms prior-as-of bound, scheduler cadence, depth requirement,
  or ClickHouse-first `fill_gaps` policy. Candidate C clock derivation is
  explicitly Maker-owned and the CEX qualification tape receives a distinct
  construction identity rather than changing sampled-snapshot meaning or
  becoming a normal Maker backfill request mode.
- Adding a CEX multi-pair request or aggregate result.
- Running Maker strategy, policy, backtest, loader, thesis, or final artifact
  publication inside CEX Broker.
- Treating MEXC execution products, Binance depth, quote conversion, or a
  synthetic snapshot as OKX source evidence.
- Procuring or authorizing an alternate provider. An alternate source requires
  an explicit later decision if corrected CryptoHFTData objects are unavailable.
- Keeping prior policy versions selectable in the current runtime for backward
  compatibility.
- Treating the reusable resource-policy ceiling as the exact event count of one
  still-unfrozen Maker clock.

## Decisions

### 1. Current policy pins are validation inputs, not runtime selectors

The request schema remains the current request v1 wire, but its codec accepts
only the exact capability-v3/resource-v2 tuple. It rejects previous and mixed
tuples before archive, capability, credential, provider, or forwarder access.
The domain request receives already-resolved current limits and profile data;
core code no longer searches arrays of legacy policies. Result v2 always
reports the same v3/v2 pair, and a promotion receipt must compare its request
pins with those current constants before construction.

Capability policy remains the signed allowlist and provider/adapter/acquisition
identity. Resource policy remains the signed workload ceiling. This preserves
their authorization and evidence function while removing their use as
compatibility switches.

Alternative considered: continue accepting older pins and normalize them to
current output. Rejected because it makes the receipt misstate which policy
authorized acquisition and preserves multiple live logical paths.

### 2. Historical evidence is retained without shipping a legacy execution path

Existing ClickHouse rows, receipts, selections, and release evidence remain
append-only and queryable according to their stored identities. Current request
validation, provider dispatch, public conformance fixtures, and executable
package exports do not accept or advertise legacy policy paths. A pure
production `already_covered` selection needs no vendor receipt. A selection
containing a vendor bundle whose latest passing receipt uses prior pins is not
current-qualified: CEX must fully reverify it and append a v3/v2 receipt before
returning a current success. Static evidence needed to audit a historical
release belongs with that release, not in the current executable registry.

Alternative considered: delete or rewrite stored historical receipts. Rejected
because it would destroy evidence and is unnecessary to remove live backward
compatibility.

### 3. OKX gaps re-anchor on the one production reconstruction path

For OKX `prevSeqId` discontinuities, the reconstructor records the expected and
observed sequence, clears its current book, and continues scanning. It remains
unanchored until a later complete snapshot. After the whole required clock is
scanned, affected targets cause
`vendor_fetch_failed/update_chain_gap` with bounded summary diagnostics. If a
complete snapshot re-anchors before the next required target, that target can
qualify; the non-affecting discontinuity remains forensic evidence. Ambiguous
groups, invalid values, crossed books, and unsupported non-OKX sequence
semantics continue to fail immediately.

Alternative considered: fail on the first OKX gap. Rejected because it loses
the later anchor and full-clock failure summary that PR #155 can provide.

### 4. Source forensics is a streaming observer over the production reconstructor

The OKX reconstructor exposes typed observation events for provider-object
boundaries, complete snapshot anchors, sequence transitions, required-clock
samples, invalidations, and re-anchors. The default sink is a bounded no-op; the
qualification harness supplies a ledger sink. Both paths execute the same row
validation, grouping, mutation, sampling, canonicalization, and failure logic.
Tests compare observer-disabled and observer-enabled results over identical
fixtures.

The ledger sink coalesces consecutive unanchored, stale, and future-state
targets into maximal interval records and writes sequence discontinuities and
provider-object checksum conflicts as explicit records. It retains only
identities, checksums, sequences, timestamps, counts, anchors, and lag buckets.
It does not retain raw rows or error bodies. The limits are exactly 100,000
records and 67,108,864 canonical UTF-8 JSON bytes. Exceeding either never throws
into reconstruction: observation continues, the sink counts omitted records,
and it atomically finishes a ledger marked `complete = false`; only
qualification fails.

Alternative considered: append JSON arrays or encoded ledger fragments to
backfill result v2 diagnostics. Rejected because that wire permits only a
64-member primitive summary map and is intentionally consumed as a small
failure projection.

Alternative considered: a special forensic reconstruction command or adapter
mode. Rejected because it could diverge from the source path being qualified.

### 5. Qualification evidence is separate from the runtime result

Backfill result v2 remains the runtime commit marker and continues to carry
stable subcodes plus bounded summary diagnostics. A CEX qualification run writes
`market-data-source-forensics-ledger/v1` first and then atomically writes
`market-data-source-qualification-record/v1`, which binds the ledger schema,
relative path, SHA-256, bytes, record count, and completeness. Both schemas are
published package assets and product-pin entries. The qualification harness
uses the observer as a library; there is no third executable and no Maker
request field. The qualification evidence manifest, not the normal Maker
request, owns the instance reference.

This separation lets Maker continue consuming the established result shape
while CEX retains enough detail to distinguish source corruption, mutable
bytes, provider-row loss, adapter object-boundary/order defects, genuine market
inactivity, and unresolved evidence.

### 6. Backfill result v2 freezes the Maker-consumed failure projection

The backfill result retains the nine closed domain statuses. A measured
provider or reconstruction failure cannot rely on status alone: it carries a
stable detailed subcode and a bounded primitive diagnostics map. Clock failures
freeze total, covered, missing, unanchored, future-state, first/last affected,
maximum-lag, and six cumulative coverage buckets at 1,000, 2,000, 5,000,
10,000, 30,000, and 60,000 ms. Sequence and provider-object failures add their
stable safe fields. These keys are the small Maker-facing projection and must
agree with a retained forensic ledger.

Alternative considered: expose only the nine status values or embed forensic
arrays in diagnostics. Rejected because the former loses actionable output and
the latter violates the established 64-entry primitive result boundary.

### 7. Exporter result v2 binds two explicit Parquet projection schemas

The package adds immutable schemas for the levels-Parquet and
depth-summary-Parquet projections. Each schema document canonically defines the
ordered capture-core column names, physical/logical types, nullability, and
relevant metadata. It excludes Maker run-scoped fields and is not a hash of a
ClickHouse- or library-specific serialized schema. The exporter validates the
Arrow/Parquet schema before committing and places the corresponding schema ID
and JCS SHA-256 in each artifact descriptor. A mismatch returns
`archive_data_invalid/parquet_projection_schema_mismatch` with no successful
descriptors.

`cex-order-book-canonical/v1` remains the row/archive semantic identity;
projection schema IDs are the two file identities, and their documents must
declare and preserve that capture-core relationship.

`cex-canonical-orderbook-export-result/v2` requires these fields. The exporter
product version becomes `cex-canonical-orderbook-export/v2`; the request can
remain v1 because its input contract is unchanged. The backfill product and
backfill result remain at their current versions.

Alternative considered: put the same broad `cex-order-book-canonical/v1`
identity on both descriptors. Rejected because levels and summary have distinct
physical columns and Maker needs to validate each file independently.

### 8. Dependent release identities are versioned together

Changing the exporter result and adding projection and qualification schemas
creates schema manifest v3 and
`cex-market-data-preparation-product-pin/v2`. The manifest and pin contain
exactly twelve current schema entries: the six unchanged request/result/clock/
selection/receipt/export-request schemas, exporter result v2, product pin v2,
two projection schemas, forensic ledger v1, and qualification record v1. The
pin also binds capability v3, resource v2, and both executable hashes. Counts
and exact hashes are generated from canonical artifacts rather than copied into
source prose.

Registry metadata `gitHead`, product pin `package.npm_git_head`, and runtime
result `producer.package.git_head` are intentionally distinct context-specific
field names for the same baked release commit. They are mapped and compared,
not renamed. The backfill product remains
`market-data-vendor-backfill/v1`; the exporter becomes
`cex-canonical-orderbook-export/v2`.

Release identity is frozen before any identity-bound live evidence. CEX first
queries npm and reserves an unused successor, commits that version with every
implementation and generated identity, merges PR #155, and freezes the exact
clean merge commit. Deterministic and live Candidate A/C gates then run from a
clean checkout of that commit. The tag and registry package MUST name that same
commit; registry URL, npm integrity, tarball SHA-256, npm `gitHead`, and
executable hashes are derived from independently downloaded registry bytes and
verified in a fresh extraction. A merge, rebase, squash, version change, or
other byte/`gitHead` change invalidates pre-freeze identity-bound evidence and
requires the affected gates to rerun.

Alternative considered: mutate exporter result v1 or product pin v1 in place.
Rejected because Maker pins their existing JCS identities and must fail closed
on changed content.

### 9. Resource ceilings and exact Maker clocks remain distinct

Capability v3 is the signed allowlist for provider, adapter, acquisition,
exchange, pair, construction mode, source policy, and its 400-depth profile
ceiling. Resource v2 is the reusable signed job-safety ceiling: 2,678,400,000 ms
window, 100,000 required events, depth 500, 10,000 files, 107,374,182,400
bytes, 1,000,000,000 rows, 86,400,000 ms duration, and 604,800,000 ms boundary
lookback. Neither policy is an API-version compatibility switch.

The required Maker output is narrower: pair-local `fill_gaps`, depth 100, and a
5,000 ms prior-as-of bound. Each frozen request binds its exact clock ID,
SHA-256, and event count; the reusable resource ceiling is not rewritten to one
candidate's count. A complete UTC day is `[00:00:00Z, next 00:00:00Z)` for
which every pair-local required target qualifies. Physical presence of every
nominal hourly provider object is not required when exact clock coverage is
otherwise proven.

Alternative considered: set `max_required_events` to the first candidate's
clock count. Rejected because it conflates a reusable safety ceiling with one
content-addressed request.

### 10. Source qualification and release are separate gates

Implementation correctness is established with deterministic fixtures and the
full repository test matrix. Source acceptance separately runs both pair-local
clocks over one common 20-to-30-complete-day window. Each pair must have a
complete ledger, zero missing or invalid targets, a complete exact selection,
and a successful export. If either pair fails, CEX retains pair-specific
evidence and does not claim the Maker dependency is qualified.

The reported branch unit failure receives its own RED/GREEN evidence entry with
the exact command, Bun/Node versions, environment assumptions, and failing
assertions. The repository-declared unit command is also required even if the
external command differs.

### 11. Candidate A is bootstrap evidence and dispositions are three-way

The existing 2,808-target ARB-USDC and 932-target ARB-USDT clocks are Candidate
A bootstrap clocks, not the final nominal timeline. Forensics ledger v1 gains
a separate ordered `target_dispositions` array that reconciles every original
target as fresh within 5,000 ms, positively proven inactive, or disqualifying.
Maker expands those target dispositions across every mapped policy invocation
and remains the sole owner of admitted clocks and `reference_depth_stale`
runtime outcomes.

`qualified`, `derivation_eligible`, and
`candidate_c_source_enumeration_eligible` are distinct predicates. Strict
qualification requires accepted reconstruction and all-fresh submitted
targets. Derivation eligibility permits proven inactivity but no disqualifying
target. Enumeration eligibility additionally rejects any window-wide
unresolved source evidence that could hide or alter an OKX event, including a
sequence gap that affected zero Candidate A targets.

### 12. Candidate C uses a source-complete sandbox-qualified tape

An ordinary Candidate A backfill emits only clock-sampled snapshots and cannot
enumerate Candidate C. The qualification harness therefore asks the same OKX
reconstructor to continue through the full source window and stream one bound
initialization state plus a canonical top-100 state after every sequence-valid
event group that changes the top-100 book or advances the source
time/sequence used for freshness. This projection is policy-neutral:
CEX validates source continuity and emits states; Maker decides which changes
are policy-relevant.

The tape uses the normal candidate/archive-forwarder, promotion, qualification,
exact-selection, replay-qualified-view, and exporter-v2 machinery inside a
disposable archive whose exact target is `sandbox/cex-archive-local`. Thus
"not production-qualified" means that no row, receipt, selection, or artifact
enters a production environment; it does not mean that the tape bypasses normal
qualification identities. A separate qualification-only Parquet writer is not
used and MUST NOT be represented as a normal selection, receipt, or exporter-v2
result.

The local ClickHouse runtime is immutable:
`clickhouse/clickhouse-server:24.8.14.39@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b`.
The bundle manifest binds that reference, resolved image ID/digest, and the
reported server version `24.8.14.39`.

Provider acquisition and tape archive submission are backpressured. The
reconstructor yields at most four complete states at a time; canonical archive
batches retain the existing maximum of 1,000 rows and 5,242,880 JSON bytes,
with exactly one forwarder submission in flight. The current batch must be
acknowledged before the next provider object is read. The projection contains
exactly one initialization/support state, which may precede the window, and
then only changes whose source time is in `[start, end)`; it emits nothing at
the exclusive end boundary. Any failure aborts finalization, removes or leaves
uncommitted partial Parquet, and commits no success manifest.

The physical levels and depth-summary Parquet projections remain those already
in schema manifest v3, so the package remains at exactly twelve schemas. The
tape does not reuse `sampled_top_n_snapshot` semantics. A new qualification
capability and construction identity bind full-window scanning, positive
expected/observed object inventory, top-100 state projection,
adapter/acquisition versions, sandbox selection/receipt/export identities, and
artifact hashes. Those identity changes regenerate policy and product-pin
hashes before the release commit is frozen.

Alternative considered: derive Candidate C from Candidate A snapshots.
Rejected because omitted change timestamps are unrecoverable and later
qualification cannot detect targets that were never enumerated.

### 13. Maker returns one versioned derivation descriptor

Maker owns `reference-depth-clock-derivation-descriptor/v1`; CEX retains a
qualification-only schema copy and canonical hash outside the normal request
and twelve-entry npm manifest. It binds materializer and configuration
identities, the sole scheduler, DEX inputs, the eligible OKX tape, CEX evidence,
original/admitted clock identities, mappings, per-target invocation expansion,
blocked dispositions, and the exact freshness-expiry rule. Exactly 5,000 ms is
fresh; expiry is the first actual controller opportunity whose age is strictly
greater, under `native_chronological_scheduler_v2` same-timestamp ordering.

Candidate C is materialized untruncated. A preflight records both CEX-target and
Maker-invocation counts. More than 100,000 CEX targets stops before request
construction and requires an explicit representation, partitioning, or resource
policy decision; economically distinct invocations are never deduplicated to
fit the ceiling.

### 14. The two-pair gate always commits a durable verdict

The repository-only orchestrator runs ARB-USDC and ARB-USDT as one bounded
qualification gate while retaining pair-scoped artifacts. On success it writes
one top-level success manifest binding both pair manifests and their hashes. On
any failure it writes a top-level failure verdict that names the failed pair,
uses a closed stable reason, and binds every retained partial-evidence hash.
Absence of a success manifest is never the only failure signal. Failure commits
no tape Parquet or success manifest for the affected pair. Pair-prefixed
Parquet names prevent the second pair from overwriting the first, and a later
failure verdict retains the earlier passing pair's manifest and artifact
hashes. Success removes any stale failure verdict; failure removes any stale
top-level success manifest.

The request target remains exactly `sandbox/cex-archive-local`, and the harness
uses the request's exact authorization ID and the disposable local cluster.
The forwarder's stable scope value `production` is an existing
mutation-authorization class, not an assertion that the target environment is
production. The guard is not renamed, bypassed, or weakened.

## Risks / Trade-offs

- [Removing live legacy policy acceptance breaks callers pinned to older
  policies] → Publish this as an explicit successor and require callers to use
  the current product pin; do not silently reinterpret old requests.
- [A current selection encounters a vendor bundle with only a historical
  receipt] → Preserve that receipt, exclude it from current qualification, and
  append a new receipt only after full current-policy reverification.
- [Observer instrumentation changes reconstruction timing or behavior] → Keep
  observations synchronous, bounded, and non-throwing even after evidence
  overflow, and test byte-for-byte/domain-outcome equivalence with the observer
  disabled and enabled.
- [Complete ledgers can grow with pathological source data] → Coalesce target
  intervals, stream records, enforce deterministic record/byte limits, report
  omissions, and fail qualification when evidence is incomplete.
- [Projection schema fingerprints vary across library versions] → Hash a
  canonical CEX schema document, validate physical Parquet against it, and pin
  the library/runtime through the immutable package rather than hashing
  library-specific schema serialization.
- [A source defect cannot be fixed in code] → Use the classification ledger to
  prepare a vendor escalation; do not weaken sequence, clock, depth, or
  freshness requirements.
- [Freezing release bytes after qualification invalidates producer identity]
  → Reserve and commit the successor, merge and freeze the exact release commit,
  then run every identity-bound deterministic and live gate from a clean
  checkout of that commit before tagging and publishing it unchanged.
- [Maker and CEX schema pins drift during the breaking exporter update] → Land
  generated CEX fixtures first, then update Maker from the published registry
  artifact and require cross-language conformance before acceptance.

## Migration Plan

1. Preserve the aligned v0.2.50 plus PR #155 baseline and reproduce the exact
   reported test failure without weakening its existing tests.
2. Add RED tests for rejecting previous and mixed policy tuples, excluding
   vendor bundles with only historical receipts, coherent current receipt
   identities, full-clock re-anchoring, observer equivalence, complete bounded
   ledgers, exporter schema descriptors, physical Parquet schema mismatch, and
   atomic failure results.
3. Remove legacy policy lookup/dispatch and current-package conformance exports;
   keep historical stored evidence untouched.
4. Implement the non-throwing streaming forensic observer, published ledger
   and qualification-record schemas, explicit future-state/checksum records,
   and implicated-object classification workflow.
5. Implement and generate the two capture-core Parquet projection schemas,
   exporter result v2, twelve-entry schema manifest v3, product pin v2, codecs,
   declarations, and fixtures.
6. Run unit, build, type, lint, package, conformance, ClickHouse, image-smoke,
   and secret-reflection checks and retain GREEN evidence for the reproduced
   external unit command.
7. Query npm for an unused successor, commit the version with all implementation
   and generated identities, merge PR #155, and freeze the exact clean merge
   commit.
8. From a clean checkout of that commit, run deterministic checks followed by
   the Candidate A bootstrap, source-enumeration, sandbox tape, Candidate C,
   final admitted-clock, promotion, selection, and export gates for both pairs.
9. Tag and publish that exact commit, independently download and audit the
   registry bytes, and derive the final product pin from the registry artifact.
10. Have Maker adopt the registry product pin, repeat final consumer and
    full-timeline proof, and land immutable evidence through a follow-up
    evidence PR. No production deployment is part of this migration.

Before Maker adopts the successor, rollback is simply withholding or reverting
its product pin. After adoption, rollback selects the prior immutable package
as a whole; CEX does not restore legacy dispatch inside the new package.
Append-only archive and qualification evidence is never deleted during
rollback.

## Open Questions

- What exact command and environment produced the user-reported failing unit
  suite? The implementation task cannot close until that runner is captured and
  reproduced or its environmental difference is proven.
- Can corrected immutable CryptoHFTData objects satisfy the full common window,
  or will the ledger require a vendor escalation? No alternate provider is
  authorized by this change.
- The successor version remains unset until the pre-qualification npm
  reservation step. Registry-derived URL, integrity, tarball, and executable
  hashes remain unset until post-publication independent audit.
