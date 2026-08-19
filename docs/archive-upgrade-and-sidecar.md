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

The sidecar does not fabricate or submit Maker strategy rows. Before readiness,
the manifest publishes the loopback `brokerUrl`, `producerAccessPath`,
`makerResultPath`, `referenceExportPath`, and the run-owned
`cexEvidencePath`. The latter is freshly generated deterministic CEX Proof A
(`cex-orderbook-coalescing-evidence/v1`) for Binance and MEXC. The
producer-access file is mode
0600, contains the ephemeral loopback producer bearer, is consumed only by the
external Maker job, and is deleted by `down`; its contents never enter retained
evidence. For native replay, readiness also writes the conflict-checked,
checksum-bound direct-ClickHouse export so Maker can consume it before
verification.

- `native_replay`: external Maker adapts the CEX export to its FIET-907 fixture
  schema, submits all five strategy tables as `maker_replay`, and reports
  synchronous HTTP 200 with unchanged spool state and no broker participation.
- `production_compatible`: real Maker/Hummingbot selects `layer12_live`, makes
  an external gRPC ORDERBOOK subscription distinct from the collector, invokes
  the Layer 12 reference-depth snapshot path through the normal broker action
  surface, submits all five strategy tables through its `ArchiveEmitter` as
  `hb_runtime`, and reports observed HTTP 202 plus eventual spool drainage. Its
  Maker-authored result must provide
  `profileEvidence.immediateHedgeability` as a
  `fiet-maker-immediate-hedgeability-attachment/v1` descriptor. Its run-owned
  file is Maker Proof B (`fiet-maker-immediate-hedgeability/v2`) with exactly
  one Binance and MEXC case, four isolated Layer 12 streams per evaluation,
  policy/evaluation hashes, and `sourceCexEvidence.sha256` equal to the exact
  current Proof A file. Maker Proof B owns cap, width, authored position,
  limiting-side, and rebalance equivalence. It must not copy logical delivery,
  physical watch/archive, broker payload equality, or canonical archive
  equality fields.

`verify` reads the Maker-owned result, binds it to the manifest, requires the
exact producer id `<source>:<deployment>:cex-sidecar-conformance`, resolves the
Proof B attachment without allowing path traversal or symlink escape,
recomputes its hash, validates the v2 policy evidence, and binds it to freshly
recomputed canonical Proof A bytes. It separately derives CEX-local Proof C,
then queries all market and strategy tables. A stale/synthetic Proof A binding,
copied CEX-owned field, result created by the CEX supervisor, or another
producer cannot qualify. Passing Proof A/B/C does not activate a candidate;
that is reserved for `activate-binance-mexc-coalesced-orderbook-profiles`.

The manifest and verification JSON use a closed field allowlist. They record
run/profile identity, immutable CEX/Maker commits, the reviewed archive
implementation ancestor, deployment/capture identities,
non-secret endpoints, tool/schema/checksum versions, delivery outcomes, and
artifact hashes. They never serialize the process environment, test auth token,
CEX credentials, or credential-bearing payloads. Supervisor logs remain bounded
diagnostics and are not conformance evidence on their own.

Parquet production remains outside capture. The reference exporter queries
ClickHouse directly solely to prove FIET-907 compatibility; fixture coverage,
bundle construction, and Maker-specific Parquet extensions belong to FIET-907
and FIET Maker.
