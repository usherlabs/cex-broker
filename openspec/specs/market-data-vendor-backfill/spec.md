# market-data-vendor-backfill Specification

## Purpose
Define the bounded CEX-owned library/tool for acquiring historical order-book
data, preserving vendor provenance, and promoting exact qualified scopes into
the canonical archive for deterministic downstream replay.

## Requirements
### Requirement: Final v1 wire artifacts are strict and cross-language canonical
The package SHALL publish strict snake_case JSON Schema Draft 2020-12 artifacts
for the request, result, required clock, archive selection, and promotion
receipt. It SHALL publish versioned capability and resource policy manifests
and one manifest that binds every artifact ID to its RFC 8785 JCS SHA-256
digest. Unknown fields, non-lowercase UUIDs or hexadecimal digests, non-fixed
UTC RFC3339 timestamps, unsafe integers, and floating-point hashed wire fields
MUST be rejected. A document digest MUST omit only its own digest field.

#### Scenario: TypeScript and Python validate the same fixture
- **WHEN** CEX, Fiet TEE, and Maker load a published golden fixture
- **THEN** every implementation MUST validate the same document and compute the same canonical digest
- **AND** official RFC 8785 edge vectors MUST have identical hashes

#### Scenario: Capture checksums remain compatible
- **WHEN** final v1 document identities are introduced
- **THEN** capture-row and capture-bundle checksums MUST remain unchanged
- **AND** document identity MUST NOT use the capture checksum helper that removes checksum-named fields

### Requirement: Request policy is caller-resolved and deployment details stay private
The request SHALL contain canonical scope, half-open window, depth, construction
mode, source policy, target environment/cluster, required-clock reference,
initial selection, expected canonical schema, and coverage policy
`prior-asof-strict/v1`. `max_asof_lag_ms` MUST be supplied explicitly and
applied without defaulting, widening, or clamping. Provider names/symbols,
adapter allowlists, object paths, fetch margins, resource budgets, and package
expectations MUST NOT be request fields. Product pins SHALL bind capability and
resource policy IDs and canonical digests.

#### Scenario: Idempotency identity is computed
- **WHEN** a valid request is decoded
- **THEN** `idempotency_key` MUST bind canonical scope, clock hash, coverage and source policy, expected schema, environment, and cluster
- **AND** it MUST exclude request/attempt IDs, provider mapping, resource policy, paths, and timestamps

### Requirement: Archive preflight returns an exact content-addressed selection
Archive preflight SHALL return a coverage class, exact bundle intervals,
requested intervals, precedence, qualification and receipt evidence, and exact
prior-as-of `support_anchors`. `selection_sha256` MUST bind scope, required
clock, coverage policy, exact bundles, requested intervals, precedence,
qualification, receipts, and anchors. Every anchor SHALL identify its capture
bundle, raw capture, snapshot, source time, normalized summary checksum, and a
reference to origin/qualification/receipt metadata.

#### Scenario: Source policy resolves coverage
- **WHEN** `authoritative_window` resolves coverage
- **THEN** only promoted vendor bundles MUST be returned
- **WHEN** `fill_gaps` resolves coverage
- **THEN** retained production intervals and promoted gaps MUST be returned with archive-wins precedence

#### Scenario: Qualified request is repeated
- **WHEN** an identical qualified vendor request is preflighted again
- **THEN** the original stored selection and receipt MUST be returned
- **AND** the reader MUST reject identity mismatches or conflicting stored content

### Requirement: Full receipt identity and semantic promotion identity are distinct
`promotion_identity_sha256` SHALL be the timestamp-independent semantic
deduplication identity. `receipt_id` SHALL be the RFC 8785 JCS SHA-256 digest of
the full receipt including fixed UTC `verified_at`. Qualification state SHALL
be append-only and support `qualified`, `quarantined`, and `revoked`.

