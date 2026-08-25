## ADDED Requirements

### Requirement: Live preparation uses one current policy identity chain
The backfill request decoder and every downstream current output SHALL use the
exact capability policy `market-data-vendor-backfill-capabilities/v3` and
resource policy `market-data-vendor-backfill-resources/v2` tuple. The domain
runner, file-job result, promotion receipt, conformance fixture, package assets,
and product pin MUST use the same current capability, resource, adapter, and
acquisition identities. Capability policies v1/v2, resource policy v1, and any
mixed current/previous tuple MUST NOT be accepted for a new request, selected
by runtime dispatch, emitted by a current result or receipt, or used by current
conformance tests. Historical stored evidence MAY remain queryable for audit
but MUST NOT create a live compatibility branch.

#### Scenario: A request carries a previous or mixed policy tuple
- **WHEN** a new request carries capability policy v1/v2, resource policy v1, capability v3 with resource v1, or another tuple other than exact v3/v2
- **THEN** validation MUST return atomic `request_invalid` result-v2 evidence before archive, capability, credential, provider, or forwarder access
- **AND** the file job MUST NOT reinterpret the request under current policies

#### Scenario: A current request is promoted
- **WHEN** a capability-v3/resource-v2 request passes acquisition, normalization, archive submission, and promotion verification
- **THEN** the request, result envelope, receipt, adapter/acquisition evidence, conformance projection, and product pin MUST form one coherent current identity chain
- **AND** any identity mismatch MUST fail before the result can be `promoted`

### Requirement: Current capability covers the two Maker OKX pair products
Capability policy v3 SHALL advertise independent OKX Spot ORDERBOOK profiles
for ARB-USDT and ARB-USDC using provider exchange `okx_spot`, exact pair symbol
mapping, `sampled_top_n_snapshot`, both `authoritative_window` and `fill_gaps`,
and maximum profile depth 400. Resource policy v2 SHALL contain exactly:
`max_window_ms = 2678400000`, `max_required_events = 100000`,
`max_depth = 500`, `max_files = 10000`,
`max_bytes = 107374182400`, `max_rows = 1000000000`,
`max_duration_ms = 86400000`, and
`max_boundary_lookback_ms = 604800000`. Possession of a credential MUST NOT
broaden these profiles or limits.

The required Maker qualification outputs SHALL use pair-local `fill_gaps`,
depth 100, and maximum prior-as-of lag 5,000 ms. Each request MUST bind its
exact required-clock ID, SHA-256, and event count. The reusable resource-policy
ceiling MUST NOT be replaced by one frozen candidate clock count.

#### Scenario: Maker submits either required pair
- **WHEN** a valid current-policy request names OKX Spot ARB-USDT or ARB-USDC, `fill_gaps`, depth 100, an exact pair-local clock, and a window of no more than 31 days
- **THEN** capability evaluation MUST resolve the exact pair profile before credentials
- **AND** no symbol substitution, quote conversion, sibling-pair clock, union-clock behavior, or resource-ceiling rewrite MAY occur

#### Scenario: One common complete UTC day is counted
- **WHEN** qualification evaluates `[00:00:00Z, next 00:00:00Z)` for one pair
- **THEN** the day MUST count as complete only when every pair-local required target in that interval qualifies under the 5,000 ms rule
- **AND** physical presence of every nominal hourly provider object MUST NOT be required when exact clock coverage is otherwise proven

### Requirement: Failure summaries remain Maker-consumable and evidence honest
The CEX domain runner SHALL retain exactly the closed statuses
`request_invalid`, `archive_preflight_failed`, `already_covered`, `promoted`,
`capability_unsupported`, `credentials_missing`, `vendor_fetch_failed`,
`archive_ingest_failed`, and `promotion_verification_failed`. A handled provider
or reconstruction failure MUST carry a stable snake-case detailed subcode and a
result-v2 diagnostics map containing at most 64 primitive values; status alone
MUST NOT replace the detailed failure projection.

