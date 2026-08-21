## MODIFIED Requirements

### Requirement: Qualified export rejects unqualified bundle selection
Reusable archive-reader and Parquet-export logic SHALL query replay-qualified
views, preflight level and summary checksum conflicts, validate current external
qualification, and preserve source/capture/promotion identities. The packaged
exporter MUST compile the exact selected bundle intervals, scope, depth,
construction mode, schema, checksum algorithm, origin, and source-policy
precedence into bound query segments. Supplying a physical bundle ID or a broad
outer window MUST NOT bypass qualification or admit unrelated rows.

#### Scenario: Exporter receives an unqualified external bundle
- **WHEN** an export request names a physically present external-backfill bundle without a matching current qualified state and passing promotion record
- **THEN** the exporter MUST return a typed non-success result
- **AND** it MUST NOT commit successful Parquet descriptors

#### Scenario: Qualified capture is exported
- **WHEN** every selected interval has matching conflict-free replay-qualified rows for the complete requested scope
- **THEN** the exporter MUST preserve canonical capture-core fields, exact query segments, and promotion identities needed by the consumer manifest
- **AND** rows from unselected intervals or bundles MUST be excluded

#### Scenario: Initial selection intersects checksum conflicts
- **WHEN** relevant level or summary conflict views contain a logical snapshot in the requested scope and coverage window
- **THEN** archive preflight MUST fail before complete, partial, or missing classification
- **AND** vendor capability or credential resolution MUST NOT occur
