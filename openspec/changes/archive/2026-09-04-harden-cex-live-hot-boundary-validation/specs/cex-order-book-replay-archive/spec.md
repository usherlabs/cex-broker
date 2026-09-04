## ADDED Requirements

### Requirement: Supported summary-v2 view types are installation independent

The supported summary-v2 canonical view SHALL expose the normative field names, order, nullability, and ClickHouse types through an explicit projection. A database upgraded from the retained legacy physical table SHALL expose the same supported-view contract as a fresh installation without destructive startup mutation of legacy physical rows.

#### Scenario: Legacy physical schema is upgraded

- **WHEN** current DDL is applied to a database whose summary table retains nullable legacy identity columns
- **THEN** `DESCRIBE` of the supported canonical view SHALL match the normative v2 field list and types
- **AND** complete v2 rows SHALL match the same typed fixture projection as a fresh database

### Requirement: Summary-v2 band evidence is bounded

Every admitted summary-v2 row SHALL contain `1..64` ascending unique measurement bands in `1..10000` basis points, and every aligned boundary, depth, and status array SHALL have the same bounded length.

#### Scenario: Summary carries excessive or invalid bands

- **WHEN** a summary row carries more than 64 normalized bands or a band outside `1..10000`
- **THEN** admission SHALL reject the row before durable insertion
