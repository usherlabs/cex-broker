## MODIFIED Requirements

### Requirement: ClickHouse and parquet share a capture-core contract
The canonical ClickHouse order-book tables and CEX-exported Maker Parquet files SHALL
share names and semantics for capture-core fields while allowing Maker
materialization to add run-scoped coverage and assumption fields separately.
`cex-order-book-canonical/v1` SHALL remain the row/archive semantic identity.
The levels and depth-summary files SHALL each use a separate immutable
projection schema document that defines ordered capture-core column names,
physical and logical types, nullability, and bound metadata. Those documents
MUST NOT contain Maker run-scoped fields and MUST NOT be a hash or copy of
ClickHouse- or library-specific serialized schema output. Each projection
document MUST declare consistency with `cex-order-book-canonical/v1`.

#### Scenario: Broker rows are exported for Maker
- **WHEN** canonical ClickHouse rows are converted into `order_book_levels.parquet` and `order_book_depth_summary.parquet`
- **THEN** capture-core fields MUST map without semantic reinterpretation and in the order and physical types defined by the corresponding projection document
- **AND** exchange, pair, provider, timestamps, construction mode, source mode, gap policy, depth, identities, and checksums MUST be preserved

#### Scenario: Maker adds replay-run metadata
- **WHEN** Maker coverage planning adds run id, coverage report, as-of lag, future-leakage, or assumption fields
- **THEN** those fields MUST be treated as a materialized extension of the immutable broker capture
- **AND** they MUST NOT alter the original capture checksum, provenance, or CEX projection identity

#### Scenario: Physical schema validation is implementation-independent
- **WHEN** the exporter validates a generated Parquet file
- **THEN** it MUST compare ordered columns, physical and logical types, nullability, and bound metadata with the canonical projection document
- **AND** it MUST NOT derive acceptance from ClickHouse `FORMAT Parquet` serialization or a runtime library's schema string hash

### Requirement: Qualified export rejects unqualified bundle selection
Reusable archive-reader and Parquet-export logic SHALL query replay-qualified
views, preflight level and summary checksum conflicts, validate current external
qualification, and preserve source, capture, promotion, canonical-row, and
projection identities. The packaged exporter MUST compile the exact selected
bundle intervals, scope, depth, construction mode, canonical schema, checksum
algorithm, origin, source-policy precedence, and required current promotion
receipts into bound query segments. Supplying a physical bundle ID or a broad
outer window MUST NOT bypass qualification or admit unrelated rows. Before
committing a successful result, the exporter MUST validate both physical
Parquet schemas against their pinned projection documents.

#### Scenario: Exporter receives an unqualified external bundle
- **WHEN** an export request names a physically present external-backfill bundle without a matching current qualified state and current passing promotion receipt
- **THEN** the exporter MUST return a typed non-success result
- **AND** it MUST NOT commit successful Parquet descriptors

#### Scenario: Qualified capture is exported
- **WHEN** every selected interval has matching conflict-free replay-qualified rows for the complete requested scope
- **THEN** the exporter MUST preserve canonical capture-core fields, exact query segments, current promotion identities, and projection identities needed by the consumer manifest
- **AND** rows from unselected intervals or bundles MUST be excluded

#### Scenario: Authoritative production archive hit is exported
- **WHEN** an `authoritative_window` selection contains only qualified production archive intervals because no qualified vendor bundle was selected
- **THEN** the exporter MUST accept and bind that pure production selection without requiring a vendor receipt
- **AND** an `authoritative_window` selection that mixes production and vendor origins MUST be rejected

#### Scenario: Initial selection intersects checksum conflicts
- **WHEN** relevant level or summary conflict views contain a logical snapshot in the requested scope and coverage window
- **THEN** archive preflight MUST fail before complete, partial, or missing classification
- **AND** vendor capability or credential resolution MUST NOT occur

#### Scenario: Unselected rows share the requested outer window
- **WHEN** qualified rows from another bundle or origin fall inside the selection's broad time bounds
- **THEN** the exporter MUST exclude them unless an exact selected interval names them under the applicable precedence
- **AND** their presence MUST NOT change the query or artifact identities

#### Scenario: Receipt qualification changed after selection
- **WHEN** a selected vendor bundle has no latest passing receipt under the exact current policy tuple
- **THEN** the exporter MUST fail closed with no successful artifact descriptors
- **AND** physical row presence or an immutable historical receipt MUST NOT bypass current qualification

#### Scenario: A Parquet projection differs from its descriptor
- **WHEN** either physical Parquet schema differs from its pinned ordered projection document
- **THEN** the exporter MUST return `archive_data_invalid` with reason subcode `parquet_projection_schema_mismatch`
- **AND** it MUST commit null successful descriptors and exclude the mismatched files from Maker consumption
