# Implementation evidence

## Released CEX boundary

The durable Maker acceptance boundary shipped through
[usherlabs/cex-broker#99](https://github.com/usherlabs/cex-broker/pull/99).

| Evidence | Immutable reference |
|---|---|
| Reviewed CEX change commit | `1bd2af1ef7ec7d4fc9d223cdcc9211c57d600526` |
| CEX merge commit | `5eec63dfcd947aae3b0f861d39cf96e05339cd0c` |
| Release | `v0.2.37`, dereferencing to the merge commit |
| npm integrity | `sha512-e4Cq665s3Be2E6QMADWLzIvXgj3Vd/PmLOrOCtkngCt3FjKdgE4SmHqoRDhMz2/reSv2ttfePclHVqG05s1CeA==` |
| Archive-forwarder image | `ghcr.io/usherlabs/cex-broker-archive-forwarder:0.2.37@sha256:713068ff7bc7b75640ea990baa68c317876d8efdd3f312cfa38b37a799eb8a44` |
| Core broker image | `ghcr.io/usherlabs/cex-broker:0.2.37@sha256:cbc959948f9b6caed2759ca40f3716af2354b12814078368aba73d22c14577b3` |
| Pinned Maker producer commit | `563594435853c88cca5b187b8c999f845e31136b` |
| Shared fixture SHA-256 | `784f647e048052a6c3382309b1a86abfbe08bc162363ead9fc88eaa1ba3d50c9` |

Required CEX evidence passed:

- [PR CI](https://github.com/usherlabs/cex-broker/actions/runs/30792787681)
  used ClickHouse 24.8 and passed contract, SQLite durability/fault/restart,
  legacy upgrade, all-five-table schema-v2, and stable-token deduplication
  coverage;
- [post-merge CI](https://github.com/usherlabs/cex-broker/actions/runs/30792875090)
  passed;
- [package and core-image publication](https://github.com/usherlabs/cex-broker/actions/runs/30792910567)
  passed; and
- [archive-forwarder image publication](https://github.com/usherlabs/cex-broker/actions/runs/30792910562)
  passed.

Local verification before release recorded 593 repository tests passing with no
failures, 48 focused forwarder tests, 12 real ClickHouse integration tests,
type-check, build, lint, Compose validation, strict OpenSpec validation, and a
clean diff check.

## Maker consumer closure

Maker consumed the release through
[usherlabs/fiet-maker#1067](https://github.com/usherlabs/fiet-maker/pull/1067).
The dependency/evidence commit is
`f84ebf3291a7b0060b9d90c44ea785d9ad6ea820`; the merge commit is
`1ae1d0faf87396a35089ec51eedc55ff65d675d9`.

Maker's production build authority is its parent `pnpm-workspace.yaml` and root
`pnpm-lock.yaml`. They pin the workspace's wrapper resolution to exact
`@usherlabs/cex-broker@0.2.37` and the npm integrity above. The separately
versioned fiet-tee submodule manifest and lock remain standalone repository
release inputs; they do not override the parent production workspace pin.

The installed wrapper passed 18 tests, the SGX archive-storage path contract,
and the CommonJS production bundle check against `0.2.37`. Maker strict
OpenSpec validation passed, all 64 tasks in
`complete-nonblocking-strategy-replay-archive` are complete, and the shared
fixture hash is identical. Maker post-merge advisory evidence is
[run 30793571785](https://github.com/usherlabs/fiet-maker/actions/runs/30793571785);
the production-context CEX SGX staging build is
[run 30793571854](https://github.com/usherlabs/fiet-maker/actions/runs/30793571854).
Both runs passed.

## Linear scope transition

- [FIET-901](https://linear.app/usherlabs/issue/FIET-901/read-broker-cex-market-data-into-clickhouse)
  records the released implementation, same-full-broker deployment model,
  credential precedence, absence of credential profiles/attestation knobs, and
  the FIET-937/FIET-907 handoff while remaining open/In Review.
- [FIET-903](https://linear.app/usherlabs/issue/FIET-903/canonical-cex-order-book-depth-tables-for-strategy-runtime-replay)
  records the already-complete RPC/capability sub-scope, released storage
  sub-scope, sampled-mode closure, and future-facing exact-L2 guardrail while
  remaining open/In Review.
- [FIET-909](https://linear.app/usherlabs/issue/FIET-909/hb-runtime-telemetry-bridge-for-strategy-replay-sourcing)
  records the Maker/CEX conformance release and immutable evidence.
- [FIET-937](https://linear.app/usherlabs/issue/FIET-937/production-cex-market-data-archive-into-clickhouse-for-strategy-replay)
  retains the production observation window and go/no-go cutover decision.
- [FIET-924](https://linear.app/usherlabs/issue/FIET-924/review-and-implementation-of-data-warehouse-ingestion-packagetemplate)
  remains Done and was not reopened or repurposed.

## Ownership result

- Maker makes exactly one bounded HTTP attempt per admitted strategy batch.
- HTTP 202 means the complete batch is durably owned by the forwarder's fixed
  1 GiB, 72-hour SQLite spool.
- Retry, restart recovery, per-table completion, expiry, and ClickHouse
  deduplication belong to the forwarder after acceptance.
- Broker-origin traffic keeps its existing direct synchronous path.
- No new core full-broker `CEX_BROKER_*` environment variable was introduced;
  only forwarder-local `ARCHIVE_FORWARDER_SPOOL_PATH` selects the durable file.
- Production observation remains a deployment/cutover gate owned by FIET-937,
  not an OpenSpec implementation or archive prerequisite.
- Parquet materialization remains an out-of-band ClickHouse consumer owned by
  FIET-907.
