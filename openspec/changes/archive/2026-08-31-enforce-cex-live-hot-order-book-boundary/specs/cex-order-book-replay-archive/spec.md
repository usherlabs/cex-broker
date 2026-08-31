## ADDED Requirements

### Requirement: Bounded order-book levels are diagnostic only

The archive SHALL persist no more than the configured top-N bid levels and top-N ask levels for a sampled live observation. Those rows MAY support hot analytics and diagnostics but SHALL NOT establish exactness, repair a missing or censored summary, infer venue exhaustion, or extend the summary-v2 claim boundary.

#### Scenario: Full upstream observation is sliced after summary calculation

- **WHEN** the validated upstream observation contains more than N levels on either side
- **THEN** summary v2 SHALL be calculated from the complete observed snapshot and its capture metadata
- **AND** no more than N rows per side SHALL be inserted into the level table

#### Scenario: Levels cannot upgrade censored evidence

- **WHEN** a summary band is `censored` and retained level rows appear to reach a downstream policy threshold
- **THEN** a supported reader SHALL retain the summary status
- **AND** it SHALL NOT upgrade the band to `exact` or reconstruct a replacement summary from those rows

### Requirement: Summary v2 is the sole supported depth-summary contract

The active summary writer, supported views, fixtures, diagnostics, and downstream query contract SHALL use only `schema_version = '2.0.0'`. No active v1 producer, reader, alias, compatibility view, fallback decoder, or version-laundering projection SHALL remain. The retained `legacy_migration_v1` path SHALL NOT emit either v1 or v2 summaries. Existing v1 physical rows MAY remain until TTL or an approved destructive migration removes them.

#### Scenario: Supported view excludes v1

- **WHEN** a table contains both v1 and v2 physical summary rows
- **THEN** the supported summary view SHALL return only valid v2 rows from `broker_read` or `broker_write`

#### Scenario: Missing v2 is unavailable

- **WHEN** a requested interval has only a v1 summary
- **THEN** the supported reader contract SHALL report no supported summary for that interval
- **AND** it SHALL NOT translate or alias the v1 row to v2

### Requirement: Summary v2 has a versioned conformance fixture

CEX SHALL publish a secret-free `cex-order-book-depth-summary-v2-conformance/v1` fixture containing normalized snapshots, capture metadata, expected writer rows, canonical typed supported-view projections, checksums, and expected rejection outcomes. It SHALL cover exact, censored, explicitly exhausted, asymmetric non-empty, truncated, duplicate, conflicting, incomplete-provenance, malformed, empty-bid, empty-ask, and both-empty inputs. Every case SHALL pin archive depth and measurement bands.

#### Scenario: CEX proves canonical material and typed query projection

- **WHEN** the CEX conformance suite runs
- **THEN** the canonical writer and checksum material SHALL match the fixture exactly
- **AND** insertion into real ClickHouse followed by the supported query SHALL match the fixture after `Decimal(38,18)` values are rendered as canonical decimal strings, arrays retain specified order, and rows use fixture ordering
- **AND** raw database-driver bytes SHALL NOT be treated as a contract

#### Scenario: Downstream parity has no runtime dependency

- **WHEN** a downstream repository tests its hot reader
- **THEN** it MAY pin or copy the fixture with its SHA-256 or run an optional SQL compatibility job
- **AND** production materialization SHALL NOT require a CEX checkout, package, executable, or sidecar

### Requirement: Historical archive schema retirement is terminal and operator controlled

Fresh-install DDL SHALL omit external-backfill evidence, promotion, qualification, archive-selection, cluster-identity objects, replay-qualified views, external source defaults, vendor-only columns, and historical TTL exceptions. Automatic startup SHALL NOT destructively mutate an existing deployment. A separately approved operator migration SHALL inventory and back up required evidence, verify writers are stopped and rejection is live, delete external rows and wait for mutations, apply an unconditional 90-day hot TTL, drop obsolete objects, and verify absence.

#### Scenario: Fresh database contains only the final hot schema

