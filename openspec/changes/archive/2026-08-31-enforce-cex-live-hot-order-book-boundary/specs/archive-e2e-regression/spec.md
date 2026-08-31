## ADDED Requirements

### Requirement: Archive E2E rejects historical producer admission

The integrated archive suite SHALL exercise both the named legacy source and an arbitrary unknown source through the public admission boundary and SHALL prove that neither can reach routing, spool success, or ClickHouse insertion.

#### Scenario: External backfill is rejected end to end

- **WHEN** an otherwise valid market batch uses `source = 'external_backfill'`
- **THEN** the forwarder SHALL reject it before table routing
- **AND** all archive, evidence, and success-count queries SHALL remain unchanged

#### Scenario: Unknown source is rejected end to end

- **WHEN** an otherwise valid market batch uses an unrecognized source string
- **THEN** the same fail-closed assertions SHALL hold

### Requirement: Archive E2E proves summary-v2 and bounded-raw parity

The integrated suite SHALL run the shared summary-v2 fixture through the production writer and real ClickHouse. It SHALL prove metadata-only ORDERBOOK raw bodies, bounded per-side level counts, deterministic v2 rows, v2-only supported query projections, idempotent duplicates, and auditable conflicts.

#### Scenario: Large observation remains bounded

- **WHEN** a fixture contains more levels than the configured archive depth
- **THEN** ClickHouse SHALL contain no more than the configured level count per side
- **AND** the raw payload SHALL contain no level arrays or provider body
- **AND** the summary-v2 result SHALL still reflect the complete observed boundary metadata

#### Scenario: Fixture typed projection matches real ClickHouse

- **WHEN** exact, censored, exhausted, asymmetric non-empty, truncated, and duplicate fixture cases are inserted with explicitly pinned archive depth and measurement bands
- **THEN** the supported query SHALL match the fixture's canonical typed projection
- **AND** `Decimal(38,18)` values SHALL compare as canonical decimal strings, arrays SHALL retain specified order, integer and enum values SHALL compare exactly, and raw driver bytes SHALL be ignored

#### Scenario: Empty and one-sided books fail closed

- **WHEN** the fixture presents an empty bid side, empty ask side, or both sides empty
- **THEN** the writer SHALL reject the complete observation before raw, level, or summary insertion
- **AND** the E2E suite SHALL prove that none of those identities appears in ClickHouse

#### Scenario: Malformed and conflicting v2 input fails closed

- **WHEN** the fixture presents malformed arrays, invalid status, incomplete provenance, or conflicting identity content
- **THEN** no row from that input SHALL become visible through the supported summary view
- **AND** the failure SHALL remain auditable

### Requirement: Final-schema regression asserts removed objects are absent

The fresh-database E2E suite SHALL assert that the final DDL creates no vendor evidence, promotion, qualification, archive-selection, cluster-identity, replay-qualified view, external source default, vendor-only column, or historical TTL exception.

#### Scenario: Fresh schema matches the live hot inventory

- **WHEN** E2E initializes an empty ClickHouse database from production DDL
- **THEN** every expected live/hot object SHALL exist
- **AND** every removed historical object and compatibility view SHALL be absent
- **AND** both hot order-book tables SHALL have the unconditional 90-day TTL contract

## MODIFIED Requirements

### Requirement: Canonical lifecycle output is restricted to the closed inventory

The archive lifecycle SHALL derive accepted live tables, validators, writers, and verification queries from the final closed live/hot inventory. For ORDERBOOK that inventory SHALL include metadata-only raw events, bounded level rows, and summary-v2 rows and SHALL exclude vendor qualification, promotion, selection, replay-qualified, and Parquet output.

#### Scenario: One inventory governs the live lifecycle

- **WHEN** a supported public feed passes through collection, forwarder admission, ClickHouse insertion, and verification
- **THEN** each stage SHALL accept only objects in the same closed live/hot inventory

#### Scenario: Removed product cannot re-enter through a stale list

- **WHEN** a test scans schemas, route registries, fixtures, exports, bins, and E2E expectations
- **THEN** no vendor, promotion, selection, replay-qualified, or canonical-Parquet item SHALL appear in an active inventory

### Requirement: Canonical-only capture proves stored linkage, provenance, and checksums

Canonical capture E2E SHALL prove that raw, bounded level, and summary-v2 rows agree on broker-owned source, deployment id, capture bundle, provider, raw-capture identity, and full normalized observation checksum; retained levels and summary SHALL additionally agree on retained-N snapshot identity. It SHALL also prove that raw and level rows use capture schema `1.0.0`, the summary alone uses schema `2.0.0`, and each row type has its own normalized-row checksum. ORDERBOOK raw rows SHALL prove the exact closed metadata-only key set while non-order-book feeds retain their established raw contract. Market rows SHALL NOT require or introduce strategy `producer_id` or `producer_run_id` fields.

#### Scenario: ORDERBOOK linkage survives raw-body removal

- **WHEN** the collector archives a live ORDERBOOK observation
- **THEN** raw metadata, retained levels, and summary v2 SHALL share the required live provenance, raw identity, and raw checksum
- **AND** retained levels and summary v2 SHALL share retained-N snapshot identity
- **AND** the full normalized observation SHALL be integrity-checkable without being stored in raw JSON
- **AND** summary `2.0.0` SHALL not alter the schema-`1.0.0` raw-capture or snapshot identity

#### Scenario: Incomplete provenance is not supported output

- **WHEN** a row omits required capture, checksum, broker-owned source, deployment, bundle, provider, or live provenance
- **THEN** validation SHALL reject it or the supported view SHALL exclude it

## REMOVED Requirements

### Requirement: Final-v1 archive conformance covers identity and authority transitions

**Reason**: The final-v1 authority transition belongs to the retired external historical product and conflicts with the v2-only live/hot boundary.

**Migration**: Replace this coverage with broker-source rejection, summary-v2 fixture parity, and final-schema absence gates.

### Requirement: Real ClickHouse proves the promotion commit boundary

**Reason**: CEX no longer promotes external captures.

**Migration**: Retain real-ClickHouse coverage for the live writer, supported v2 view, duplicates, conflicts, and terminal migration verification.

### Requirement: Worker conformance covers the closed state machine

**Reason**: This worker is the removed vendor backfill/preparation worker, not the live public-feed collector.

**Migration**: Delete its E2E state-machine suite; keep live collector supervision and archive delivery regression coverage.

### Requirement: Live provider promotion is verified against isolated ClickHouse

**Reason**: Live provider promotion is part of the removed external acquisition and qualification path.

**Migration**: Verify bounded live provider capture directly against the final hot tables with no promotion step.
