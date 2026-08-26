## ADDED Requirements

### Requirement: Preparation acceptance covers the actual producer and consumer boundary
Release acceptance SHALL require the repository-declared unit suite, build,
type checks, changed-file lint, package audit, file-job conformance, ClickHouse
integration, archive-forwarder image smoke, and secret-reflection checks to
pass. Any reported branch-suite failure MUST have a reproducible RED record
identifying the exact command, tool versions, environment assumptions, failing
assertions, and commit, followed by a zero-failure GREEN result for the same
runner. Acceptance SHALL also require one complete pair-scoped `fill_gaps`,
depth-100 output chain for each of OKX Spot ARB-USDT and ARB-USDC: successful
backfill outcome, complete exact selection, current promotion receipt for every
selected vendor bundle, successful exact export, and independent Maker
descriptor and real-loader consumption.

#### Scenario: Pull-request checks pass but source outputs are incomplete
- **WHEN** repository checks are green but either pair lacks complete current qualification, exact selection, exact export, or Maker consumer proof
- **THEN** the preparation successor MUST remain unaccepted
- **AND** it MUST NOT be published merely to satisfy a version or package checkpoint

#### Scenario: The declared unit suite is reported failing
- **WHEN** a branch or external runner reports a unit-suite failure
- **THEN** the exact runner command, versions, environment assumptions, failing assertions, and commit MUST be retained as RED evidence
- **AND** completion MUST include a zero-failure rerun of that command plus the repository-declared unit command

## MODIFIED Requirements

### Requirement: Preparation commands are standalone bounded file jobs
CEX Broker SHALL publish exactly two preparation executable npm bins,
`market-data-vendor-backfill` and `cex-canonical-orderbook-export`, that require
Node 22 or newer and accept exactly `run --request <path> --result <path>`.
Each command MUST run after the npm tarball is extracted into an otherwise
empty directory without a sibling checkout, external `node_modules`, Python,
DuckDB, Bun, `PATH` product discovery, the gRPC server, `ExecuteAction`, or an
always-on broker process.

#### Scenario: Extracted product is invoked
- **WHEN** either command is launched by its exact relative path from an extracted package
- **THEN** it MUST execute using only packaged runtime assets and explicitly allowed environment inputs without importing or starting the gRPC server
- **AND** the existing `cex-broker` bin MUST remain backward compatible

### Requirement: File jobs fail closed at the caller-owned attempt boundary
Request, required-clock, result, and exporter artifacts SHALL remain beneath one
non-symlink caller-owned attempt directory. Reads MUST be bounded regular-file
reads with no-follow semantics; parent traversal, every symlink, non-regular
files, byte-cap violations, and escape from the request parent MUST be rejected.
Every handled outcome MUST write a complete schema-valid temporary result,
file-sync it, atomically replace the requested result, and directory-sync the
replacement. Inability to commit the result MUST exit nonzero, and no thrown
exception, process exit, or log message MAY be the only evidence for a handled
domain outcome.

#### Scenario: Input or output boundary is unsafe
- **WHEN** a path traverses a parent, follows a symlink, names a non-regular file, exceeds its byte cap, or escapes the request parent
- **THEN** the job MUST NOT read or write through that unsafe boundary
- **AND** no stale successful result may remain authoritative

#### Scenario: A handled failure completes
- **WHEN** either file job maps a validated request to a closed non-success outcome
- **THEN** it MUST commit that complete atomic result at the caller-owned boundary
- **AND** inability to perform the atomic commit MUST produce a nonzero process exit

### Requirement: Backfill result v2 identifies the CEX producer
The backfill executable SHALL emit
`https://schemas.usher.so/market-data-vendor-backfill-result/v2` with product
version `market-data-vendor-backfill/v1`. Its closed producer identity MUST
contain product ID/version, CEX package name/version, the baked release git
head, the SHA-256 of the running executable, and actual Node runtime
name/version. Every current result MUST identify capability policy v3 and
resource policy v2. It MUST NOT contain `fiet_tee_commit`, a build timestamp,
the npm tarball digest, or Maker-local attempt, aggregate-pair, report, loader,
or thesis fields.

#### Scenario: Maker validates a successful file-job result
- **WHEN** the executable durably returns `already_covered` or `promoted`
- **THEN** its result digest, request-file digest, manifest and current policy pins, producer identity, timing, selection, required current receipts, and diagnostics MUST validate
- **AND** the executable digest MUST equal the bytes that Maker launched

#### Scenario: A provider or reconstruction failure is handled
- **WHEN** the current provider path detects a sequence, object, normalization, or required-clock failure
- **THEN** result v2 MUST commit the closed status, stable reason code, stable detailed subcode, bounded secret-free diagnostics, request identity, target, producer identity, and current policy pins
- **AND** status alone MUST NOT replace the detailed failure projection

### Requirement: Canonical export consumes an exact qualified selection
The exporter request SHALL bind target archive identity, one archive-selection
v1 document, depth, construction mode, expected canonical row/archive schema
`cex-order-book-canonical/v1`, and checksum algorithm. The exporter MUST query
each selected capture bundle only inside its exact half-open interval and scope,
use replay-qualified views, reject checksum conflicts and absent, historical,
quarantined, or revoked qualification for selected vendor bundles, preserve
authoritative-window vendor exclusivity, and apply archive-wins precedence for
`fill_gaps` overlaps.