A required-clock failure MUST include `total_target_count`,
`covered_target_count`, `missing_target_count`, `unanchored_target_count`,
`future_state_target_count`, `max_prior_asof_lag_ms`, and cumulative
`covered_target_count_lag_1000_ms`, `covered_target_count_lag_2000_ms`,
`covered_target_count_lag_5000_ms`, `covered_target_count_lag_10000_ms`,
`covered_target_count_lag_30000_ms`, and
`covered_target_count_lag_60000_ms`. When applicable it MUST include
`target_time_ms`, `source_time_ms`, `asof_lag_ms`,
`first_missing_target_time_ms`, `last_missing_target_time_ms`,
`max_observed_asof_lag_ms`, and `missing_target_dates_utc`.

A sequence failure MUST include `sequence_gap_count`,
`first_sequence_gap_event_time_ms`, `last_sequence_gap_event_time_ms`,
`event_time_ms`, `expected_previous_sequence`,
`observed_previous_sequence`, and `observed_final_sequence`. An object failure
MUST expose only safe `dataset_object_identity`, `dataset_object_checksum`,
`failure_phase`, `attempt_count`, and `quarantined` evidence. Summary
diagnostics MUST agree with the bound source-forensics ledger when one is
retained.

#### Scenario: Required-clock coverage is insufficient
- **WHEN** reconstruction scans the complete pair-local clock and one or more targets lack a valid prior state within 5,000 ms
- **THEN** the result MUST be `vendor_fetch_failed` with the applicable stable detailed subcode and complete bounded summary keys and counts
- **AND** CEX MUST NOT reduce the failure to a log-only message or one of the nine status values without its detailed projection

#### Scenario: A secret is reflected by a dependency
- **WHEN** a provider, ClickHouse, or archive-forwarder error contains a supplied credential value
- **THEN** result and forensic evidence MUST redact that value before hashing or persistence
- **AND** raw dependency error text MUST NOT be retained

### Requirement: Successful pair output closes the CEX preparation boundary
For each pair-scoped request, only `already_covered` or `promoted` SHALL advance
to exact export. A successful result MUST contain a complete exact archive
selection. `promoted` MUST contain its newly verified current-policy promotion
receipt. `already_covered` MAY omit a receipt for a pure production selection,
but every selected vendor bundle MUST have a latest passing append-only receipt
under the exact current capability-v3/resource-v2 and adapter/acquisition pins.
The selection and receipts MUST bind exact scope, clock, intervals, bundle
origins, anchors, qualification, provider objects, canonical schema, policies,
and semantic verification identities.

Historical receipt bytes MUST remain unchanged. A vendor bundle whose only
passing receipt carries prior pins MUST be excluded from current qualification
until CEX fully reverifies it and appends a new current receipt; old bytes MUST
NOT be relabeled, copied into a current receipt without verification, or used to
authorize current success.

#### Scenario: One pair qualifies through fill-gaps
- **WHEN** retained qualified production intervals plus newly current-qualified vendor intervals cover every pair-local required target
- **THEN** the result MUST contain one complete archive-wins exact selection with ordered bundle, origin, interval, and current-receipt lineage
- **AND** Maker MUST be able to pass that selection directly to the pinned exporter without rediscovering it from a broad window

#### Scenario: An otherwise covered vendor bundle has only a historical receipt
- **WHEN** initial resolution finds physical vendor rows whose latest passing receipt uses a previous capability or resource pin
- **THEN** those rows MUST NOT support current `already_covered` or export success until full current-policy reverification appends a new receipt
- **AND** the historical receipt MUST remain immutable and queryable as audit evidence

#### Scenario: Promotion passes but the returned selection is incomplete
- **WHEN** post-promotion CEX resolution cannot return a complete exact selection
- **THEN** the file job MUST return `promotion_verification_failed`
- **AND** it MUST NOT emit a successful result that delegates CEX coverage completion to Maker

## MODIFIED Requirements

