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
- Preserve the small atomic backfill result and Maker-consumed summary
  diagnostics while providing detailed qualification evidence separately.
- Give each exported Parquet projection an immutable physical schema identity
  and bind it in exporter result v2.
- Produce and independently audit a registry successor that can be invoked from
  a clean Node 22 extraction and consumed by Maker.
- Make the exact reported unit-suite failure and all broader package/source
  acceptance gates explicit implementation work.

**Non-Goals:**

- Changing the 5,000 ms prior-as-of bound, Maker clocks, scheduler cadence,
  construction mode, depth requirement, or ClickHouse-first `fill_gaps` policy.
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

The registry tarball is built and published before final release evidence is
generated. Registry URL, npm integrity, tarball SHA-256, npm `gitHead`, and
executable hashes are derived from downloaded registry bytes and verified in a
fresh extraction.

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
- [Publishing before the two-pair source gate creates another unusable release]
  → Generate the final product pin only after source qualification, package
  checks, and clean-extraction smoke pass.
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
7. Freeze exact pair-local clock hashes/counts and run full `fill_gaps`,
   depth-100 common-window qualification for ARB-USDT and ARB-USDC. Fix an
   evidenced adapter defect or escalate stable upstream object defects; repeat
   the whole window until both pair ledgers are complete and clean.
8. Run pair-scoped promotion, exact selection, and exact export, then have Maker
   validate both descriptors and consume both Parquet products with its real
   loader.
9. Publish the successor, download and audit the registry bytes in a clean Node
   22 extraction, generate the final product pin from those bytes, and update
   Maker's pin and schema copies.

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
- The final package version and every registry-derived hash remain intentionally
  unset until publication.