#### Scenario: Disjoint bundles share a broad outer window
- **WHEN** selected bundle intervals have unrelated rows between or outside them
- **THEN** those rows MUST be absent from levels, summaries, row counts, and query identity
- **AND** every exported row MUST match one effective selection segment

#### Scenario: Selected evidence is conflicted or not current-qualified
- **WHEN** either conflict view contains a matching logical snapshot or current qualification excludes a selected vendor bundle
- **THEN** the result MUST be a closed non-success outcome
- **AND** no successful Parquet descriptors may be committed

### Requirement: Export result commits exact query and artifact evidence
A successful exporter result SHALL use
`https://schemas.usher.so/cex-canonical-orderbook-export-result/v2` and product
version `cex-canonical-orderbook-export/v2`. It MUST bind the request-file hash,
selection hash, JCS query hash, effective ordered query segments, receipt
identities, producer identity, and relative levels and summary descriptors.
Each descriptor MUST contain safe relative file name, row count, byte count,
SHA-256, projection schema ID, and projection schema SHA-256. The projection
identities MUST be consistent with the request's canonical row/archive schema.
The result MUST be written after both validated Parquet files and act as their
commit marker.

#### Scenario: Export succeeds
- **WHEN** exact qualified levels and summaries are conflict-free, complete, and physically match their ordered pinned projection schemas
- **THEN** both Parquet files MUST have valid envelopes and matching query, receipt, artifact, and schema descriptors
- **AND** recomputing the query, artifact, and schema evidence MUST reproduce the result identities

#### Scenario: A physical Parquet projection differs
- **WHEN** either Parquet file's ordered columns, physical or logical types, nullability, or bound metadata differs from its pinned projection document
- **THEN** the exporter MUST commit `archive_data_invalid` with reason subcode `parquet_projection_schema_mismatch` and null successful descriptors
- **AND** the mismatched files MUST NOT be eligible for Maker consumption

### Requirement: Product pin binds the published preparation release
After publication, CEX SHALL record a closed
`cex-market-data-preparation-product-pin/v2` document containing the exact npm
tarball URL, SRI, SHA-256, package version, `package.npm_git_head`, both
executable relative paths, product versions and SHA-256 values, preparation
schema manifest v3 identity, exactly twelve current schema identities, and the
capability-v3/resource-v2 policy identities. The twelve schema entries MUST be
backfill request v1, backfill result v2, required clock v1, archive selection
v1, promotion receipt v1, export request v1, export result v2, product pin v2,
levels-Parquet projection v1, depth-summary-Parquet projection v1,
source-forensics ledger v1, and source-qualification record v1. It MUST contain
no Fiet path, Fiet commit, `fiet_tee_commit`, or build timestamp.

Registry metadata `gitHead`, product pin `package.npm_git_head`, and runtime
result `producer.package.git_head` SHALL map to the same baked release commit
without renaming those context-specific wire fields. The executable product
versions SHALL remain `market-data-vendor-backfill/v1` and
`cex-canonical-orderbook-export/v2`.

#### Scenario: Release evidence is handed to Maker
- **WHEN** the registry tarball has been published and independently re-audited
- **THEN** every identity in the product pin MUST be derived from that registry artifact
- **AND** both extracted bins MUST have passed standalone and secret-reflection gates

#### Scenario: A local candidate is presented as release evidence
- **WHEN** an artifact has only a source commit, local tarball, prospective version, image tag, or locally computed executable digest
- **THEN** it MUST NOT satisfy the product-pin requirement
- **AND** Maker MUST wait for independently audited registry bytes and identities

#### Scenario: A successor is extracted cleanly
- **WHEN** the published successor is unpacked into an empty directory
- **THEN** every pinned schema, policy, manifest, executable, fixture, declaration, and runtime dependency MUST be present and hash-valid
- **AND** both executables MUST run under Node 22 or newer without external repository state

### Requirement: Identity-bound evidence uses the exact published commit
CEX SHALL query npm and reserve an unused successor version before live
qualification. It SHALL commit that version with all implementation and
generated identities, merge PR #155, freeze the exact clean merge commit, and
run deterministic and live Candidate A/C gates from a clean checkout of that
commit. The tag and published registry package MUST identify the same commit.
Any merge, rebase, squash, version change, generated-identity change, or other
package-byte change after a gate invalidates its identity-bound evidence.

#### Scenario: Qualification ran before the release identity was frozen
- **WHEN** the qualified source tree is not byte- and gitHead-identical to the tagged registry release
- **THEN** the affected deterministic and live identity-bound gates MUST be rerun from the frozen release commit
- **AND** pre-merge evidence MUST NOT be used as final release evidence merely because its source behavior was equivalent

#### Scenario: Maker consumed a local prerelease candidate
- **WHEN** Maker has verified only local or pre-publication CEX artifacts
- **THEN** cross-repository completion MUST remain open
- **AND** Maker MUST independently download, pin, and verify the published registry product before final consumer proof is accepted
