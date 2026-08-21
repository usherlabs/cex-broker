## Context

Version `0.2.46` publishes the reusable vendor-backfill library, five v1 wire
schemas, qualification-aware archive reader, promotion logic, and a retained
Parquet export script. It does not publish a bounded backfill executable, and
its result v1 requires semantically false Fiet TEE build provenance. The export
script accepts a bundle list plus one broad window, which cannot represent the
exact intervals and precedence in an archive-selection document.

The implementation must remain server-independent, preserve the existing v1
package contract, bundle into executable Node 22 files with no installed
dependency tree, and keep credentials out of argv and durable artifacts.

## Goals / Non-Goals

**Goals:**

- Ship two CEX-owned file-job executables in one `0.2.47` npm release.
- Give every durable result a self-verifying CEX producer identity.
- Export only exact replay-qualified selections with conflict and precedence
  enforcement.
- Preserve all existing v1 consumers and the normal broker CLI.
- Produce immutable release identities that Maker can verify after extraction.

**Non-Goals:**

- Add an RPC, daemon, collector loop, or archive-forwarder vendor fetch.
- Give either executable direct ClickHouse write authority.
- Run Maker loaders or grant Maker claim rights from a CEX result alone.
- Publish licensed provider payloads or enable new provider profiles.

## Decisions

### 1. Add versioned contracts beside v1 instead of replacing v1 exports

The existing v1 schema files, manifest, fixture, TypeScript names, and package
exports remain unchanged. A new preparation manifest v2 binds unchanged v1
request/clock/selection/receipt schemas, backfill result v2, exporter
request/result v1, and product-pin v1. New TypeScript APIs use explicit `V2`
names; existing unsuffixed result names continue to mean v1.

Replacing the existing asset paths was rejected because `0.2.46` consumers pin
their canonical identities and a patch release must not silently reinterpret
them.

### 2. File-job mechanics are shared but domain logic remains in concrete helpers

Both commands use one helper for Node/argv validation, bounded no-follow file
reads, attempt-root validation, secret redaction, executable hashing, and atomic
fsync/rename. The commands import concrete backfill/export helpers and never
import `src/index.ts`, `src/server.ts`, or handlers. Backfill domain outcomes
remain owned by the existing core; exporter outcomes are owned by the new
export helper.

Adding subcommands to the ordinary `cex-broker` CLI was rejected because that
CLI represents a long-running gRPC service with unrelated policy arguments.

### 3. Producer identity is intrinsic; package distribution identity is external

Result v2 contains a closed producer with product ID/version, package
name/version, clean release git head, runtime-computed executable SHA-256, and
actual Node name/version. It contains no build timestamp or tarball digest.
Tarball URL, SRI, SHA-256, npm git head, and both executable digests live in the
post-publication product pin, avoiding self-referential package contents.

### 4. Exact export compiles selection evidence into bound query segments

The exporter validates one archive-selection v1 document plus target, depth,
construction mode, schema version, and checksum algorithm. It intersects each
selected interval with its referenced bundle and requested window, orders
segments, and applies `archive` before `vendor` when fill-gaps intervals overlap.
Every SQL value is a named ClickHouse parameter. Levels, summaries, conflicts,
origin, and current qualification are checked under the same effective
predicate. The query identity is the JCS SHA-256 of the selection identity,
scope/contract fields, precedence, and effective non-broad segments.

A single `capture_bundle_id IN (...)` plus one window was rejected because it
admits unrelated rows between disjoint bundle intervals.

### 5. The result receipt is the commit marker for temporary Parquet

The exporter writes levels and summaries under fixed basenames in the unique
caller-owned attempt directory, validates Parquet envelopes, hashes and fsyncs
them, then atomically writes the result last. Absolute host paths never enter
the result. A handled failure atomically replaces the result with a failure
outcome; any leftover files lack a successful matching result and are unusable.

### 6. Release verification executes the packed product, not workspace sources

The build uses Bun's Node-targeted ESM bundling with no external runtime
dependencies, executable shebangs, and mode `0755`. Package tests extract the
tarball into an empty directory and invoke both bins with Node 22. The protected
provider gate runs the extracted backfill followed by the extracted exporter
against disposable ClickHouse Server 24.8. Registry identities are recorded
only after npm publication.

## Risks / Trade-offs

- [Selection intervals overlap or are malformed] → Canonicalize them into
  deterministic precedence segments and reject link/containment mismatches.
- [Qualified views hide a checksum conflict as missing coverage] → Query
  relevant conflict views before classifying selection coverage and before
  export.
- [Secrets appear in server error text] → Persist only stable status/reason
  codes and HTTP status; never persist response bodies or raw thrown messages.
- [A standalone bundle accidentally externalizes a module] → Execute it from an
  extracted tarball with no `node_modules` and audit imports/package contents.
- [Post-publish tarball differs from a local pack] → Derive the authoritative
  pin from the registry tarball and npm metadata after publication.

## Migration Plan

1. Land schemas/codecs and failing contract tests while leaving v1 untouched.
2. Add shared file-job mechanics and the backfill executable.
3. Add exact exporter, conflict-aware reader preflight, and integration tests.
4. Add package bins, extracted-tarball audit, documentation, and version bump.
5. Merge, tag `v0.2.47`, publish, retrieve registry identities, and commit the
   product pin plus hash-safe release evidence.
6. Roll back dispatch by withholding/removing the downstream Maker pin; retain
   append-only archive rows and qualifications. Do not delete evidence.

## Open Questions

None. Downstream Maker invocation and consumer proof are a separate change.
