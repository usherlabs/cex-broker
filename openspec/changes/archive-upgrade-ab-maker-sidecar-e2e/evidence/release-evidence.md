# Canonical archive candidate evidence

Status: CEX-owned implementation and acceptance complete; Maker-owned external
orchestration remains pending and this report is not yet cross-service release
conformance.

## Source identities

- CEX pre-upgrade A: `develop` at
  `7a83de5f29a08f42d81f64a75a83bc9318dce94a`, package `0.2.38`
- CEX post-upgrade B: `3398066ae2c396a9a9e0220f88715ac22b6d8694`
- FIET Maker authoritative `develop` resolved for interface testing:
  `e28bc3329f8a3f931046ef0279471af875ba58fd`
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

## CEX-owned sidecar interface proofs

Both controlled, credential-free profiles used the production archive-forwarder,
real SQLite spool, Server `24.8.14.39`, normal gRPC broker wiring, and independent
collector. They bind the CEX candidate and resolved Maker `develop` SHA, but do
not substitute for the pending Maker-owned job.

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

- FIET Maker must invoke the sidecar from a clean checkout of its resolved
  `develop`, run its own native emulation/materializer and Layer 12 sandbox jobs,
  and retain the two cross-repository manifests under shared run identities.
- Until those Maker-owned jobs pass, tasks 6.5-6.8, 8.2, 8.4, and 8.5 remain
  open and the OpenSpec change must not be synced or archived.

Production soak was not performed and is not claimed. It is intentionally not a
completion requirement for this change.
