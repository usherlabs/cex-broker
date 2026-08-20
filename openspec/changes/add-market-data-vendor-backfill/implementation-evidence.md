# Implementation Evidence

## Live-provider isolated-archive gate

The local gate passed on 2026-08-20 using the CryptoHFTData API key read from
Vault into the command process environment. The key was not written to the
evidence artifact, command arguments, logs, repository, or ClickHouse.

- Evidence schema: `market-data-vendor-backfill-local-smoke/v1`
- Evidence status: `passed`
- Evidence SHA-256: `e73eedb8aadcd8189b97ba633f291e0755f8258f4935b32f072dc263c8cd4ac2`
- Secret-reflection scan: passed
- Source commit: `5580915edf82e9dc211265f3b3dbcf601ccacc5a` (working tree dirty with this change)
- Package version: `0.2.46`
- ClickHouse image: `clickhouse/clickhouse-server:24.8`
- ClickHouse image ID: `sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b`
- ClickHouse version: `24.8.14.39`
- Schema manifest SHA-256: `48e5e91d33caafd930b45552c799a9fb0c2ccd9a676106fbab2543f231dba1b7`
- Capability policy SHA-256: `51f522286ad24ec55525c19cad5c2c37043f9325a5a8f20d838adb7fd71191bf`
- Resource policy SHA-256: `38d4f47cbd15794efed570801556a95f724561a8b45567d518c044da9d454142`
- Adapter policy SHA-256: `b71eec2948593eb3f9f43371a23ec6a37fd186177c6e368f7f792113e907a737`
- Acquisition policy SHA-256: `dd3b94d6fdeed161580735673913e3483dada4725ee4fb7add461b74e20713d5`
- Provider adapter: `cryptohftdata-orderbook/v2`
- Scope: OKX Spot `ARB-USDT`, `[1787045235308, 1787045295308)`, depth 20
- Vendor object: `okx_spot/2026-08-18/09/ARB-USDT_orderbook.parquet.zst`
- Vendor object SHA-256: `4d30de59fba095b39a60a0bf51ff002870af6a646ee6a795c54fcd3588c3362f`
- Vendor object size/rows: 646843 bytes / 68970 rows
- Vendor semantic digest: `ff4e9ad85e1b1857bb6ee781d5aea95b84a12203400c3d4ff732369500787b17`
- Capture bundle ID: `84ef9def3099545be059a96d902cc02079833318637b9b7033fb169e3d9d3f5a`
- Promotion receipt ID: `35c1019fd8caf16e8f3fb3630b86884f6564c63d7e8424912650d5196872a4e1`
- Canonical semantic digest: `e393a453dbf5f365bfc055f1f008528d24409be61e76c21feba5361cafed7298`
- First invocation: `promoted` / `promotion_qualified`
- Second invocation: `already_covered` / `qualified_coverage_complete`
- Candidate/qualified rows: 40 levels and 1 summary in each view
- Promotion rows: 1
- Canonical export: 40 levels and 1 summary with the promotion receipt retained
- Qualified coverage digest: `d1ce7e0d52f8bece8050fdb67c229d72902f718682c895e96cf39fbdb201c3d7`
- Canonical level export SHA-256: `004dc20c89804be7e92b7cb2c14996e70f5063098aa1a4e20439ca58a000ca36`
- Canonical summary export SHA-256: `edfa01a982d365165f2c55af2aaa2145e8d44947b7e5ead85a4249d8562f9d24`
- Coverage complete: true

The disposable archive was destroyed after the run. No licensed vendor payload
is retained in this change; only identities, counts, checksums, semantic
digests, and the passing receipt identity are recorded.

## Regression and specification verification

- Full Bun test suite: 850 passed, 0 failed across 88 files.
- TypeScript `--noEmit`, declaration build, package build, and Node package construction smoke: passed.
- Biome check of all changed TypeScript and JSON files: passed (29 files).
- ClickHouse Local archive E2E: 18 passed, 0 failed.
- Fresh ClickHouse Server 24.8 schema/reader integration: 14 passed, 0 failed.
- Protected provider conformance: passed with exactly the single pinned OKX object recorded above.
- Protected final-v1 promotion/idempotency smoke: passed; the disposable archive was removed and the evidence artifact remained mode `0600` outside the repository.
- Strict OpenSpec validation: passed.
- npm tarball: `@usherlabs/cex-broker@0.2.46`, 119 entries, 8,862,803 bytes, SHA-256 `d0f66e3eaf2556dc57cce71e3140a96c3baaf4d080bfb2eb7b91084b930f42e0`.
- Tarball audit: all schemas, policies, fixtures, JavaScript, and declarations are present; the product subpath imports with installed dependencies and contains no server/handler imports.

## Remaining release prerequisite

The CEX implementation and final-v1 gates are complete, but this change must
not be archived or published yet. Fiet TEE must first pin this package and its
artifact identities, build and hash the standalone executable, and pass the
shared conformance suite. Fiet Maker must then pin the Fiet TEE commit and
executable and pass its independent archive/consumer validation. Production
dispatch remains disabled until those downstream pins and gates are recorded.
