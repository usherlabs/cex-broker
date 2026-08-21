## MODIFIED Requirements

### Requirement: Backfill contracts are versioned, deterministic, and secret-free
The core library SHALL validate `market-data-vendor-backfill-request/v1` before
performing network access and SHALL return its existing closed CEX domain
outcome. The CEX-owned executable SHALL wrap that outcome in
`market-data-vendor-backfill-result/v2`; the package MUST retain the complete
result v1 schema, fixture, codec, manifest, and TypeScript API for compatibility
but the new executable MUST never emit result v1. The request MUST contain
request and idempotency identities, one exchange/pair/market/feed scope, a
bounded half-open source-time window, depth, construction mode, required-clock
identity, maximum prior-as-of lag, order-book source and coverage policies,
target archive identity, initial archive selection, and expected canonical
schema identity. Request, result, logs, errors, receipts, and retained evidence
MUST NOT contain vendor, ClickHouse, archive-forwarder, Vault, or SSH
credentials.

#### Scenario: Invalid request fails before network access
- **WHEN** a request omits a required field, contains an unknown enum, exceeds a bounded budget, or carries an idempotency identity that does not match its canonical business content
- **THEN** the core API MUST return a typed validation failure before invoking any archive or provider dependency

#### Scenario: Secrets are supplied outside wire files
- **WHEN** the worker authenticates to a provider, ClickHouse, or the archive forwarder
- **THEN** credentials MUST arrive through injected dependencies or the executable's closed environment allowlist
- **AND** no credential value MAY appear in request/result JSON, receipt projections, argv, logs, retained subprocess output, or evidence hashes

#### Scenario: Legacy v1 consumer imports the patch release
- **WHEN** a consumer loads the existing result v1 codec, fixture, schema path, or manifest path from `0.2.47`
- **THEN** its bytes, identifiers, canonical hashes, and public TypeScript meaning MUST remain unchanged from `0.2.46`
