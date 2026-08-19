## Why

Fiet Maker needs a bounded, pinned preparation product that can promote supported
third-party historical order-book data into the CEX Broker-owned ClickHouse
archive after a verified coverage miss. The current archive can canonicalize and
export broker captures, but it has no vendor adapter, promotion receipt, or
qualification boundary that prevents partially inserted vendor bundles from
becoming replay evidence.

## What Changes

- Add a reusable `market-data-vendor-backfill` core API for versioned,
  secret-free request/result contracts, provider capability discovery,
  idempotent archive preflight, bounded vendor acquisition, canonicalization,
  archive-forwarder submission, promotion verification, and closed outcomes.
- Add an initial CryptoHFTData adapter for supported ORDERBOOK scopes. It reads
  hourly compressed Parquet datasets, reconstructs snapshot/update streams,
  and emits sampled top-N canonical snapshots only after venue-specific clock
  and sequence validation. Unsupported venues, symbols, market types, and exact
  L2 requests fail through the capability gate before credential inspection.
- Add generic external-backfill provenance without making vendor identity an
  archive source enum: `external_backfill` identifies the producer role while
  `provider` identifies CryptoHFTData and later vendors.
- Add append-only capture-bundle promotion records and replay-qualified views.
  External-backfill physical rows remain auditable after partial or failed
  ingestion but cannot satisfy archive coverage or canonical export until a
  passing promotion receipt exists.
- Add FIET-1017 semantic promotion proof for capture-to-archive equivalence,
  unchanged pre-existing prefix/suffix semantics, continuity at old/new seams,
  conflict absence, required-clock coverage, depth/construction fidelity, and
  future-leakage rejection.
- Make historical external-backfill retention explicit so rows are not expired
  immediately by the live-capture source-time TTL.
- Extract reusable qualified archive-reader/export validation from the retained
  reference Parquet script and publish a package subpath that Fiet TEE can bundle
  without starting or importing the gRPC server runtime.
- Preserve the current service boundary: the worker is a bounded tool, not an
  `ExecuteAction`, collector, archive-forwarder fetch extension, or daemon.
  Producer-side deterministic batching and retry remain outside the existing
  strategy-runtime durable spool.

## Capabilities

### New Capabilities

- `market-data-vendor-backfill`: Defines the reusable worker API, wire schemas,
  capability-first provider adapters, bounded acquisition and replay,
  idempotent submission, closed outcomes, and promotion receipt.

### Modified Capabilities

- `cex-market-data-replay-capture`: Adds generic external-backfill capture
  provenance, vendor-normalized raw-capture scope, and qualification-aware
  replay eligibility without allowing the normal broker writer to select the
  external producer source.
- `cex-order-book-replay-archive`: Adds promotion storage, replay-qualified
  order-book views, external-backfill retention, semantic timeline
  qualification, and exporter rejection of unqualified bundles.
- `cex-broker-service-architecture`: Documents the bounded worker and its
  archive-read/vendor-read/forwarder-write boundary while preserving collector,
  broker, and archive-forwarder ownership.
- `archive-e2e-regression`: Extends the exact post-baseline archive inventory and
  real ClickHouse gate with promotion storage, qualified-reader behavior,
  retention, partial-ingest exclusion, and semantic promotion evidence.

## Impact

- New helper modules and a public package subpath under
  `src/helpers/market-data-vendor-backfill/`.
- Additive ClickHouse DDL and qualification-aware views in
  `schema/clickhouse/market_data.sql`.
- Archive-forwarder allowlist, validation, limits, and tests for promotion rows;
  no vendor SDK or credentials enter the forwarder.
- Canonical order-book capture registries, row construction, archive readers,
  reference exporter, build entrypoints, declarations, and package exports.
- New Parquet/Zstd decoding dependencies suitable for the Node/Fiet TEE bundle.
- Unit, forwarder, ClickHouse 24.8, bounded fake-provider, and opt-in
  secret-backed provider conformance tests. Real licensed vendor payloads are
  not checked into the repository or published as evidence.
- Follow-on Fiet TEE work pins the published package and provides atomic
  request/result file handling; Fiet Maker independently re-queries qualified
  ClickHouse output and owns its actual-loader consumer proof.
