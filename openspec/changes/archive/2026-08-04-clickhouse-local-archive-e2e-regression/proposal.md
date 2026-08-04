## Why

Archive tests currently exercise subscription capture, queue durability, HTTP forwarding, and ClickHouse schemas in separate layers, while the ClickHouse-backed suite silently returns when no server is available. The final canonical archive design also removes runtime write modes and broker-side credential classification, so a required deterministic regression gate must prove the canonical-only lifecycle and historical storage compatibility without recreating either removed configuration surface.

## What Changes

- Add a dedicated, non-skipping ClickHouse Local E2E suite pinned to ClickHouse `v25.8.24.21-lts` and isolated in a temporary persistent-local database.
- Commit an immutable golden baseline for the runtime at `64fdf0607a234be05bac98f3edd3125e2c05d083`, which is runtime-equivalent to `develop` at `d20daf895616cdce1cff65a8191c0bb937583c6a`, covering all 15 tables accepted by the pre-canonical archive forwarder.
- Exercise deterministic fake CEX frames through the production multi-feed collector implementation used by the collector service, broker gRPC server, archive writer, production HTTP request handler and router, and a ClickHouse Local `RowInserter` adapter.
- Bind canonical assertions to the prerequisite's exact raw, normalized, and query-view inventory so additive output is explicitly allowlisted rather than accepted by an open-ended rule.
- Verify all 15 historical tables through fixture-driven production HTTP parsing, routing, insertion, and exact query-back; do not require the upgraded writer to emit legacy rows.
- Run the real four-feed lifecycle with deployment provenance `CEX_BROKER_ARCHIVE_SOURCE=broker_read` and the upgraded canonical-only writer, proving per-feed raw-to-normalized linkage, capture and provider provenance, stored checksums, canonical views, and order-book-specific duplicate and checksum-conflict behavior.
- Prohibit test, smoke, and production paths from restoring runtime legacy/dual/canonical write modes, credential-source policy, credential profiles, permission attestations, or equivalent broker-side classification logic.
- Add blocked, recoverable-failure, and terminal-failure sink scenarios proving that archival cannot delay or terminate successful gRPC delivery and that every undelivered row is retried or represented exactly once by the production loss-journal record and reason.
- Add a required `test:e2e:archive` CI gate and a separate scheduled/manual, non-merge-gating, credentialless `test:smoke:archive` workflow limited to public market-data subscriptions.
- Retain the existing ClickHouse-server integration suite because ClickHouse Local does not exercise the production `@clickhouse/client` network transport.
- Preserve the `canonical-cex-market-data-replay-archive` OpenSpec artifacts unchanged and introduce no production protobuf, RPC, or public API changes.

## Capabilities

### New Capabilities

- `archive-e2e-regression`: Deterministic ClickHouse Local lifecycle, legacy-baseline compatibility, canonical archive integrity, failure isolation, required CI, and bounded live-CEX smoke verification.

### Modified Capabilities

- None.

## Impact

- Test-only ClickHouse Local bootstrap, harness, fixtures, fake exchange, E2E tests, and baseline-regeneration tooling.
- Package test commands and CI configuration, plus a scheduled/manual credentialless live-CEX smoke workflow.
- Existing broker server, subscribe handler, collector, archive writer, forwarder parser/router, `RowInserter` boundary, and ClickHouse schema files are exercised as production paths but keep their external contracts unchanged.
- Applying the tasks requires the corrected canonical archive implementation through `2730a00a0fcd6cbafbcb03cb432fa7f4224d269a` to be integrated first; this regression change does not amend that prerequisite's final OpenSpec artifacts.