- **WHEN** the database is initialized from the final DDL
- **THEN** it SHALL contain the broker live/hot tables and supported v2 views
- **AND** it SHALL contain no vendor promotion, qualification, selection, cluster-identity, or replay-qualified object

#### Scenario: Startup does not destroy deployed evidence

- **WHEN** a broker starts against an existing database that still contains historical objects or rows
- **THEN** automatic schema initialization SHALL NOT issue destructive deletes, drops, or TTL mutations
- **AND** it SHALL report the need for the approved terminal migration

#### Scenario: Terminal migration has an absence gate

- **WHEN** the approved migration reports success
- **THEN** no `external_backfill` row, obsolete table, replay-qualified view, vendor-only `capture_origin` column, or conditional historical TTL SHALL remain
- **AND** ClickHouse mutations SHALL have completed before the absence gate passes

## MODIFIED Requirements

### Requirement: Canonical order-book levels use one row per level

The archive plane SHALL write no more than configured N bid rows and N ask rows per accepted live snapshot to `market_data.cex_order_book_levels` using one row per snapshot, side, and zero-based level index. Level rows SHALL retain capture schema `1.0.0`, remain append-only diagnostic evidence, and SHALL NOT have a Parquet-compatibility requirement or grant exact/censored summary claim rights.

The deployment configuration `CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT` SHALL default to `25` and accept only integer values in `1..500`. Invalid configuration SHALL prevent the writer from starting rather than silently clamp or substitute a value.

#### Scenario: Sampled snapshot is normalized and bounded

- **WHEN** a valid live snapshot containing non-empty bids and asks is accepted for archive
- **THEN** the system MUST emit one level row for every retained bid and ask up to configured N per side
- **AND** each row MUST include snapshot identity, side, zero-based level index, price, amount, mid-price, spread from mid, sequence when available, and common live capture provenance
- **AND** each row MUST use `schema_version = '1.0.0'`

#### Scenario: Level depth exceeds the configured limit

- **WHEN** a provider returns more levels than configured N on either side
- **THEN** normalization MUST retain no more than N levels on each side after the complete observation has been validated and summarized
- **AND** the depth limit and actual retained side counts MUST remain auditable

#### Scenario: Persisted levels are not a policy replay surface

- **WHEN** a downstream consumer needs a hot exact-or-censored depth verdict
- **THEN** it MUST use the supported summary-v2 projection
- **AND** no CEX-supported view, fixture, or compatibility alias SHALL reconstruct that verdict from level rows

### Requirement: Canonical depth summaries are deterministic

For every accepted sampled live observation, the writer SHALL validate the complete normalized snapshot and closed capture metadata, calculate midpoint-relative depth bands before slicing retained levels, and emit one summary row with `schema_version = '2.0.0'`. The writer SHALL reject an empty bid side, empty ask side, crossed or locked book, missing or inconsistent required field, invalid enum, invalid decimal, misaligned array, or best-side-relative calculation before durable insertion. An unavailable interval SHALL be represented by absence from the supported v2 view, not by an `unknown` status.

Each per-side band status SHALL be one of:

- `exact` when the observed boundary reaches the band or explicit venue evidence proves that side exhausted before the boundary;
- `censored` when observation ends inside the band without proven exhaustion, making the numeric depth a lower bound.

For each band `b`, the midpoint SHALL be `(best_bid + best_ask) / 2`, the bid boundary SHALL be `midpoint * (1 - b / 10000)`, and the ask boundary SHALL be `midpoint * (1 + b / 10000)`. Bid depth SHALL be the sum of complete-observation base amounts at prices greater than or equal to the bid boundary; ask depth SHALL be the sum at prices less than or equal to the ask boundary. The fixture SHALL fix the canonical `Decimal(38,18)` rounding and serialization of these values.

An observed count below a requested limit SHALL NOT by itself prove exhaustion. `measurement_bands_bps` SHALL be normalized into deterministic ascending unique order, default to `[10,25,50,100]`, and contain positive `UInt32` basis-point values. Every fixture case SHALL provide it explicitly. The shared bands array, both boundary-price arrays, both depth arrays, and both status arrays SHALL have equal lengths.

