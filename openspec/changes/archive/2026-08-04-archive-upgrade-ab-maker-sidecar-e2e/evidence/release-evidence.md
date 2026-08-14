# Canonical archive candidate evidence

Status: accepted. The immutable CEX archive implementation/A-B acceptance and
the exact post-merge Maker-owned sidecar profiles have passed. This report is
the bounded cross-service release conformance record.

## Source identities

- CEX pre-upgrade A: `develop` at
  `7a83de5f29a08f42d81f64a75a83bc9318dce94a`, package `0.2.38`
- CEX reviewed archive implementation B:
  `3398066ae2c396a9a9e0220f88715ac22b6d8694`
- CEX merged `develop` candidate:
  `526e0413bcb2aff12803f6da9720ba75d6759d1d`
- FIET Maker merged `develop` candidate:
  `ca67fc3dbc42032bdf3da613708208e1b3217f5f`
- Maker conformance implementation:
  `fab2b6bacc4522ba5445aa14eac1afcc6b8d9918`
- Maker exact order-author smoke correction found by the post-merge proof:
  `e51e419abd34f4c09ff112a2fba34cdd1ba1caf2`
- Baseline fixture content:
  `f600be17f20d4cafa26f6486469f10818b0c0171ad78f96c658a0c9baa76409e`

## CEX gates

- Final CEX candidate Gitea PR 5 CI run 14 passed on
  `a0014285e8ceea78f4738b0a348ec39fb8c6ce6d` before merge to
  `526e0413bcb2aff12803f6da9720ba75d6759d1d`.
- Local finalization ran 633 CEX unit tests with zero failures, the package
  build/import checks, sidecar typecheck, Python checksum tests, strict OpenSpec
  validation, and the serialized Local E2E with 12 passing cases.
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

## Exact post-merge Maker sidecar result

`maker-sidecar-post-merge-conformance.json` is the whitelisted, secret-free
cross-repository result. Both profiles used clean authoritative `develop`
checkouts and agree on CEX `526e0413...` and Maker `ca67fc3d...`.

- `native_replay` passed through Maker's real native materializer and
  checksum-bound Parquet consumer. It emitted five `maker_replay` rows through
  synchronous HTTP 200, left spool counts at zero, queried all six market and
  five strategy tables, and made no broker-boundary claim. Verification
  SHA-256: `bb57e06daf10a0aacad73f0c7e55b1a78628f8ea64f1fe2186a36b2eb90b1d21`.
- `production_compatible` passed through real Hummingbot v2.13 `fiet_cex` and
  `Layer12LiveController`. It observed two external order-book subscriptions
  and one snapshot RPC, emitted five `hb_runtime` rows through HTTP 202, drained
  the durable spool to zero, and queried the same six market and five strategy
  tables. Verification SHA-256:
  `dd5549c929d93d5ba1dd8fa961789af38ce25e9709107fb733ba00d6ae5dbf98`.
- Maker PR 1067 remained an ancestor and its wire fixture matched
  `784f647e048052a6c3382309b1a86abfbe08bc162363ead9fc88eaa1ba3d50c9`;
  the focused wire-contract command passed in both profile preflights.
- `down` removed both producer-access files, both SQLite spools, and every
  run-owned process/container. No bearer token, environment dump, raw log, or
  Parquet payload is retained in the OpenSpec evidence directory.

The first production attempt correctly failed because the pinned Maker smoke
fixture rejected the now-required `orderAuthor=executor_action_proof` field.
Maker PR 40 corrected that stale fixture expectation, its focused real
Hummingbot lifecycle passed, and both acceptance profiles were rerun against
the resulting merged Maker commit. No failed run is represented as release
evidence.

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

## Requirement ownership and references

- FIET-901 is covered by the four-feed independent collector and six canonical
  ClickHouse market tables, including provenance, checksums, loss handling, and
  optional broker archival startup.
- FIET-903 is covered by canonical order-book levels/summary/raw linkage and
  replay verification; the earlier broker RPC/capability sub-scope remains
  closed and backward-compatible.
- FIET-907 retains ownership of direct ClickHouse-to-Parquet fixture
  materialization. The broker-side exporter is retained only as its referenced
  compatibility tool and does not source CEX credentials.
- Maker PR 1067 compatibility is demonstrated by the immutable wire-fixture
  checksum, shared schema/provenance validation, `maker_replay` HTTP 200 direct
  insertion, and `hb_runtime` HTTP 202 durable ownership.

Cross-references are retained in the bounded JSON evidence for FIET-901,
FIET-903, FIET-907, Maker PR 1067, CEX Gitea PR 5, and Maker Gitea PRs 39/40.

Production soak was not performed and is not claimed. It is intentionally not a
completion requirement for this change.
