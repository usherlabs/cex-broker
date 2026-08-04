## Why

The canonical archive implementation and the ClickHouse Local E2E work were developed on separate branches, so neither branch alone proves that a deployment can upgrade from the current `develop` release without changing historical data or breaking FIET Maker's archive contract. We need one reproducible regression and cross-service conformance plan that integrates both bodies of work, treats CEX Broker `develop` as the authoritative pre-upgrade control, and produces release-grade evidence against real ClickHouse.

## What Changes

- Integrate the archive E2E implementation from `ed/clickhouse-local-e2e-5medm` with the post-upgrade archive, collector, and durable strategy-forwarder implementation, including the canonical `MarketDataCollector` interface, real strategy spool lifecycle, cross-language checksum fixtures, and valid post-archive OpenSpec validation.
- Add a true A/B upgrade test. Both sides start from the same committed export generated from a clean CEX Broker `develop` checkout; A remains on the pre-upgrade schema and B applies the production canonical DDL and migration. The resolved `develop` commit, currently `7a83de5f29a08f42d81f64a75a83bc9318dce94a`, is recorded in fixture provenance rather than treated as a floating CI input.
- Run the migration twice against B, compare the exact legacy projections and row counts with A, verify canonical provenance/parity/conflict views, and then prove that an upgraded broker writes canonical tables only.
- Retain the pinned ClickHouse Local suite as the fast deterministic lifecycle gate, and add a mandatory ClickHouse Server 24.8 job for the production HTTP client, migration, deduplication, and spool-drain boundaries.
- Provide a CEX-owned test sidecar interface that a FIET Maker job can start, inspect, verify, and stop. Its bounded evidence manifest records resolved CEX/Maker commits, endpoints, run identity, schema versions, and tool versions without secrets.
- Define two honest Maker conformance profiles: native emulated replay consumes FIET-907 materialized ClickHouse fixtures and reports `maker_replay`; the production-compatible Layer 12 path uses the live broker boundary and reports `hb_runtime` through durable spool acceptance. Native replay MUST NOT be represented as a live CEX Broker connection or as `hb_runtime`.
- Add explicit synchronous `maker_replay` strategy ingestion while preserving durable HTTP 202 spool ownership for `hb_runtime`; keep broker market/account/execution rows on their existing synchronous path.
- Keep Parquet materialization separate from broker capture: the retained direct-ClickHouse reference exporter remains a FIET-907 tool and is exercised only as the boundary between canonical storage and native Maker replay fixtures.
- Replace production-soak closure with deterministic cross-service conformance evidence. Production observation remains a separate operational concern and is not required by this change.

## Capabilities

### New Capabilities

- `archive-e2e-regression`: Pinned ClickHouse Local lifecycle coverage for the integrated collector, broker, writer, forwarder, schemas, canonical integrity, historical compatibility, and failure accounting.
- `archive-upgrade-ab-regression`: Immutable `develop`-derived A/B fixtures and real ClickHouse Server verification of the production legacy-to-canonical migration and upgraded canonical-only writes.
- `maker-archive-sidecar-conformance`: The reusable CEX test-sidecar interface, Maker-owned orchestration boundary, native replay and production-compatible profiles, and cross-repository evidence contract.

### Modified Capabilities

- `strategy-runtime-archive-ingestion`: Admit the explicit `maker_replay` strategy source synchronously while retaining durable spool ownership and HTTP 202 acknowledgement exclusively for live `hb_runtime` batches.
- `cex-broker-service-architecture`: Document the test sidecar, A/B harness, cross-repository ownership boundaries, and the distinction between live Maker integration and offline FIET-907-backed replay.

## Impact

- CEX Broker E2E support, collector test integration, archive-forwarder request classification, schema/migration runners, fixtures, CI workflows, and release evidence.
- Real ClickHouse Server 24.8 becomes a required archive-upgrade/conformance dependency; ClickHouse Local `v25.8.24.21-lts` remains a separate pinned fast gate.
- FIET Maker `develop` supplies the external orchestration and is resolved to an immutable commit in evidence (currently `e28bc3329f8a3f931046ef0279471af875ba58fd`); the CEX repository supplies the sidecar contract and verifier.
- FIET-907 continues to own fixture materialization, coverage, and replay-bundle assembly; CEX Broker only retains and tests the direct-ClickHouse reference export boundary.
- Existing broker RPC registration, optional archival startup, credential precedence, and production service topology are unchanged. The sidecar is a test composition, not a new production service or credential configuration surface.