The normative v2 supported projection SHALL contain exactly the following non-null columns unless marked nullable:

- live capture provenance: `source String`, `deployment_id String`, `capture_bundle_id String`, `exchange String`, `symbol String`, `trading_pair String`, `source_symbol String`, `asset_type String`, `feed String`, `provider String`, `source_mode String`, `source_time_ms UInt64`, `received_time_ms UInt64`, `raw_capture_id String`, `raw_capture_scope String`, `schema_version String`, `checksum_algorithm String`, `raw_checksum String`, and `provenance_complete UInt8`;
- snapshot identity: `snapshot_id String`, `construction_mode String`, `gap_policy String`, `depth_limit UInt16`, `sequence Nullable(UInt64)`, and `exact_l2_reconstruction_complete UInt8`;
- acquisition evidence: `capture_profile_id String`, `effective_cadence_ms UInt32`, `requested_upstream_depth Nullable(UInt16)`, `observed_bid_count UInt32`, `observed_ask_count UInt32`, `observed_farthest_bid Decimal(38,18)`, `observed_farthest_ask Decimal(38,18)`, `retained_farthest_bid Decimal(38,18)`, `retained_farthest_ask Decimal(38,18)`, `bid_exhausted UInt8`, and `ask_exhausted UInt8`;
- top-of-book and retention evidence: `best_bid Decimal(38,18)`, `best_ask Decimal(38,18)`, `best_bid_amount Decimal(38,18)`, `best_ask_amount Decimal(38,18)`, `mid_price Decimal(38,18)`, `spread Decimal(38,18)`, `spread_bps Float64`, `staleness_ms UInt64`, `bid_level_count UInt16`, and `ask_level_count UInt16`, where the level counts are the retained per-side counts;
- band evidence: `measurement_bands_bps Array(UInt32)`, `bid_boundary_price_by_band Array(Decimal(38,18))`, `ask_boundary_price_by_band Array(Decimal(38,18))`, `bid_depth_by_band Array(Decimal(38,18))`, `ask_depth_by_band Array(Decimal(38,18))`, `bid_status_by_band Array(Enum8('exact'=1,'censored'=2))`, and `ask_status_by_band Array(Enum8('exact'=1,'censored'=2))`; and
- row integrity: `normalized_row_checksum String`.

For v2 admission, every String above SHALL be non-empty, `source` SHALL be `broker_read` or `broker_write`, `feed` SHALL be `ORDERBOOK`, `schema_version` SHALL be `2.0.0`, and `provenance_complete` SHALL equal `1`. `effective_cadence_ms`, observed counts, and retained counts SHALL be positive; `depth_limit` and every non-null `requested_upstream_depth` SHALL be in `1..500`; retained counts SHALL not exceed the corresponding observed count or `depth_limit`. Booleans encoded as `UInt8` SHALL be `0` or `1`, and an exhaustion value of `1` SHALL require validated venue evidence. The fixture's field list, order, ClickHouse types, nullability, canonical decimal rendering, and checksum inputs SHALL be normative.

#### Scenario: Complete observation reaches a band

- **WHEN** the observed bid and ask boundaries each reach a configured midpoint-relative band
- **THEN** the corresponding statuses SHALL be `exact`
- **AND** the values SHALL be deterministically computed from the complete normalized snapshot

#### Scenario: Truncated observation is censored

- **WHEN** an observed side ends inside a configured band without explicit venue exhaustion evidence
- **THEN** the side's band status SHALL be `censored`
- **AND** its numeric value SHALL be interpreted only as a lower bound

#### Scenario: Explicit venue exhaustion is exact

- **WHEN** an adapter supplies validated evidence that a side is exhausted before a configured band boundary
- **THEN** the corresponding status SHALL be `exact`
- **AND** a short observed count alone SHALL NOT substitute for that evidence

#### Scenario: Missing boundary data is rejected

- **WHEN** a candidate lacks an observed edge, side count, exhaustion boolean, profile identity, cadence, band array, or other required v2 admission field
- **THEN** the writer or forwarder SHALL reject it before durable insertion
- **AND** the supported view SHALL represent that interval as unavailable