#### Scenario: Vendor qualification changes
- **WHEN** the latest qualification state is quarantined or revoked
- **THEN** vendor rows MUST be excluded from qualified selection
- **AND** production rows MUST retain existing checksum/provenance eligibility without vendor receipts

### Requirement: Closed CEX outcomes match durable job ownership
The CEX domain runner SHALL return only `request_invalid`,
`archive_preflight_failed`, `already_covered`, `promoted`,
`capability_unsupported`, `credentials_missing`, `vendor_fetch_failed`,
`archive_ingest_failed`, or `promotion_verification_failed`. Invalid requests
and archive preflight errors MUST map to their dedicated statuses. Resource
budget exhaustion MUST use `vendor_fetch_failed` subreason
`resource_limit_exceeded`; predictable resource-policy scope rejection MUST use
`capability_unsupported/resource_policy_scope_exceeded`. Post-promotion
qualification/selection query failure MUST be `promotion_verification_failed`.

#### Scenario: Consumer or process proof fails
- **WHEN** the result is missing/corrupt, the process times out, or Maker's real loader finds insufficient post-backfill coverage
- **THEN** Maker MUST own that outcome outside the CEX domain result

### Requirement: Backfill contracts are versioned, deterministic, and secret-free
The core library SHALL validate `market-data-vendor-backfill-request/v1` before
performing network access and SHALL return its existing closed CEX domain
outcome. The CEX-owned executable SHALL wrap that outcome in
`market-data-vendor-backfill-result/v2`; the package MUST retain the complete
result v1 schema, fixture, codec, manifest, and TypeScript API for compatibility
but the new executable MUST never emit result v1. The request MUST contain
request and idempotency identities, one exchange/pair/market/feed scope, a
bounded half-open source-time window, depth, construction mode, required-clock
identity, maximum prior-as-of lag, order-book source and coverage policies,
target archive identity, initial archive selection, and expected canonical
schema identity. Request, result, logs, errors, receipts, and retained evidence
MUST NOT contain vendor, ClickHouse, archive-forwarder, Vault, or SSH
credentials.

#### Scenario: Invalid request fails before network access
- **WHEN** a request omits a required field, contains an unknown enum, exceeds a bounded budget, or carries an idempotency identity that does not match its canonical business content
- **THEN** the core API MUST return a typed validation failure before invoking
  any archive or provider dependency

#### Scenario: Secrets are supplied outside wire files
- **WHEN** the worker authenticates to a provider, ClickHouse, or the archive forwarder
- **THEN** credentials MUST arrive through injected dependencies or the executable's closed environment allowlist
- **AND** no credential value MAY appear in request/result JSON, receipt projections, argv, logs, retained subprocess output, or evidence hashes

#### Scenario: Legacy v1 consumer imports the patch release
- **WHEN** a consumer loads the existing result v1 codec, fixture, schema path, or manifest path from `0.2.47`
- **THEN** its bytes, identifiers, canonical hashes, and public TypeScript meaning MUST remain unchanged from `0.2.46`

### Requirement: Worker execution has one reusable core API and closed outcomes
CEX Broker SHALL publish
`runMarketDataVendorBackfill(request, dependencies)` from a package subpath that
does not import or start the gRPC server. Every completed call MUST return
exactly one status from `request_invalid`, `archive_preflight_failed`,
`already_covered`, `promoted`,
`capability_unsupported`, `credentials_missing`, `vendor_fetch_failed`,
`archive_ingest_failed`, or `promotion_verification_failed`, together with a
stable reason code, optional stable subcode, and secret-free diagnostics. Only
`already_covered` and `promoted` are success statuses.

#### Scenario: Core API is consumed as a library
- **WHEN** Fiet TEE or a conformance harness imports the worker package subpath
- **THEN** it MUST be able to invoke the core function with explicit
  dependencies
- **AND** importing the subpath MUST NOT register RPC handlers, start the broker,
  load exchange credentials, or start an always-on process

#### Scenario: Dependency failure maps to one durable status
- **WHEN** a provider, archive reader, forwarder writer, or promotion verifier
  fails after request validation
