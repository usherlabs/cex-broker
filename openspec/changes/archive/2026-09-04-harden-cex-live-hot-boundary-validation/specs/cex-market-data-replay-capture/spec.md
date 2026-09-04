## ADDED Requirements

### Requirement: Market deployment admission is non-empty and row-bound

When market archive identity is configured, both source and deployment ID SHALL be non-empty after trimming and SHALL be configured together. Every admitted `market_data.*` row SHALL carry a source and deployment ID equal to the authenticated envelope and configured deployment identity.

#### Scenario: Blank or partial identity is configured

- **WHEN** either market source or deployment ID is absent, blank, or whitespace-only while the other is configured
- **THEN** archive-forwarder startup SHALL fail before accepting requests

#### Scenario: Market row overrides deployment identity

- **WHEN** a market envelope matches the configured source and deployment but one row omits or changes `deployment_id`
- **THEN** admission SHALL reject the batch before routing, spooling, or insertion

### Requirement: ORDERBOOK measurement bands are closed and bounded

ORDERBOOK measurement bands SHALL normalize to ascending unique integer values. The normalized array SHALL contain `1..64` entries, and every entry SHALL be in `1..10000` basis points.

#### Scenario: Oversized or out-of-range bands are configured

- **WHEN** normalized bands contain more than 64 entries or any value is outside `1..10000`
- **THEN** the writer SHALL reject configuration or capture before summary calculation

#### Scenario: Forwarder receives invalid bands

- **WHEN** ORDERBOOK raw metadata or a summary-v2 row violates the same cardinality or value bounds
- **THEN** the forwarder SHALL reject it before ClickHouse insertion
