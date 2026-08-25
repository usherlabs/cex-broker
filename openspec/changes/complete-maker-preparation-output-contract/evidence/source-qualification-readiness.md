# Source Qualification Readiness — 2026-08-25

## Current gate

The deterministic implementation is green, but the two-pair source and release
gate remains blocked. No successful source qualification, promotion, export,
publication, or Maker consumer result is claimed here.

The frozen candidate remains the 24-complete-UTC-day half-open window
`[2026-07-26T00:00:00Z, 2026-08-19T00:00:00Z)`:

| Pair | Required targets | Required-clock SHA-256 |
| --- | ---: | --- |
| ARB-USDC | 2,808 | `de6f9c589a08358978d442601b28bec9af6a3c2c84427007762d499a7a1b4d48` |
| ARB-USDT | 932 | `646e252907ebc1d3d2cd6dab2984982503588955b748a0b14fa1ea788a23a538` |

The corresponding required-clock sidecar bytes and clock IDs are not retained
in this worktree or the Maker worktree. Hashes and counts alone cannot safely
reconstruct the clocks. Maker must provide or deterministically regenerate the
two immutable sidecars before CEX can execute task 8.2.

The last retained source verdict for this exact candidate remains failed:

- ARB-USDC: 832 failed targets, including 549 unanchored targets and 20
  sequence gaps;
- ARB-USDT: one stale target with 107,794 ms lag;
- future-state targets: zero;
- the strict prior-as-of ceiling remains 5,000 ms.

## Repository qualification harness

`scripts/market-data-source-qualification.ts` is a repository-only,
explicitly enabled harness. It injects the bounded observer into the same
current OKX adapter used by the backfill path and commits:

1. `<pair>-source-forensics.json`; then
2. `<pair>-source-qualification.json`.

It does not add an npm bin or Maker request field. A source acquisition failure
is now an explicit input to qualification finalization, so an empty or otherwise
clean ledger cannot be marked qualified after the adapter throws.

Expected invocation after Maker supplies a matching request and clock:

```bash
MARKET_DATA_SOURCE_QUALIFICATION_ENABLED=1 \
CRYPTOHFTDATA_API_KEY="$(vault kv get -field=CRYPTOHFTDATA_API_KEY kv/secrets)" \
bun run qualification:market-data-source run \
  --request <pair-request.json> \
  --clock <pair-required-clock.json> \
  --output-directory <new-non-symlink-output-directory>
```

Every output directory must be new because qualification evidence is written
exclusively and is never overwritten.

## Vault-backed readiness

Vault was reachable and unsealed. This session used named field checks and
read-only credential injection; no values were printed or persisted.

Available fields on `kv/secrets`:

- `CRYPTOHFTDATA_API_KEY`
- `CLICKHOUSE_URL`
- `CLICKHOUSE_USER`
- `CLICKHOUSE_PASSWORD`

Missing fields required by later final tasks:

- `CEX_BROKER_ARCHIVE_FORWARDER_URL`
- `CEX_BROKER_ARCHIVE_FORWARDER_TOKEN`
- an npm publication token (`NPM_TOKEN`, `NODE_AUTH_TOKEN`, or the deployment's
  approved equivalent)

No placeholder or empty secret was written. The active Vault token has broader
capabilities than this work requires; this session deliberately performed
named reads only.

The Vault-backed qualified-archive read returned deployment identity
`production/cex-archive-primary`. Both
`market_data.cex_order_book_levels_replay_qualified` and
`market_data.cex_order_book_depth_summary_replay_qualified` returned zero rows
for OKX ARB-USDT and ARB-USDC, so ClickHouse cannot currently satisfy either
pair without provider acquisition.

## Verification

- targeted RED was observed for the missing harness and for a false-positive
  qualification after source failure;
- targeted GREEN: 16 tests, 0 failures, 45 expectations;
- repository suite: 955 tests, 0 failures, 2,969 expectations, 100 files;
- TypeScript: passed;
- changed-file Biome and `git diff --check`: passed;
- build and Node package import/construction: passed;
- strict OpenSpec validation: passed;
- local package audit: passed with candidate tarball SHA-256
  `de4d500c02ff48e743e16a3178cda0e7aa5ce98b44abba2e6c0d1207c29dbc00`.

The local tarball hash is diagnostic only and is not registry release evidence.

## Remaining sequence

1. Maker supplies or regenerates the exact two pair-local clock sidecars and
   matching current request documents.
2. CEX runs both full-window qualifications and retains the pair ledgers and
   qualification records.
3. CEX classifies every retained failure. The unchanged source gate must pass
   before promotion, export, version selection, or publication.
4. An operator provisions the scoped archive-forwarder and npm publication
   credentials in Vault.
5. Only after both source gates pass may CEX run production `fill_gaps`, exact
   export, publication/audit, product-pin generation, and Maker consumption.
