# Canonical archive candidate evidence

Status: the immutable CEX archive implementation/A-B acceptance is retained;
the sidecar harness is being amended for a genuine external Maker producer.
Maker-owned execution evidence remains pending, so this report is not yet
cross-service release conformance.

## Source identities

- CEX pre-upgrade A: `develop` at
  `7a83de5f29a08f42d81f64a75a83bc9318dce94a`, package `0.2.38`
- CEX reviewed archive implementation B:
  `3398066ae2c396a9a9e0220f88715ac22b6d8694`
- CEX amended sidecar harness: pending clean candidate commit; required results
  will record this as `candidateSha` and the reviewed implementation separately
  as `archiveImplementationSha`
- FIET Maker authoritative `develop`: resolved only when the post-merge
  conformance command runs; no proposal-time Maker SHA is a release pin
- Baseline fixture content:
  `f600be17f20d4cafa26f6486469f10818b0c0171ad78f96c658a0c9baa76409e`

## CEX gates

- Normal suite: 629 passed, zero failed, including required real-Server schema
  integration against ClickHouse 24.8.
- ClickHouse Local `25.8.24.21`: the serialized archive E2E passed twice from
  separate temporary persistent paths.
- Strategy source/admission, replay, spool, telemetry, migration, sidecar, and
  baseline contract tests: passed.
- Python canonical checksum fixture: passed.
- Repository check, server line budget, TypeScript build/typecheck, package
  import/construction, and `openspec validate --all --strict`: passed.
- The credentialless smoke operation guard passed. No live public-feed smoke or
  venue credentials were used as release evidence.

## One-time A/B result

`archive-upgrade-ab-acceptance.json` has SHA-256
`1793bb107534635a5a960a22c1e15a85cac216a21037089fdad8c352cf9fa1ff`.
It records a clean candidate (`dirty=false`), Server `24.8.14.39`, identical
15-table starting datasets, confirmed non-zero migration over
`[2000000000000, 2000000040001)`, stable second-run logical counts/checksums,
zero parameter-bound parity mismatches, empty conflict views, honest incomplete
legacy provenance, unchanged A and legacy B projections, and canonical-only
upgraded ORDERBOOK/OHLCV writes.

## Superseded CEX-only sidecar interface proofs

The following controlled, credential-free runs used the production
archive-forwarder, real SQLite spool, Server `24.8.14.39`, normal gRPC broker
wiring, and independent collector. Review of the handoff found that the CEX
supervisor itself generated the five strategy rows. Their hashes remain here to
preserve history, but they no longer qualify as either Maker profile and cannot
close any external-evidence task.

- `native_replay`: HTTP 200 synchronous `maker_replay`; all five strategy tables
  queried with v2 identity; spool stayed empty; all four market feeds had raw and
  canonical coverage; FIET-907 reference Parquet contained four levels and one
  summary. Verification SHA-256:
  `74f9cd86f41e0d4092a60234f7f463ea252d5aa6fec36dfe4e8719ece10c7318`.
- `production_compatible`: HTTP 202 durable `hb_runtime`; all five strategy
  tables queried with v2 identity; queued/terminal spool work drained to zero.
  Verification SHA-256:
  `606d9442308ec7c1e21cd3d019ec01920671c73e3d79f6b74f3241ef2ae7edb1`.

## Explicitly pending

- Task 6.5 now has Maker-owned orchestration, PR 1067/fixture preflight, a
  checksum-bound CEX-to-Maker Parquet adapter, the real Hummingbot v2.13
  `layer12_live`/external-broker gate, and unconditional sidecar cleanup.
- FIET Maker must still invoke the amended sidecar from a clean post-merge
  `develop`, run the native materializer and production-compatible jobs, and
  retain the two cross-repository manifests under shared run identities.
- Until those jobs pass, tasks 6.6-6.8, 8.2, 8.4, and 8.5 remain open and the
  OpenSpec change must not be synced or archived.

Production soak was not performed and is not claimed. It is intentionally not a
completion requirement for this change.
