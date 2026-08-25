# Deterministic verification evidence

Recorded on `2026-08-25` from branch `ed/famous-sails-battle-fxc0c` at baseline
commit `ae16314dabaf91f835a5af0ef6ff2344e8636356` plus this uncommitted
OpenSpec implementation.

## Repository and contract gates

- `bun install --frozen-lockfile`: passed.
- `bun test test`: 952 passed, 0 failed, 2,957 assertions across 99 files.
- `bun run build`: passed, including generated descriptor, TypeScript build,
  declarations, package copies, and Node package import/construction.
- `bunx tsc --noEmit`: passed.
- changed/untracked-file `bunx biome check`: 38 files checked, no fixes
  required.
- `openspec validate complete-maker-preparation-output-contract --strict`:
  passed.
- `git diff --check`: passed.

## Preparation product gates

- File-job, backfill command, exporter command, and package-boundary tests:
  passed, including no-follow reads, traversal/symlink/input-cap rejection,
  atomic durable result replacement, stale-success exclusion, current tuple
  rejection before dependency construction, read-only exporter construction,
  physical projection mismatch, and existing `cex-broker` bin compatibility.
- `node scripts/check-market-data-preparation-package.mjs`: passed for
  `@usherlabs/cex-broker@0.2.50`; final candidate tarball SHA-256 was
  `24a9f456825052786b8b31aa7f20d314038eeb6bdc89be65e4c375e0fead8856`.
  This is candidate evidence only and is not a registry product pin.
- Clean extraction exercised exactly the broker plus two preparation bins,
  verified twelve schemas, manifest v3, current policies, both product
  versions, executable self-hashes, baked git heads, no server imports, and no
  current runtime result-v1, previous-policy, or `fiet_tee_commit` identity.
- The package fixture's independent Python verifier reproduced result,
  receipt, selection, export, manifest, twelve schema, both policy, projection
  descriptor, and product-pin identities.

## Archive and exporter gates

- Exact-selection, archive-reader, and exporter tests passed for current
  receipts, historical-receipt exclusion and reverification, archive-wins
  overlap, conflicts, unselected rows, query identities, row counts, artifacts,
  physical projections, and atomic commit behavior.
- Live ClickHouse integration passed against the repository- and CI-pinned
  `clickhouse/clickhouse-server:24.8`: 14 passed, 0 failed, 95 assertions. The
  isolated test container was removed afterward.
- `scripts/archive-forwarder-image-smoke.sh`: passed and cleaned its test
  container.
- Archive-forwarder production-authorization, configuration, and client tests:
  14 passed, 0 failed, 32 assertions.

## Source-forensics and secret gates

- Forensics tests passed for streaming record and canonical-byte bounds,
  omission counts, non-throwing overflow, typed records, affected targets,
  re-anchors, changing bytes, stable corruption, row loss, boundary-order
  hypothesis, valid inactivity, deterministic replay, strict codecs, durable
  ledger-before-record commit, descriptor identities, and licensed-payload
  cleanup.
- Observer-disabled, observer-enabled, and throwing-observer reconstruction
  returned identical production outputs.
- Planted credentials and reflected response text were absent from results,
  receipts, diagnostics, ledgers, qualification records, logs retained by the
  tests, package assets, and current runtime bundles.

## Operational gates intentionally not claimed

Tasks 8.1 through 8.11 require a licensed provider credential, production
ClickHouse and archive-forwarder authority, a frozen common pair window,
successful two-pair qualification, successor publication, independent registry
download, and Maker repository/loader coordination. This worktree has
`CRYPTOHFTDATA_API_KEY`, `CLICKHOUSE_URL`,
`CEX_BROKER_ARCHIVE_FORWARDER_URL`, and
`CEX_BROKER_ARCHIVE_FORWARDER_TOKEN` unset. No production qualification,
publication, final product pin, or Maker acceptance is asserted.
