# Implementation Evidence

## Live-provider isolated-archive gate

The local gate passed on 2026-08-20 using the CryptoHFTData API key read from
Vault into the command process environment. The key was not written to the
evidence artifact, command arguments, logs, repository, or ClickHouse.

- Evidence schema: `market-data-vendor-backfill-local-smoke/v1`
- Evidence status: `passed`
- Evidence SHA-256: `2449263c342d12efad23c07ae6f0a5bb53eea7f0bd691cb6defa2ce5546eb5da`
- Secret-reflection scan: passed
- ClickHouse image: `clickhouse/clickhouse-server:24.8`
- ClickHouse image ID: `sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b`
- ClickHouse version: `24.8.14.39`
- Provider adapter: `cryptohftdata-orderbook/v2`
- Scope: OKX Spot `ARB-USDT`, `[1787045235308, 1787045295308)`, depth 20
- Vendor object: `okx_spot/2026-08-18/09/ARB-USDT_orderbook.parquet.zst`
- Vendor object SHA-256: `4d30de59fba095b39a60a0bf51ff002870af6a646ee6a795c54fcd3588c3362f`
- Vendor object size/rows: 646843 bytes / 68970 rows
- Capture bundle ID: `a668e29204cd7b295f44381b27c6f783b0e2f07ef60231241df12cfca4b64924`
- Promotion receipt ID: `42cab8f10cb944353a170e66b2c1e5c83e47216709cfca4e71835689a5d354d0`
- First invocation: `promoted` / `promotion_qualified`
- Second invocation: `already_covered` / `qualified_coverage_complete`
- Candidate/qualified rows: 40 levels and 1 summary in each view
- Promotion rows: 1
- Canonical export: 40 levels and 1 summary with the promotion receipt retained
- Coverage complete: true

The disposable archive was destroyed after the run. No licensed vendor payload
is retained in this change; only identities, counts, checksums, semantic
digests, and the passing receipt identity are recorded.

## Regression and specification verification

- Full Bun test suite: 805 passed, 0 failed.
- TypeScript build: passed.
- Strict OpenSpec validation: passed.
