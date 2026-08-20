## ADDED Requirements

### Requirement: Qualification state and resolved selections are append-only evidence
The archive SHALL store append-only `qualified`, `quarantined`, and `revoked`
qualification events and enough canonical receipt and resolved-selection
content to return the original identities on idempotent reuse. Vendor-qualified
views SHALL require the latest state to be `qualified` and its referenced final
v1 receipt to have valid recomputed identities. Production rows SHALL retain
their existing checksum/provenance eligibility without vendor receipts.

#### Scenario: Receipt or selection content conflicts
- **WHEN** a stored identity resolves to different content or a recomputed digest mismatches
- **THEN** the reader MUST fail closed
- **AND** no vendor rows covered by that evidence may be selected

### Requirement: Archive identity is deployment-owned and checked before acquisition
The archive SHALL expose one deployment-owned
`market_data.cex_archive_cluster_identity` singleton containing environment and
cluster identity. The archive reader SHALL query it and archive-forwarder
health SHALL report the same stored identity. Preflight MUST require the reader,
forwarder, and request identities to match before capability, credentials, or
vendor acquisition.

#### Scenario: Reader and forwarder target different clusters
- **WHEN** either identity differs from the request environment or cluster
- **THEN** the outcome MUST be `archive_preflight_failed`
- **AND** no provider capability, credential, or network acquisition may occur

### Requirement: Production forwarder admission requires scoped authorization
Production forwarding SHALL validate a nonempty authorization ID, a
production-scoped credential, expiry, environment, and cluster before fetch or
submission. A missing authorization ID SHALL make the request invalid. An
invalid or expired authorization, wrong scope, or identity mismatch SHALL fail
archive preflight.

#### Scenario: Production authorization is absent or invalid
- **WHEN** a production request omits its authorization ID
- **THEN** the outcome MUST be `request_invalid`
- **WHEN** the referenced authorization is invalid, expired, not production-scoped, or bound to another environment or cluster
- **THEN** the outcome MUST be `archive_preflight_failed`
- **AND** no provider capability, credential, or network acquisition may occur

### Requirement: External capture qualification is an append-only commit boundary
The archive SHALL store passing external-backfill promotion records in
`market_data.cex_order_book_capture_promotions`. Each record MUST bind one
content-addressed capture bundle, request and receipt identities, provider and
adapter identities, exchange/pair/market/feed, bounded source window, depth,
construction mode, canonical schema/checksum versions, vendor/canonical semantic
digests, prefix/suffix digests, seam and coverage verdicts, and verification
time. The forwarder MUST validate this closed row contract and MUST reject
non-passing or mismatched promotion records.

#### Scenario: Passing receipt is inserted last
- **WHEN** candidate physical rows pass complete FIET-1017 verification
- **THEN** the worker MUST submit the promotion row only after all candidate
  level and summary chunks are queryable and verified
- **AND** retrying the same receipt identity and content MUST remain idempotent

#### Scenario: Producer tries to self-qualify malformed evidence
- **WHEN** a promotion row has an unsupported source, status, schema, empty
  identity, mismatched envelope source, or invalid semantic hash
- **THEN** the forwarder MUST reject the request before insertion

### Requirement: Replay-qualified views exclude failed external bundles
The archive SHALL expose
`market_data.cex_order_book_levels_replay_qualified` and
`market_data.cex_order_book_depth_summary_replay_qualified`. These views MUST
retain checksum-consistent broker-origin rows and MUST include
`external_backfill` rows only when an exact passing promotion record matches the
capture bundle, exchange, pair, source-time scope, depth, construction mode, and
schema identity. Physical and existing canonical views MUST remain available for
audit and promotion verification.

#### Scenario: Partial external insertion remains unqualified
- **WHEN** one or more external-backfill chunks land but no promotion record is
  committed
- **THEN** physical and unqualified canonical queries MAY expose those rows
- **AND** replay-qualified views, coverage preflight, and the retained exporter
  MUST exclude them

#### Scenario: Broker-origin behavior remains compatible
- **WHEN** an existing checksum-consistent `broker_read` or `broker_write`
  capture is queried
- **THEN** replay-qualified views MUST preserve its current canonical row
  eligibility without requiring a vendor promotion record

### Requirement: Historical external captures survive live source-time retention
The canonical order-book base tables SHALL preserve their existing source-time
retention for broker-origin live capture while preventing qualified or pending
`external_backfill` rows from being deleted solely because their historical
source timestamps predate the live retention horizon. Promotion rows MUST remain
available for at least as long as the external capture rows they qualify.

#### Scenario: Old historical data is inserted
- **WHEN** an external-backfill capture has source timestamps older than the
  broker live-capture TTL horizon
- **THEN** ClickHouse TTL processing MUST NOT immediately delete its physical
  level or summary rows
- **AND** a later passing promotion MUST remain able to qualify that evidence

#### Scenario: Existing live retention remains effective
- **WHEN** broker-origin live order-book rows exceed their configured
  source-time retention horizon
- **THEN** the existing live retention policy MUST continue to apply

### Requirement: Qualified export rejects unqualified bundle selection
Reusable archive-reader logic and the retained reference Parquet exporter SHALL
query replay-qualified views, preflight checksum conflicts and external
qualification, and preserve source/capture/promotion identities in returned
metadata. Supplying a physical external capture bundle ID MUST NOT bypass the
qualification requirement.

#### Scenario: Exporter receives an unqualified external bundle
- **WHEN** an export request names a physically present external-backfill bundle
  without a matching promotion record
- **THEN** the exporter MUST fail with a typed unqualified-capture error or
  return a typed coverage miss
- **AND** it MUST NOT write final Parquet files

#### Scenario: Qualified capture is exported
- **WHEN** a requested external bundle has a matching promotion record and
  conflict-free qualified rows for the complete requested scope
- **THEN** the exporter MUST preserve canonical capture-core fields and the
  promotion identity needed by the consumer manifest

### Requirement: Expanded timeline verification uses semantic identities
FIET-1017 verification SHALL compare canonical logical keys and normalized-row
semantic checksums rather than physical row order, compression bytes, or Parquet
encoding. It MUST prove unchanged pre-existing qualified prefix/suffix digests,
candidate capture equivalence, update/seam continuity, absence of conflicts and
future leakage, requested depth/construction fidelity, required-clock coverage,
and compatibility with the CEX canonical export contract.

#### Scenario: Storage encoding differs but semantics agree
- **WHEN** queried archive rows have a different physical order or storage
  encoding from the normalized in-memory projection
- **THEN** promotion MAY pass only if canonical keys, values, sequences, and
  semantic checksums agree exactly

#### Scenario: Existing qualified data changes unexpectedly
- **WHEN** a pre-promotion prefix or suffix semantic digest differs after
  candidate ingestion
- **THEN** promotion verification MUST fail and MUST NOT commit qualification