- **THEN** the core API MUST return the corresponding closed status and stable
  reason code
- **AND** an uncategorized thrown error MUST NOT be the only observable outcome

### Requirement: Dispatch is qualified-archive-first and capability-before-credentials
The worker SHALL query replay-qualified ClickHouse views for the complete
requested scope before consulting provider capability or credentials. Complete
qualified coverage MUST return `already_covered`. If coverage remains partial or
zero, the worker MUST evaluate the provider registry and requested scope before
resolving credentials or downloading data.

#### Scenario: Concurrent promotion makes the worker a no-op
- **WHEN** the caller observed a miss but the worker's own preflight finds
  complete qualified coverage
- **THEN** the result MUST be `already_covered`
- **AND** the worker MUST NOT inspect vendor credentials or fetch vendor data

#### Scenario: Unsupported scope precedes missing credentials
- **WHEN** the configured provider does not support the requested venue, market
  type, pair, feed, depth, construction mode, source policy, or window
- **THEN** the result MUST be `capability_unsupported`
- **AND** the worker MUST reach that outcome without resolving provider
  credentials

### Requirement: CryptoHFTData acquisition is bounded and provider-truthful
The initial provider adapter SHALL identify CryptoHFTData separately from the
archive source, discover supported symbols without credentials when possible,
authenticate downloads using a non-URL bearer mechanism when credentials are
required, fetch only the hourly files authorized by the request and boundary
lookback, and validate every dataset before normalization. The effective
initialization lookback MUST come from the pinned acquisition policy and MUST
NOT exceed the pinned resource-policy ceiling. The adapter MUST NOT
advertise MEXC, exact L2 reconstruction, or another unsupported scope merely
because an API key is present.

#### Scenario: Supported sampled order-book scope is fetched
- **WHEN** the capability registry confirms a supported exchange/market/symbol
  ORDERBOOK request with `sampled_top_n_snapshot`
- **THEN** the adapter MUST fetch only the bounded hourly objects required for
  the window and initialization boundary
- **AND** it MUST record provider exchange ID, resolved symbol, object paths or
  stable object identities, response checksums, row counts, and adapter version
  without retaining credentials

#### Scenario: Download exceeds request budget
- **WHEN** the next provider object would exceed the request's maximum files,
  bytes, rows, duration, or boundary lookback
- **THEN** the worker MUST stop acquisition and return `vendor_fetch_failed`
  with a stable budget subreason
- **AND** it MUST NOT promote a partial provider dataset

### Requirement: Vendor snapshot and update events reconstruct deterministic top-N books
The worker SHALL parse vendor-normalized L2 snapshot and update records, normalize
provider-specific timestamp units, validate exchange/pair identity, apply
snapshot resets and zero-quantity deletions, validate all available update-chain
fields, and sample prior-as-of book state for the requested evaluation clock.
Every emitted snapshot MUST have non-empty strictly ordered bid and ask sides,
an uncrossed spread, no future leakage, the requested depth, and reproducible raw
and normalized semantic checksums. V1 MUST reject exact L2 construction unless a
venue-specific complete continuity proof is implemented.

#### Scenario: Snapshot and updates produce a canonical sample
- **WHEN** a complete snapshot is followed by a continuous ordered update stream
  covering a required evaluation timestamp
- **THEN** the reconstructed prior-as-of top-N state MUST be passed through the
  shared canonical order-book row builder
- **AND** replaying the same dataset under the same adapter and canonicalization
  versions MUST reproduce snapshot IDs and normalized-row checksums

#### Scenario: OKX snapshot anchors a prefixed hourly object
- **WHEN** a proven OKX object contains update rows before a complete snapshot
  whose `prevSeqId` snapshot sentinel is `-1`
- **THEN** the adapter MUST ignore only the unanchored delta prefix and begin
  replay from that complete snapshot when it is at or before the earliest
  required clock
