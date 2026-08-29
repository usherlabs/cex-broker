## ADDED Requirements

### Requirement: ORDERBOOK raw payloads are structurally bounded

Every archived ORDERBOOK raw event SHALL use capture schema `1.0.0` and `payload_encoding = 'orderbook_metadata_only_v1'`. Its canonical `payload_json` object SHALL contain exactly these keys and no others:

- `capture_profile_id`: non-empty JSON string;
- `effective_cadence_ms`: non-negative JSON integer;
- `requested_upstream_depth`: JSON integer in `1..500`, or JSON `null` only when the acquisition profile has no explicit upstream limit;
- `archive_depth_limit`: JSON integer in `1..500`;
- `observed_bid_count` and `observed_ask_count`: positive JSON integers;
- `observed_farthest_bid` and `observed_farthest_ask`: positive canonical decimal strings;
- `bid_exhausted` and `ask_exhausted`: JSON booleans that may be true only when backed by validated provider evidence;
- `retained_bid_count` and `retained_ask_count`: positive JSON integers no greater than `archive_depth_limit` or the corresponding observed count; and
- `measurement_bands_bps`: a non-empty, ascending, unique JSON array of positive integers, defaulting by deployment configuration to `[10,25,50,100]` and pinned explicitly in fixtures.

The object SHALL contain no bids, asks, nested level arrays, provider response body, optional full-body diagnostic representation, null beyond the one allowed field, or unrecognized key. Missing sides or required boundary metadata SHALL reject the entire ORDERBOOK capture instead of producing a partial raw row.

#### Scenario: Complete upstream book does not escape through raw storage

- **WHEN** the exchange returns more levels than the configured archive depth
- **THEN** the raw event body SHALL remain fixed-shape metadata
- **AND** neither the retained raw event nor an alternate diagnostic column SHALL contain the discarded levels

#### Scenario: Full-observation integrity remains auditable

- **WHEN** the writer emits a metadata-only ORDERBOOK raw event
- **THEN** it SHALL retain `raw_checksum` and `raw_capture_id` computed from the complete normalized upstream observation under capture schema `1.0.0`
- **AND** changing any normalized upstream level SHALL change that checksum even though the levels are absent from `payload_json`

#### Scenario: Metadata-only shape fails closed

- **WHEN** an ORDERBOOK metadata object has an extra key, missing key, invalid type, invalid null, empty side, inconsistent count, or invalid band configuration
- **THEN** the writer or forwarder SHALL reject the complete capture before durable insertion
- **AND** it SHALL NOT preserve a generic JSON fallback body

## MODIFIED Requirements

### Requirement: Archive source identity is deployment controlled

The market-data archive source SHALL be derived from the deployed broker role and SHALL be limited to `broker_read` or `broker_write`. Caller-supplied row data SHALL NOT override the source. The public forwarder SHALL reject `external_backfill` and every unknown source before generic table routing or insertion.

#### Scenario: Read and write broker deployments use closed sources

- **WHEN** a live collector archives a row from a configured read or write deployment
- **THEN** the source SHALL be assigned as `broker_read` or `broker_write` respectively

#### Scenario: External historical source is explicitly rejected

- **WHEN** a batch, route, legacy worker, or crafted request presents `source = 'external_backfill'`
- **THEN** admission SHALL fail before table dispatch
- **AND** no raw, normalized, level, summary, evidence, or spool-success row SHALL be written for that item

#### Scenario: Arbitrary source strings fail closed

- **WHEN** a market row presents a source other than `broker_read` or `broker_write`
- **THEN** validation SHALL reject it even if all remaining row fields are structurally valid

### Requirement: Raw captures and normalized rows have reproducible integrity

The archive SHALL compute stable identities and checksums from canonical normalized observations before persistence. For ORDERBOOK, the complete normalized observation SHALL produce `raw_checksum` and `raw_capture_id` under capture schema `1.0.0`; the retained-N bid/ask slice SHALL produce `snapshot_id` under capture schema `1.0.0`. Summary schema `2.0.0` SHALL NOT enter either identity. Raw and level rows SHALL use `schema_version = '1.0.0'`, while the linked summary alone SHALL use `schema_version = '2.0.0'`. Each row's `normalized_row_checksum` SHALL describe that row's own stored projection and SHALL NOT be treated as a shared checksum.

ORDERBOOK raw storage SHALL retain metadata-only payloads linked to the full normalized observation checksum; TICKER, TRADES, and OHLCV SHALL retain their existing canonical raw behavior. Repeated logical identity with identical row content SHALL be idempotent in canonical views while every physical delivery remains append-only; repeated identity with conflicting content SHALL remain visible through conflict evidence and excluded from supported output.

#### Scenario: ORDERBOOK metadata links to normalized output

- **WHEN** one ORDERBOOK observation produces a raw row, retained level rows, and a depth summary
- **THEN** every row SHALL carry the same source, deployment, capture bundle, provider, raw-capture identity, and full-observation checksum
- **AND** retained levels and the summary SHALL carry the same retained-N snapshot identity while the raw row need not duplicate it
- **AND** the raw payload SHALL satisfy `orderbook_metadata_only_v1`
- **AND** raw/level schema version and per-row checksums SHALL remain distinct from summary schema version and summary row checksum

#### Scenario: Non-order-book feeds are unchanged

- **WHEN** TICKER, TRADES, or OHLCV is archived
- **THEN** its established raw and normalized checksum contract SHALL remain unchanged by the ORDERBOOK bounding change

#### Scenario: Conflicting replay is rejected

- **WHEN** an existing capture identity is presented with different canonical content
- **THEN** the archive SHALL reject a same-batch conflict or expose a cross-batch conflict through the named conflict view
- **AND** it SHALL never overwrite the stored physical observation or select the conflicted key as supported output

### Requirement: Capture output is replay-consumable

Supported CEX capture output SHALL be consumable directly from the live/hot ClickHouse contract: metadata-only raw events, bounded diagnostic order-book levels, summary-v2 rows, and the unchanged normalized non-order-book tables. CEX SHALL NOT define a canonical Parquet export, qualified historical selection, or preparation-package handoff as part of replay consumption.

#### Scenario: Hot order-book reader uses supported tables

- **WHEN** a consumer reads a supported live ORDERBOOK interval
- **THEN** it SHALL read summary `2.0.0` through the supported view and MAY read bounded level rows for diagnostics
- **AND** it SHALL NOT require raw full-book JSON or a CEX-generated Parquet artifact

#### Scenario: Unsupported interval is not synthesized

- **WHEN** an interval contains only summary-v1 physical rows or lacks valid summary-v2 evidence
- **THEN** the supported contract SHALL expose the interval as unavailable
- **AND** it SHALL NOT synthesize claim rights from diagnostic level rows

## REMOVED Requirements

### Requirement: External fallback producers conform without expanding broker scope

**Reason**: CEX no longer admits an external historical producer; allowing a fallback producer would reopen the removed ownership boundary.

**Migration**: Move vendor acquisition and cold-object reconstruction to Maker and reject every external source at the CEX forwarder.

### Requirement: Capture origin is distinct from producer admission source

**Reason**: `capture_origin` exists only to distinguish vendor acquisition provenance inside the removed external-backfill path.

**Migration**: Preserve required broker/live provenance in the bounded capture metadata, then remove the vendor-only column during the terminal deployed-schema migration.

### Requirement: External historical capture provenance is generic and reproducible

**Reason**: CEX no longer stores external historical captures or owns their provenance model.

**Migration**: Maker's vendor-object reader SHALL own cold-segment provenance and reconstruction evidence independently of the CEX hot schema.
