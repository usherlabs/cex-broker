## ADDED Requirements

### Requirement: Canonical order-book levels use one row per level
The archive plane SHALL write sampled or reconstructed order-book depth to `market_data.cex_order_book_levels` using one row per snapshot, side, and level index with a parquet-compatible capture-core schema.

#### Scenario: Sampled snapshot is normalized
- **WHEN** a valid top-N snapshot containing bids and asks is accepted for archive
- **THEN** the system MUST emit one level row for every retained bid and ask
- **AND** each row MUST include snapshot identity, side, zero-based level index, price, amount, mid-price, spread from mid, sequence when available, and common capture provenance

#### Scenario: Level depth exceeds the configured limit
- **WHEN** a provider returns more levels than the configured archive depth limit
- **THEN** normalization MUST retain no more than that limit on each side
- **AND** the retained depth limit and actual side counts MUST remain auditable

### Requirement: Canonical depth summaries are deterministic
The archive plane SHALL write one `market_data.cex_order_book_depth_summary` row per retained snapshot containing top-of-book, spread, staleness, level counts, configured measurement bands, and depth by band.

#### Scenario: Summary is derived from canonical levels
- **WHEN** canonical levels are produced for a snapshot
- **THEN** the summary best bid, best ask, mid-price, spread, counts, and band depths MUST be computed from those retained levels
- **AND** repeated normalization of the same capture and contract version MUST produce the same summary values and checksum

#### Scenario: Measurement bands are configured
- **WHEN** bid or ask measurement bands are configured
- **THEN** bands MUST be normalized into a deterministic ascending unique order
- **AND** depth for each band MUST be calculated using the documented base-amount convention

### Requirement: Order-book normalization rejects invalid evidence
Order-book normalization SHALL reject missing sides, non-finite or non-positive values, non-monotonic levels, crossed or locked books, invalid timestamps, and invalid depth configuration before canonical rows are archived.

#### Scenario: Book is crossed or locked
- **WHEN** the normalized best bid is greater than or equal to the normalized best ask
- **THEN** canonical order-book rows MUST NOT be emitted
- **AND** an invalid-row diagnostic MUST identify the reason without leaking provider secrets

#### Scenario: Side ordering is invalid
- **WHEN** bids are not strictly descending or asks are not strictly ascending after provider normalization
- **THEN** the entire snapshot MUST be rejected before canonical rows are emitted
- **AND** the broker MUST NOT silently reorder the captured levels

#### Scenario: Price or amount is invalid
- **WHEN** a retained level has a non-finite, zero, or negative price or amount
- **THEN** the snapshot MUST fail canonical validation
- **AND** partial valid levels MUST NOT be presented as a complete snapshot without an explicit invalid-evidence classification

### Requirement: Order-book construction modes are evidence honest
The system SHALL classify order-book rows with versioned construction mode, source mode, and gap policy values and SHALL treat sampled top-N snapshots separately from exact L2 reconstruction.

#### Scenario: Live broker snapshot is captured
- **WHEN** the broker archives `Subscribe(ORDERBOOK)` output without complete snapshot-plus-delta continuity evidence
- **THEN** it MUST record `construction_mode = "sampled_top_n_snapshot"`
- **AND** it MUST use the broker live-sampling source mode rather than claim exact L2 reconstruction

#### Scenario: Exact L2 capability is unavailable
- **WHEN** the broker cannot prove initial snapshot identity, complete ordered sequence ranges, clean continuity, and valid reconstruction
- **THEN** it MUST advertise exact L2 support as false
- **AND** exact-L2 rows MUST NOT be written

#### Scenario: Exact L2 is explicitly requested but unsupported
- **WHEN** a caller explicitly requests exact L2 reconstruction and the capability is unavailable
- **THEN** the request MUST return the typed unsupported result
- **AND** it MUST NOT silently downgrade that request to sampled evidence

#### Scenario: Historical snapshots are unsupported
- **WHEN** broker historical order-book capability is unavailable
- **THEN** the existing typed historical unsupported result MUST remain truthful
- **AND** current or live snapshots MUST NOT be relabeled as historical evidence

### Requirement: Exact L2 evidence carries continuity proof
If exact L2 support is implemented in the future, every exact reconstruction SHALL carry an initial snapshot identity, sequence start and end, continuity status, exact-completion flag, and fail-fast gap policy sufficient to audit the claim.

#### Scenario: Exact reconstruction completes cleanly
- **WHEN** an initial snapshot and all ordered deltas reconstruct a valid book with no gaps
- **THEN** `exact_l2_reconstruction_complete` MAY be true only with the complete continuity metadata
- **AND** canonical levels and summary MUST reference the proven reconstruction identity

#### Scenario: Sequence continuity breaks
- **WHEN** an expected delta, update identifier, or ordering marker is missing
- **THEN** exact reconstruction MUST fail under `gap_policy = "fail_fast"`
- **AND** no exact-L2 canonical rows may be emitted for the affected reconstruction