#### Scenario: Empty or one-sided book is rejected

- **WHEN** an observation has an empty bid side, empty ask side, or both sides empty
- **THEN** no raw, level, or summary row from that observation SHALL be admitted as a valid ORDERBOOK capture
- **AND** an asymmetric fixture case SHALL still contain at least one valid level on each side

#### Scenario: Malformed v2 row fails closed

- **WHEN** a candidate row has missing required fields, invalid statuses, misaligned arrays, or best-side-relative band calculations
- **THEN** the writer or forwarder SHALL reject it before durable insertion

### Requirement: Order-book rows link to raw captures and bundles

The linked raw, retained-level, and summary rows SHALL carry the same `source`, `deployment_id`, `capture_bundle_id`, `provider`, `raw_capture_id`, and `raw_checksum`. Every retained level and its summary SHALL additionally carry the same `snapshot_id`. The ORDERBOOK raw row SHALL use metadata-only encoding and is not required to duplicate `snapshot_id`; linkage SHALL NOT require storage of the full provider body.

The complete normalized observation SHALL determine `raw_checksum` and `raw_capture_id` under capture schema `1.0.0`. The retained-N bids and asks SHALL determine `snapshot_id` under capture schema `1.0.0`. Raw and level rows SHALL use `schema_version = '1.0.0'`; the linked summary alone SHALL use `schema_version = '2.0.0'`. Summary schema version SHALL NOT enter either identity. Each row type SHALL retain its own `normalized_row_checksum`; those row checksums are not shared linkage. `producer_id` and `producer_run_id` SHALL remain strategy-row fields and SHALL NOT be required or introduced on market rows.

#### Scenario: One observation has consistent linkage

- **WHEN** a live observation produces a raw row, bounded level rows, and a summary-v2 row
- **THEN** all rows SHALL agree on the specified raw identity, full-observation checksum, source, deployment, bundle, and provider
- **AND** the levels and summary SHALL agree on retained-N snapshot identity
- **AND** the summary's `2.0.0` schema and normalized row checksum SHALL differ independently from raw/level schema and row checksums

#### Scenario: Incomplete provenance is excluded

- **WHEN** a candidate summary lacks a non-empty capture bundle, raw capture, snapshot, raw checksum, broker-owned source, deployment, provider, or complete-provenance marker
- **THEN** it SHALL be rejected or excluded from the supported view

### Requirement: Canonical order-book insertion is idempotent

Canonical order-book storage SHALL retain every physical delivery in append-only `MergeTree` base tables. The level logical key SHALL be `(capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id, schema_version, side, level_index)`. The summary logical key SHALL be `(capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id, schema_version)`.

`market_data.cex_order_book_levels_canonical` SHALL collapse identical diagnostic-level retries only for `source IN ('broker_read','broker_write')` and `schema_version = '1.0.0'`, while `market_data.cex_order_book_levels_conflicts` SHALL apply the same filter and expose a level logical key with more than one normalized-row checksum. `market_data.cex_order_book_depth_summary_canonical` SHALL be the supported summary view and SHALL collapse identical retries only for `source IN ('broker_read','broker_write')`, `schema_version = '2.0.0'`, and complete provenance. `market_data.cex_order_book_depth_summary_conflicts` SHALL apply the same source, version, and provenance filter and expose a summary logical key with more than one normalized-row checksum. Each canonical view SHALL exclude every key in its corresponding conflict view. No active canonical/conflict view SHALL select summary v1. No operation SHALL delete or overwrite a disagreeing physical row as part of retry convergence.

#### Scenario: Identical retry converges

- **WHEN** the same metadata-only raw row, bounded levels, and summary-v2 row are retried with identical identities and checksums
- **THEN** the supported query result SHALL contain one canonical observation
- **AND** the base tables SHALL retain both physical deliveries

#### Scenario: Conflicting retry is visible

- **WHEN** a retry reuses an identity with different normalized content, checksum, or summary semantics
- **THEN** a same-batch conflict SHALL be rejected before insertion or a cross-batch conflict SHALL appear in the applicable named conflict view
- **AND** the supported view SHALL NOT select the conflicting row