### Requirement: Full receipt identity and semantic promotion identity are distinct
`promotion_identity_sha256` SHALL be the timestamp-independent semantic
deduplication identity. `receipt_id` SHALL be the RFC 8785 JCS SHA-256 digest of
the full receipt including fixed UTC `verified_at`. Qualification state SHALL
be append-only and support `qualified`, `quarantined`, and `revoked`. Current
vendor selection SHALL additionally require the latest passing receipt for that
bundle to bind the exact current capability-v3/resource-v2 and
adapter/acquisition pins. Historical receipts SHALL remain immutable but SHALL
NOT satisfy that current selection predicate.

#### Scenario: Vendor qualification changes
- **WHEN** the latest qualification state is quarantined or revoked
- **THEN** vendor rows MUST be excluded from qualified selection
- **AND** production rows MUST retain existing checksum/provenance eligibility without vendor receipts

#### Scenario: A historical receipt is requalified
- **WHEN** a bundle with a prior-policy receipt passes full reverification under the exact current tuple
- **THEN** CEX MUST append a new current receipt with its own full and semantic identities
- **AND** the prior receipt MUST remain unchanged and MUST NOT be overwritten or reinterpreted

### Requirement: Backfill contracts are versioned, deterministic, and secret-free
The core library SHALL validate `market-data-vendor-backfill-request/v1` before
performing network access and SHALL return the existing closed CEX domain
outcome. The CEX-owned executable SHALL wrap that outcome only in
`market-data-vendor-backfill-result/v2`. The current package MUST NOT expose
result v1 as a runtime fallback, current conformance result, alternative
executable output, or live compatibility codec. Historical result-v1 evidence
MUST be audited with its immutable historical package.

The request MUST contain request and idempotency identities, one
exchange/pair/market/feed scope, a bounded half-open source-time window, depth,
construction mode, required-clock identity, maximum prior-as-of lag,
order-book source and coverage policies, target archive identity, initial
archive selection, and expected canonical schema identity. Request, result,
logs, errors, receipts, and retained evidence MUST NOT contain vendor,
ClickHouse, archive-forwarder, Vault, or SSH credentials.

The executable's closed credential/configuration environment allowlist SHALL be
exactly `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`,
`CEX_BROKER_ARCHIVE_FORWARDER_URL`,
`CEX_BROKER_ARCHIVE_FORWARDER_TOKEN`, and `CRYPTOHFTDATA_API_KEY`. Library
callers MAY supply the corresponding dependencies by injection. No credential
value MAY appear in wire files, argv, logs, retained subprocess output,
forensic evidence, or evidence hashes.

#### Scenario: Invalid request fails before network access
- **WHEN** a request omits a required field, contains an unknown enum, exceeds a bounded budget, carries a previous or mixed policy tuple, or carries an idempotency identity that does not match its canonical business content
- **THEN** the file job MUST atomically emit typed result-v2 validation failure before invoking any archive or provider dependency

#### Scenario: Secrets are supplied outside wire files
- **WHEN** the file job authenticates to a provider, ClickHouse, or the archive forwarder
- **THEN** credentials MUST arrive through injected dependencies, the exact closed executable environment allowlist, or a secure-secret launcher that populates that allowlist
- **AND** no credential value MAY appear in request/result JSON, receipt projections, argv, logs, retained subprocess output, forensic evidence, or evidence hashes

#### Scenario: A consumer requests result v1 behavior
- **WHEN** a caller expects the current executable, codec, or conformance fixture to emit or select result v1
- **THEN** the current package MUST reject that expectation rather than select a compatibility path
- **AND** historical result-v1 evidence MUST be audited using its immutable historical release

### Requirement: Dispatch is qualified-archive-first and capability-before-credentials
After strict request and exact policy-tuple validation, the file job SHALL query
replay-qualified ClickHouse views for the complete requested scope before
resolving provider capability or credentials. Complete current-qualified
coverage MUST return `already_covered`; physical vendor rows whose only receipt
uses previous pins MUST be treated as not current-qualified. If coverage remains
partial or zero, the file job MUST evaluate capability v3, resource v2, and the
requested scope before resolving credentials or downloading data.

