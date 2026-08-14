# Candidate integration evidence

- Candidate: `3398066ae2c396a9a9e0220f88715ac22b6d8694`
- Pre-upgrade `develop`: `7a83de5f29a08f42d81f64a75a83bc9318dce94a` (`0.2.38`)
- Post-upgrade input: `27495d1a45913dd65a3003cd965a8f460f567a90`
- ClickHouse Local E2E input: `0223f09d3c623c1594cbbf6778a7b24fab38f639`
- `develop` merge: `809a873`
- E2E merge: `9b16261`

`git merge-base --is-ancestor` returned success for all three input commits
against the candidate. The reviewed range-diff retained the original canonical
archive, credential-policy removal, remote collector, architecture, proposal,
and amendment commits; added the E2E planning/implementation/sync commits; and
added candidate implementation commit `3398066`. The Binance normalization,
subscription archive, and `0.2.38` release commits disappear only from the topic
range because they are already ancestors of the merged `develop` baseline.

Conflict reconciliation retained Bun `1.3.12`, the real ClickHouse Server 24.8
unit/integration service, normal repository checks, the serialized pinned Local
E2E gate, the Python checksum fixture, strict current OpenSpec validation, and
the package build. The fixed A/B upgrade acceptance remains outside recurring
CI. `MarketDataCollector` is the canonical E2E type; `OhlcvCollector` remains a
compatibility alias only. No credential profile/policy/attestation or runtime
archive write-mode configuration was reintroduced.

The clean one-time A/B result for this candidate is recorded in
`archive-upgrade-ab-acceptance.json` in this directory.