### Requirement: Legacy order-book storage requires table migration before upgrade

The retained bounded `legacy_migration_v1` tool MAY migrate historical rows from `market_data.orderbook_snapshots` into capture-schema-v1 level rows with honest incomplete provenance before a canonical-only upgrade. It SHALL NOT emit a depth-summary row of any version, fabricate complete raw identity or v2 boundary metadata, or make a migrated interval visible through the supported summary-v2 view. The upgraded broker SHALL NOT expose a runtime legacy/dual/canonical write mode.

#### Scenario: Existing deployment is prepared for upgrade

- **WHEN** operators retain legacy order-book snapshots during upgrade
- **THEN** they MAY quiesce legacy writers and migrate bounded partitions into diagnostic level rows
- **AND** any incomplete raw identity SHALL remain null and `provenance_complete` SHALL equal `0`

#### Scenario: Legacy migration cannot emit summaries

- **WHEN** `legacy_migration_v1` converts a retained legacy snapshot
- **THEN** it MUST NOT call the active summary writer or write either summary v1 or summary v2
- **AND** no compatibility view SHALL synthesize a summary from its levels

#### Scenario: Canonical-only broker is deployed

- **WHEN** the upgraded broker begins live archive writes
- **THEN** new ORDERBOOK captures MUST use metadata-only raw rows, bounded schema-v1 levels, and schema-v2 summaries only
- **AND** legacy diagnostic rows MUST remain excluded from supported v2 output

#### Scenario: Canonical cutover is rolled back

- **WHEN** a blocking integrity defect is found after canonical deployment
- **THEN** operators MUST stop ORDERBOOK archival and apply a forward fix or roll back the application without reactivating any summary-v1 writer
- **AND** retained physical evidence and conflict diagnostics MUST remain auditable

## REMOVED Requirements

### Requirement: ClickHouse and parquet share a capture-core contract

**Reason**: Canonical Parquet export is no longer a CEX product or shared CEX-to-Maker wire.

**Migration**: Read CEX hot evidence directly from ClickHouse and let Maker own vendor-object cold formats and reconstruction.

### Requirement: Qualification state and resolved selections are append-only evidence

**Reason**: Qualification and archive selection model the removed external historical admission boundary.

**Migration**: Export any required audit evidence, then drop the tables in the approved terminal migration.

### Requirement: Archive identity is deployment-owned and checked before acquisition

**Reason**: The archive-cluster identity is required only for CEX-owned vendor acquisition and promotion, both of which are removed.

**Migration**: Stop vendor acquisition, preserve ordinary live deployment provenance, and drop the cluster-identity object terminally.

### Requirement: Production forwarder admission requires scoped authorization

**Reason**: This authorization model grants the removed external producer permission to write historical market data.

**Migration**: Replace it with a closed source validator accepting only deployment-derived `broker_read` and `broker_write` market rows.

### Requirement: External capture qualification is an append-only commit boundary

**Reason**: CEX no longer qualifies or promotes external captures.

**Migration**: Maker owns any cold-source validation; CEX rejects external historical writes.

### Requirement: Replay-qualified views exclude failed external bundles

**Reason**: Replay-qualified views expose the removed qualification product and must not remain as compatibility aliases.

**Migration**: Consumers move to the v2 broker hot view or Maker-owned cold selection; drop both views terminally.

### Requirement: Historical external captures survive live source-time retention

**Reason**: The CEX hot archive no longer retains external historical captures or grants them a TTL exception.

**Migration**: Export required audit rows, delete external rows, and apply the unconditional 90-day hot TTL through the approved migration.

### Requirement: Qualified export rejects unqualified bundle selection

**Reason**: Qualified canonical export is deleted with the preparation product.

**Migration**: Remove all exporter callers and use direct source-owned readers.

### Requirement: Expanded timeline verification uses semantic identities

**Reason**: This verification belongs to the removed CEX vendor reconstruction and preparation flow.

**Migration**: Port any independently required cold reconstruction validation into Maker without a CEX runtime dependency.
