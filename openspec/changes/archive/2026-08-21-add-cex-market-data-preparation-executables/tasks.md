## 1. Versioned contracts

- [x] 1.1 Add failing tests that preserve every v1 manifest/schema/fixture/public API identity and define result v2 producer semantics.
- [x] 1.2 Implement result v2 schema, codec, finalizer, producer types, and preparation manifest v2 without changing v1 assets or names.
- [x] 1.3 Add exporter request/result v1 and preparation product-pin v1 schemas, codecs, JCS identities, and conformance fixtures to manifest v2.

## 2. Bounded file-job products

- [x] 2.1 Add failing tests for exact argv, Node 22, bounded no-follow reads, attempt-root containment, symlinks, executable self-hash, secret redaction, and atomic durable results.
- [x] 2.2 Implement shared file-job filesystem/runtime helpers under `src/helpers/`.
- [x] 2.3 Implement the CEX-owned `market-data-vendor-backfill` command with environment-only dependencies, lazy vendor credentials, and result v2.

## 3. Exact qualified archive export

- [x] 3.1 Add failing unit tests for exact segment compilation, authoritative-window and fill-gaps precedence, query identity, and closed exporter results.
- [x] 3.2 Implement the exact-selection exporter helper and `cex-canonical-orderbook-export` file-job command.
- [x] 3.3 Add failing archive-reader regression tests for checksum conflicts during initial selection, then implement conflict-aware preflight.
- [x] 3.4 Add ClickHouse integration coverage for disjoint intervals, unrelated rows, unqualified/revoked rows, conflicts, receipt linkage, and Parquet hashes.

## 4. Package and architecture

- [x] 4.1 Add both Node 22 standalone build entrypoints, npm bins, package exports/assets, declarations, executable modes, and extracted-tarball audit.
- [x] 4.2 Update retained conformance/export callers to use the exact helper where qualification is required while preserving broad diagnostic validation.
- [x] 4.3 Update service architecture and operator documentation to record CEX ownership and the no-daemon/no-RPC boundary.
- [x] 4.4 Bump the release version to `0.2.47` and add product-pin/release-evidence generation scaffolding without fabricating post-publication identities.

## 5. Verification

- [x] 5.1 Pass targeted contract, file-job, exporter, reader, package, and ClickHouse tests.
- [x] 5.2 Pass the full unit suite, TypeScript, Biome, server-line budget, strict OpenSpec, package build, and archive E2E gates.
- [x] 5.3 Record hash-safe candidate evidence and the exact remaining protected-provider/publish/post-registry steps.