- **AND** every applied update MUST link its `prevSeqId` to the current `seqId`,
  including a linked heartbeat or maintenance reset
- **AND** the adapter MUST fail `update_before_snapshot` or `update_chain_gap`
  rather than infer missing state or accept an unlinked reset

#### Scenario: Sequence or clock semantics are ambiguous
- **WHEN** an update chain has a gap, regression, ambiguous snapshot grouping,
  unsupported timestamp unit, future observation, crossed book, or missing side
- **THEN** normalization MUST fail before archive submission
- **AND** the result MUST be `vendor_fetch_failed` with a stable validation
  subreason rather than a downgraded construction mode

### Requirement: Archive submission is chunked, retryable, and idempotent
Each normalized request SHALL produce one content-addressed capture bundle whose
identity binds request scope, provider dataset checksums, adapter version,
canonical schema, and checksum algorithm. The worker MUST submit supported rows
through the archive-forwarder in deterministic batches within its row and byte
limits. Every batch ID MUST bind capture bundle, table, chunk index, and chunk
content so retrying an ambiguous or partial submission is safe. The worker MUST
NOT write ClickHouse directly.

#### Scenario: Forwarder partially fails a submission
- **WHEN** one deterministic chunk is accepted and a later chunk fails
- **THEN** the worker MUST return `archive_ingest_failed` unless bounded retry
  completes all chunks
- **AND** a rerun with the same request and provider content MUST reuse stable
  capture and batch identities so already committed chunks do not create a new
  replay identity

#### Scenario: Forwarder rejects a row contract
- **WHEN** the forwarder rejects external-backfill provenance, table identity,
  row schema, checksum, or batch limits
- **THEN** the worker MUST return `archive_ingest_failed` with a bounded reason
- **AND** it MUST NOT write a passing promotion record

### Requirement: FIET-1017 promotion is semantic and commits qualification last
After all physical rows are submitted, the worker SHALL verify the candidate
bundle through unqualified canonical views, compare canonical keys and semantic
checksums with the normalized vendor projection, prove that pre-existing
qualified prefix and suffix digests are unchanged, validate old/new seams,
conflicts, depth, construction, future-leakage, and required-clock coverage, and
only then submit `market-data-vendor-backfill-promotion-receipt/v1` as the final
qualification commit. `promotion_identity_sha256` MUST hash the stable semantic
promotion content, while `receipt_id` MUST hash the complete receipt including
its fixed UTC `verified_at`; verification time MUST NOT alter request, capture,
or semantic promotion identities.

#### Scenario: Candidate bundle matches and expands the timeline
- **WHEN** queried candidate rows match every normalized vendor row and the
  expanded candidate timeline passes all integrity and coverage gates
- **THEN** the worker MUST write one passing promotion record through the
  archive-forwarder
- **AND** a subsequent qualified preflight MUST include the promoted scope before
  the result can be `promoted`

#### Scenario: Physical rows land but verification fails
- **WHEN** any candidate row is missing, changed, conflicted, discontinuous,
  future-leaking, consumer-schema-incompatible, or insufficient for the
  required clock
- **THEN** the worker MUST return `promotion_verification_failed` with a stable
  reason and optional subcode
- **AND** the physical rows MUST remain excluded from replay-qualified views

### Requirement: Maker consumer proof remains independently bound
The CEX promotion receipt SHALL prove CEX-owned canonical promotion and exporter
contract compatibility. An actual Fiet Maker loader or policy proof MUST remain
Maker-owned and MUST bind its post-promotion query and final artifact hashes to
the CEX receipt. The CEX worker MUST NOT import or execute Maker application or
policy code.

#### Scenario: CEX promotion succeeds before Maker proof
- **WHEN** the worker produces a passing promotion receipt
- **THEN** the bundle MAY become eligible for qualified canonical reading
- **AND** economics quotability MUST still require Maker's independent
  post-promotion query and consumer evidence outside this core API
