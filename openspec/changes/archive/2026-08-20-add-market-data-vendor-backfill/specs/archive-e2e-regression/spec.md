## MODIFIED Requirements

### Requirement: Canonical lifecycle output is restricted to the closed inventory
Raw broker captures SHALL use `market_data.cex_stream_events`; normalized ticker
and trade rows SHALL use `market_data.cex_ticker_events` and
`market_data.cex_trades`; post-baseline normalized rows SHALL use only
`market_data.cex_ohlcv`, `market_data.cex_order_book_levels`, and
`market_data.cex_order_book_depth_summary`; and external-backfill qualification
SHALL use only `market_data.cex_order_book_capture_promotions`. View assertions
MUST use `market_data.cex_ohlcv_closed`, the existing order-book canonical and
conflict views, plus
`market_data.cex_order_book_levels_replay_qualified` and
`market_data.cex_order_book_depth_summary_replay_qualified`.

#### Scenario: Canonical inventory is checked
- **WHEN** the suite compares the integrated forwarder and schema with the pre-canonical 15-table inventory
- **THEN** the post-baseline supported base tables MUST be exactly `market_data.cex_ohlcv`, `market_data.cex_order_book_levels`, `market_data.cex_order_book_depth_summary`, and `market_data.cex_order_book_capture_promotions`
- **AND** every named canonical, conflict, and replay-qualified view MUST execute against its corresponding base table

#### Scenario: Canonical output is evaluated
- **WHEN** canonical-only lifecycle or bounded backfill output is queried
- **THEN** additive rows MUST be classified by the named raw, normalized, or
  promotion destination and producer identity
- **AND** an unexpected table, view substitution, or unclassified extra row MUST fail the suite rather than be accepted as arbitrary additive output

## ADDED Requirements

### Requirement: Final-v1 archive conformance covers identity and authority transitions
The isolated ClickHouse/forwarder suite SHALL cover production-only coverage,
authoritative vendor promotion, idempotent selection reuse, fill-gaps
composition, qualification quarantine and revocation, unauthorized production
submission, and reader/forwarder cluster mismatch using the final v1 schemas
and hash fixtures.

#### Scenario: Final-v1 protected provider gate runs
- **WHEN** all synthetic schema, policy, archive, authorization, and qualification tests pass
- **THEN** the OKX live-provider gate MUST be rerun with final origin/mode, receipt, selection, and policy identities
- **AND** retained evidence MUST remain hash-safe

### Requirement: Real ClickHouse proves the promotion commit boundary
The archive E2E suite SHALL use the production schema, HTTP request parser,
allowlist, inserter, and real pinned ClickHouse runtime to prove external capture
qualification. It MUST cover complete promotion, partial insertion, malformed
promotion rejection, same-receipt retry, conflicting candidate rows, old
historical source timestamps, and replay-qualified export selection.

#### Scenario: Partial candidate is not replay eligible
- **WHEN** only a subset of deterministic external-backfill chunks is inserted
- **THEN** physical rows MUST remain queryable by capture identity
- **AND** both replay-qualified order-book views MUST return zero candidate rows

#### Scenario: Passing promotion qualifies the exact scope
- **WHEN** all candidate rows are inserted and one valid passing promotion row is
  committed
- **THEN** replay-qualified views MUST expose only the receipt-bound exchange,
  pair, window, depth, construction, and schema scope
- **AND** the retained exporter MUST consume that qualified scope

#### Scenario: Historical external rows survive TTL processing
- **WHEN** external-backfill rows older than the live retention horizon are
  inserted and ClickHouse TTL maintenance is exercised
- **THEN** the external rows MUST remain available for promotion and qualified
  replay
- **AND** equivalent expired broker-origin rows MUST retain their existing TTL
  behavior

### Requirement: Worker conformance covers the closed state machine
Required tests SHALL cover request validation before I/O, deterministic
idempotency and capture identities, complete qualified preflight, capability
before credentials, every closed result status, provider budget enforcement,
snapshot/update reconstruction, sequence and timestamp failures, forwarder
chunking/retry, semantic promotion, and secret redaction. Tests MUST use
synthetic or expressly redistributable provider fixtures; licensed real vendor
rows MUST NOT be checked into the repository.

#### Scenario: Provider integration evidence is retained
- **WHEN** an opt-in secret-backed provider conformance run succeeds
- **THEN** retained evidence MUST contain only non-secret object identities,
  counts, versions, and cryptographic hashes
- **AND** it MUST NOT publish downloaded vendor payload rows

### Requirement: Live provider promotion is verified against isolated ClickHouse
The opt-in CEX-owned gate SHALL run the complete worker with a licensed provider
object before the initial provider profile is declared ready, using the production
schema and HTTP forwarder, and an ephemeral ClickHouse Server 24.8 instance. The
gate MUST remain absent from pull-request, push, and scheduled CI and MUST
require explicit credential and positive-control window injection.

#### Scenario: Live provider object is promoted and replayed idempotently
- **WHEN** the protected gate runs one bounded supported request against an empty
  isolated archive
- **THEN** the first invocation MUST return `promoted`, persist one exact-scope
  passing receipt, expose nonzero matching candidate and qualified rows, and
  satisfy the qualified reader and canonical exporter
- **AND** an identical second invocation MUST return `already_covered` without
  changing row or promotion counts

#### Scenario: Live gate retains secret-free evidence on every outcome
- **WHEN** the gate succeeds or fails after startup
- **THEN** it MUST atomically retain a versioned pass/fail record containing
  only versions, scope, stable statuses and reasons, identities, counts,
  durations, and cryptographic hashes
- **AND** it MUST clean up downloaded bytes, exported files, forwarder state,
  credentials, and the isolated archive without publishing vendor rows or
  response bodies
