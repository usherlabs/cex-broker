## ADDED Requirements

### Requirement: Backfill contracts are versioned, deterministic, and secret-free
The core library SHALL validate `market-data-vendor-backfill-request/v1` before
performing network access and SHALL return
`market-data-vendor-backfill-result/v1`. The request MUST contain request and
idempotency identities, a provider policy, one exchange/pair/market/feed scope,
a bounded half-open source-time window, depth, construction mode, required
evaluation-clock targets, maximum prior-as-of lag, order-book source policy,
bounded acquisition budgets, and expected product/schema identities. The
request, result, logs, errors, receipt, and retained evidence MUST NOT contain
vendor, ClickHouse, archive-forwarder, Vault, or SSH credentials.

#### Scenario: Invalid request fails before network access
- **WHEN** a request omits a required field, contains an unknown enum, exceeds a
  bounded budget, or carries an idempotency identity that does not match its
  canonical business content
- **THEN** the core API MUST return a typed validation failure before invoking
  any archive or provider dependency

#### Scenario: Secrets are supplied outside wire files
- **WHEN** the worker authenticates to a provider, ClickHouse, or the archive
  forwarder
- **THEN** credentials MUST arrive through injected dependencies, environment,
  or a secure-secret wrapper
- **AND** no credential value MAY appear in request/result JSON, receipt
  projections, argv, logs, retained subprocess output, or evidence hashes

### Requirement: Worker execution has one reusable core API and closed outcomes
CEX Broker SHALL publish
`runMarketDataVendorBackfill(request, dependencies)` from a package subpath that
does not import or start the gRPC server. Every completed call MUST return
exactly one status from `already_covered`, `promoted`,
`capability_unsupported`, `credentials_missing`, `vendor_fetch_failed`,
`archive_ingest_failed`, `promotion_verification_failed`, or
`post_backfill_coverage_insufficient`, together with a stable reason code and
secret-free diagnostics. Only `already_covered` and `promoted` are success
statuses.

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
lookback, and validate every dataset before normalization. The adapter MUST NOT
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
qualification commit. The receipt ID MUST be a canonical hash of its stable
semantic content; verification time MAY be reported but MUST NOT alter stable
request, capture, or semantic identities.

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
- **THEN** the worker MUST return `promotion_verification_failed` or
  `post_backfill_coverage_insufficient` as applicable
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