#### Scenario: Concurrent promotion makes the file job a no-op
- **WHEN** the caller observed a miss but the file job's own preflight finds complete current-qualified coverage
- **THEN** the result MUST be `already_covered`
- **AND** the file job MUST NOT inspect vendor credentials or fetch vendor data

#### Scenario: Unsupported scope precedes missing credentials
- **WHEN** capability v3 does not support the requested venue, market type, pair, feed, depth, construction mode, source policy, or window
- **THEN** the result MUST be `capability_unsupported`
- **AND** the file job MUST reach that outcome without resolving provider credentials

#### Scenario: Mixed policy pins precede archive dispatch
- **WHEN** a request carries capability v3 with resource v1 or another non-current tuple
- **THEN** validation MUST return `request_invalid` before the qualified-archive query
- **AND** no archive, capability, credential, or provider dependency may be invoked

### Requirement: Vendor snapshot and update events reconstruct deterministic top-N books
The file job SHALL parse vendor-normalized L2 snapshot and update records,
normalize provider-specific timestamp units, validate exchange/pair identity,
apply snapshot resets and zero-quantity deletions, validate all available
update-chain fields, and sample prior-as-of book state for the requested
evaluation clock. Every emitted snapshot MUST have non-empty strictly ordered
bid and ask sides, an uncrossed spread, no future leakage, the requested depth,
and reproducible raw and normalized semantic checksums. V1 MUST reject exact L2
construction unless a venue-specific complete continuity proof is implemented.

For OKX, a `prevSeqId` discontinuity SHALL be recorded, current state SHALL be
cleared, and scanning SHALL continue while unanchored until a later complete
snapshot. The file job SHALL evaluate failure after scanning the complete
required clock. A discontinuity that affects required targets MUST return
`vendor_fetch_failed/update_chain_gap` with complete bounded diagnostics; a
later complete snapshot before the next required target MAY re-anchor that
target. Ambiguous groups, invalid decimals or timestamps, crossed or one-sided
books, and unsupported non-OKX sequence semantics MUST still fail immediately.

#### Scenario: Snapshot and updates produce a canonical sample
- **WHEN** a complete snapshot is followed by a continuous ordered update stream covering a required evaluation timestamp
- **THEN** the reconstructed prior-as-of top-N state MUST be passed through the shared canonical order-book row builder
- **AND** replaying the same dataset under the same adapter and canonicalization versions MUST reproduce snapshot IDs and normalized-row checksums

#### Scenario: OKX snapshot anchors a prefixed hourly object
- **WHEN** a proven OKX object contains update rows before a complete snapshot whose `prevSeqId` snapshot sentinel is `-1`
- **THEN** the adapter MUST ignore only the unanchored delta prefix and begin replay from that complete snapshot when it is at or before the earliest required clock
- **AND** every applied update after the anchor MUST link its `prevSeqId` to the current `seqId`, including a linked heartbeat or maintenance reset

#### Scenario: OKX sequence breaks and later re-anchors
- **WHEN** an OKX update does not link to current state and a later complete snapshot precedes the next required target
- **THEN** the adapter MUST record the discontinuity, remain unanchored until that snapshot, and sample the later target from the re-anchored state
- **AND** the discontinuity MUST remain forensic evidence even when it affects no required target

#### Scenario: OKX sequence break affects a required target
- **WHEN** one or more required targets occur after a discontinuity and before a valid later complete snapshot
- **THEN** the adapter MUST scan the full clock and then fail `vendor_fetch_failed/update_chain_gap`
- **AND** it MUST report all affected targets and complete sequence and clock summary diagnostics

#### Scenario: Sequence or clock semantics are ambiguous
- **WHEN** an update chain regresses, a snapshot group is ambiguous, a timestamp unit is unsupported, a future observation is used, a book is crossed or missing a side, or non-OKX continuity is unsupported
- **THEN** normalization MUST fail before archive submission
- **AND** the result MUST be `vendor_fetch_failed` with a stable validation subreason rather than a downgraded construction mode
