# Archive upgrade acceptance and Maker sidecar

This runbook covers two bounded test/operator compositions. Neither is a
production CEX Broker service and neither introduces a core broker environment
variable.

## One-time canonical upgrade A/B

The upgrade acceptance proves this specific release transition. Its A-side is
the immutable export from authoritative CEX Broker `develop` commit
`7a83de5f29a08f42d81f64a75a83bc9318dce94a` (package `0.2.38`). Its B-side is the
committed candidate checked out in this repository.

Verify the committed baseline and then run the real Server 24.8 acceptance from
a clean final candidate:

```sh
bun run archive:baseline:verify
bun run test:acceptance:archive-upgrade
```

Both servers start from the same pre-upgrade DDL/data. The command keeps A
immutable, applies the production schema initializer to B, runs
`migrate-legacy-market-data-to-canonical.ts` in confirmed write mode twice over
the fixture-derived `[start_time_ms, end_time_ms)` window, binds that same window
to cutover/parity SQL, and then sends upgraded four-feed capture through the
normal gRPC broker, collector, HTTP forwarder, and `@clickhouse/client` path.

Success writes
`openspec/changes/archive-upgrade-ab-maker-sidecar-e2e/evidence/archive-upgrade-ab-acceptance.json`
and removes the run-owned containers. Failure writes the adjacent
`.failure.json`, stops but retains the named A/B containers for diagnosis, and
returns non-zero. The fixed acceptance is release evidence for this upgrade and
is not part of ordinary CI; the pinned Local lifecycle remains the standard E2E
gate.

## CEX-owned Maker conformance sidecar

The sidecar gives an external FIET Maker job a closed non-interactive lifecycle:

```sh
bun run archive:sidecar -- up \
  --run-id "$RUN_ID" \
  --profile native_replay \
  --candidate-sha "$CEX_SHA" \
  --maker-sha "$MAKER_SHA" \
  --artifacts-dir "$ARTIFACTS_DIR"

bun run archive:sidecar -- ready --manifest "$ARTIFACTS_DIR/$RUN_ID/manifest.json"
bun run archive:sidecar -- verify --manifest "$ARTIFACTS_DIR/$RUN_ID/manifest.json"
bun run archive:sidecar -- down --manifest "$ARTIFACTS_DIR/$RUN_ID/manifest.json"
```

`up` requires a clean checkout whose CEX commit equals the full candidate SHA. The
profile is exactly `native_replay` or `production_compatible`; Maker supplies its
resolved full `develop` SHA. `ready` accepts `--timeout-ms` and defaults to
120000. Exit code 0 is success, 1 is lifecycle/readiness/conformance failure, and
2 is an invalid invocation or manifest. Always invoke `down` from a trap/finally
block; it is idempotent and targets only the manifest's run-owned supervisor,
container, and SQLite files.

The composition runs ClickHouse Server 24.8, the production archive-forwarder
with a unique durable spool, a controlled credentialless exchange behind the
normal gRPC broker wiring, and the independent `MarketDataCollector` as a broker
client. Readiness checks schema/ClickHouse health, spool writability, broker
startup, and all four collector subscriptions. The collector is not the Maker
client and owns no credentials or ClickHouse connection.

- `native_replay` submits all five strategy tables as `maker_replay`, requires
  synchronous HTTP 200 with unchanged spool state, validates the canonical
  four-feed window, and creates conflict-checked Parquet through the retained
  direct-ClickHouse FIET-907 reference exporter.
- `production_compatible` submits all five strategy tables as `hb_runtime`,
  requires durable HTTP 202, waits for an empty/non-terminal spool, and queries
  the persisted v2 producer/run/stream identities.

The manifest and verification JSON use a closed field allowlist. They record
run/profile identity, immutable CEX/Maker commits, deployment/capture identities,
non-secret endpoints, tool/schema/checksum versions, delivery outcomes, and
artifact hashes. They never serialize the process environment, test auth token,
CEX credentials, or credential-bearing payloads. Supervisor logs remain bounded
diagnostics and are not conformance evidence on their own.

Parquet production remains outside capture. The reference exporter queries
ClickHouse directly solely to prove FIET-907 compatibility; fixture coverage,
bundle construction, and Maker-specific Parquet extensions belong to FIET-907
and FIET Maker.
