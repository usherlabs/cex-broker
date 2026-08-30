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

## CEX-owned Maker shared-wire sidecar

The sidecar gives an external FIET Maker development-conformance job a closed,
non-interactive lifecycle. It supports only the `production_compatible` profile:

```sh
bun run archive:sidecar -- up \
  --run-id "$RUN_ID" \
  --profile production_compatible \
  --candidate-sha "$CEX_SHA" \
  --maker-sha "$MAKER_SHA" \
  --artifacts-dir "$ARTIFACTS_DIR"

bun run archive:sidecar -- ready --manifest "$ARTIFACTS_DIR/$RUN_ID/manifest.json"
bun run archive:sidecar -- verify --manifest "$ARTIFACTS_DIR/$RUN_ID/manifest.json"
bun run archive:sidecar -- down --manifest "$ARTIFACTS_DIR/$RUN_ID/manifest.json"
```

`up` requires a clean checkout whose CEX commit equals the supplied full SHA;
Maker supplies its resolved clean `develop` SHA. `ready` accepts
`--timeout-ms` and defaults to 120000. Exit code 0 is success, 1 is a
lifecycle/readiness/conformance failure, and 2 is an invalid invocation or v2
manifest. Invoke `down` from a trap/finally block. Shutdown is bounded,
idempotent, and removes only the manifest-owned supervisor, container, SQLite
spool files, and ephemeral producer-access file.

`native_replay` is unsupported. The removed `prepare|execute|cleanup` command
family, native results, reference exports, replay validation, historical
loaders, and Parquet artifacts are not sidecar surfaces. V1 manifests and Maker
results are rejected rather than upgraded or inferred.

### What Proof C exercises

The composition runs ClickHouse Server 24.8, the production archive-forwarder
with a unique durable spool, and a deterministic credential-free controlled
venue through the production broker handlers, acquisition-profile resolver,
public-feed supervisor, independent `MarketDataCollector`, and normal gRPC
wiring. “Real broker” means these production code paths; no public exchange or
production credential is needed.

The v2 manifest exposes bounded loopback identities and endpoints plus the
content-bound shared-wire fixture/test identity. Ephemeral authorization is in a
mode-0600 `producerAccessPath`, never copied into retained evidence, and removed
by `down`.

The external Maker job must:

1. request current ORDERBOOK depth and subscribe to live ORDERBOOK through the
   manifest's broker endpoint;
2. share that controlled physical feed with the collector, leaving one physical
   worker and no more than one archive decision per physical frame;
3. submit an `hb_runtime` ArchiveEmitter batch to the production forwarder;
4. observe HTTP 202 after durable spool admission and wait for the spool to
   drain; and
5. write a v2 Maker result identifying the accepted batch and exact bounded
   `archive_event_id` values expected in each of the five strategy tables.

`verify` binds the Maker result to the v2 manifest, resolved CEX and Maker
commits, deployment, capture bundle, producer, run, batch, timestamps, and
shared-wire fixture hash. It then checks the live Layer12 current/subscription
observations, feed-sharing and archive-decision cardinality, controlled market
capture, durable 202/spool drainage, and exact expected row identities in:

- `strategy_data.policy_evaluation_events`
- `strategy_data.strategy_policy_snapshots`
- `strategy_data.market_identity`
- `strategy_data.symbol_mapping`
- `strategy_data.inventory_settlement_events`

A successful `cex-maker-sidecar-proof-c/v2` is sufficient for sidecar success.
The sidecar does not aggregate the CEX-local feed/coalescing regression or
Maker-owned policy-equivalence tests, and it does not prove summary-v2 hot-reader
parity, historical reconstruction, public-exchange fidelity, retention, or a
production soak. Those remain independent owner-local or fixture/query gates.

The v2 manifest and verification result use closed field sets and bounded row
and time evidence. They contain no environment dump, token, password, private
endpoint, historical product descriptor, policy decision, or unbounded payload.
A public-network market smoke, when run, must be separately named, optional,
non-gating, and excluded from Proof C evidence.
