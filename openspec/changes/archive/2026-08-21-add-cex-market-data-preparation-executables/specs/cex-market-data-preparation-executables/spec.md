## ADDED Requirements

### Requirement: Preparation commands are standalone bounded file jobs
CEX Broker SHALL publish `market-data-vendor-backfill` and
`cex-canonical-orderbook-export` as executable npm bins that require Node 22 or
newer and accept exactly `run --request <path> --result <path>`. Each command
MUST run after the npm tarball is extracted into an otherwise empty directory
without a sibling checkout, `node_modules`, Python, DuckDB, Bun, or `PATH`
product discovery.

#### Scenario: Extracted product is invoked
- **WHEN** either command is launched by its exact relative path from an extracted package
- **THEN** it MUST execute without importing or starting the gRPC server
- **AND** the existing `cex-broker` bin MUST remain backward compatible

### Requirement: File jobs fail closed at the caller-owned attempt boundary
Request, required-clock, result, and exporter artifacts SHALL remain beneath one
non-symlink caller-owned attempt directory. Reads MUST be bounded regular-file
reads with no-follow semantics; traversal and every symlink MUST be rejected.
Handled outcomes MUST atomically replace and fsync a complete result, while an
inability to commit that result MUST exit nonzero.

#### Scenario: Input or output boundary is unsafe
- **WHEN** a path traverses a parent, follows a symlink, names a non-regular file, exceeds its byte cap, or escapes the request parent
- **THEN** the job MUST NOT read or write through that unsafe boundary
- **AND** no stale successful result may remain authoritative

### Requirement: Backfill result v2 identifies the CEX producer
The backfill executable SHALL emit
`https://schemas.usher.so/market-data-vendor-backfill-result/v2`. Its closed
producer identity MUST contain product ID/version, CEX package name/version,
the baked release git head, the SHA-256 of the running executable, and actual
Node runtime name/version. It MUST NOT contain `fiet_tee_commit`, a build
timestamp, or the npm tarball digest.

#### Scenario: Maker validates a successful worker result
- **WHEN** the executable durably returns `already_covered` or `promoted`
- **THEN** its result digest, request-file digest, manifest/policy pins, producer identity, timing, selection, receipt, and diagnostics MUST validate
- **AND** the executable digest MUST equal the bytes that Maker launched

### Requirement: Canonical export consumes an exact qualified selection
The exporter request SHALL bind target archive identity, one archive-selection
v1 document, depth, construction mode, canonical schema version, and checksum
algorithm. The exporter MUST query each selected capture bundle only inside its
exact half-open interval and scope, use replay-qualified views, reject current
qualification or checksum conflicts, preserve authoritative-window vendor
exclusivity, and apply archive-wins precedence for fill-gaps overlaps.

#### Scenario: Disjoint bundles share a broad outer window
- **WHEN** selected bundle intervals have unrelated rows between or outside them
- **THEN** those rows MUST be absent from levels, summaries, row counts, and query identity
- **AND** every exported row MUST match one effective selection segment

#### Scenario: Selected evidence is conflicted or revoked
- **WHEN** either conflict view contains a matching logical snapshot or current qualification excludes a selected vendor bundle
- **THEN** the result MUST be a closed non-success outcome
- **AND** no successful Parquet descriptors may be committed

### Requirement: Export result commits exact query and artifact evidence
A successful exporter result SHALL bind the request-file hash, selection hash,
JCS query hash, effective ordered query segments, receipt identities, producer
identity, and relative levels/summary descriptors including row count, byte
count, and SHA-256. The result MUST be written after both validated Parquet
files and act as their commit marker.

#### Scenario: Export succeeds
- **WHEN** exact qualified levels and summaries are conflict-free and complete
- **THEN** both Parquet files MUST have valid envelopes and matching receipt descriptors
- **AND** recomputing the query and artifact hashes MUST reproduce the result identities

### Requirement: Product pin binds the published preparation release
After publication, CEX SHALL record a closed
`cex-market-data-preparation-product-pin/v1` document containing the exact npm
tarball URL, SRI, SHA-256, package version, npm git head, both executable
relative paths/product versions/SHA-256 values, preparation manifest identity,
all referenced schema identities, and both policy identities. It MUST contain
no Fiet path, Fiet commit, or build timestamp.

#### Scenario: Release evidence is handed to Maker
- **WHEN** the registry tarball has been published and re-audited
- **THEN** every identity in the product pin MUST be derived from that registry artifact
- **AND** both extracted bins MUST have passed standalone and secret-reflection gates