### Requirement: Order-book rows link to raw captures and bundles
Every new canonical order-book level and summary row SHALL link to its capture bundle, raw capture, snapshot identity, provider, exchange, pair, replay-capture schema version, and integrity fields.

#### Scenario: One captured snapshot produces canonical rows
- **WHEN** one broker-visible snapshot is normalized
- **THEN** its raw event, all level rows, and its summary row MUST share the same `capture_bundle_id` and `raw_capture_id`
- **AND** level and summary rows MUST carry individually reproducible normalized-row checksums

#### Scenario: Snapshot identity is recomputed
- **WHEN** the same exchange, pair, source timestamp, sequence, retained levels, and normalization version are supplied again
- **THEN** the deterministic snapshot identity MUST be reproduced
- **AND** unrelated deployment ingestion timestamps MUST NOT change that identity

### Requirement: ClickHouse and parquet share a capture-core contract
The canonical ClickHouse order-book tables and Maker parquet outputs SHALL share names and semantics for capture-core fields while allowing Maker materialization to add run-scoped coverage and assumption fields separately.

#### Scenario: Broker rows are exported for Maker
- **WHEN** canonical ClickHouse rows are converted into `order_book_levels.parquet` and `order_book_depth_summary.parquet`
- **THEN** capture-core fields MUST map without semantic reinterpretation
- **AND** exchange, pair, provider, timestamps, construction mode, source mode, gap policy, depth, identities, and checksums MUST be preserved

#### Scenario: Maker adds replay-run metadata
- **WHEN** Maker coverage planning adds run id, coverage report, as-of lag, future-leakage, or assumption fields
- **THEN** those fields MUST be treated as a materialized extension of the immutable broker capture
- **AND** they MUST NOT alter the original capture checksum or provenance

### Requirement: Canonical order-book insertion is idempotent
Canonical order-book storage SHALL retain physical deliveries in append-only `MergeTree` base tables and SHALL expose deterministic canonical and conflict views over explicit logical keys so retries remain auditable without producing ambiguous replay rows.

The level logical key SHALL consist of capture bundle, exchange, trading pair, raw capture, snapshot, schema version, side, and level index. The summary logical key SHALL use the same fields except side and level index.

#### Scenario: Same level row is delivered twice
- **WHEN** the archive forwarder retries a level row with the same capture, snapshot, side, level index, schema version, and checksum
- **THEN** `market_data.cex_order_book_levels_canonical` MUST resolve it as one logical level
- **AND** both physical deliveries MUST remain available in the base evidence table

#### Scenario: Same summary row is delivered twice
- **WHEN** a summary row is retried with the same capture and snapshot identity
- **THEN** `market_data.cex_order_book_depth_summary_canonical` MUST resolve it as one logical summary
- **AND** both physical deliveries MUST remain available in the base evidence table

#### Scenario: Logical key has conflicting checksums in one batch
- **WHEN** one archive batch contains the same level or summary logical key with more than one normalized-row checksum
- **THEN** the forwarder MUST reject the conflicting table batch before insertion
- **AND** the producer retry and loss-journal policy MUST account for the rejected rows

#### Scenario: Logical key has conflicting checksums across batches
- **WHEN** physical deliveries from different archive batches reuse one logical key with different normalized-row checksums
- **THEN** the corresponding ClickHouse conflict view MUST expose the key and distinct checksums
- **AND** canonical views MUST exclude the conflicted key
- **AND** replay validation MUST fail the affected capture bundle

### Requirement: Legacy order-book storage requires table migration before upgrade
The system SHALL migrate retained rows from `market_data.orderbook_snapshots` to the canonical level and summary tables through a bounded ClickHouse table-to-table migration before deploying the upgraded canonical-only broker. The upgraded broker SHALL always write the latest canonical schema and SHALL NOT expose a runtime legacy/dual/canonical write mode.

#### Scenario: Existing deployment is prepared for upgrade
- **WHEN** an existing broker writes `market_data.orderbook_snapshots` and the canonical-only version is scheduled for deployment
- **THEN** operators MUST apply canonical DDL, quiesce legacy writers, migrate every retained bounded partition, and validate parity before deploying the upgraded broker
- **AND** any missing row or value mismatch MUST block the upgrade

#### Scenario: Legacy snapshot lacks raw capture identity
- **WHEN** a legacy row is migrated and its original raw capture or checksum is unavailable
- **THEN** the canonical row MUST record legacy source mode and incomplete provenance
- **AND** it MUST leave unavailable raw integrity fields null rather than invent them

#### Scenario: Canonical-only broker is deployed
- **WHEN** canonical-table migration and replay validation pass for every retained migration window
- **THEN** the upgraded broker MUST write new order-book captures only to the canonical raw, level, and summary tables
- **AND** legacy query names MUST remain available through documented compatibility views for the migration retention period

#### Scenario: Canonical cutover is rolled back
- **WHEN** a blocking integrity or replay defect is found after canonical deployment
- **THEN** operators MUST stop the upgraded broker and MAY restore the retained legacy names before rolling back to the previous legacy-writing application version
- **AND** the defect and affected capture bundles MUST remain diagnosable
