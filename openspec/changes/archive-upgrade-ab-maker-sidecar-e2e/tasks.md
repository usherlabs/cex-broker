## 1. Pin Baselines and Integrate Branches

- [x] 1.1 Resolve CEX Broker `develop` from the authoritative Gitea and GitHub remotes, confirm the refs agree, and record the resolved pre-upgrade commit plus matching `package.json` version (proposal-time expectation `7a83de5f29a08f42d81f64a75a83bc9318dce94a`, version `0.2.38`).
- [x] 1.2 Add a baseline-generation command that rejects dirty/non-`develop` source checkouts and exports pre-upgrade DDL, deterministic data, projections, ordering, package/tool versions, and SHA-256 provenance.
- [x] 1.3 Generate and review the immutable `develop` A/B fixture without replacing the retained `64fdf0607a234be05bac98f3edd3125e2c05d083` historical compatibility fixture.
- [x] 1.4 Add a fixture verification command that reproduces the `develop` export semantically, checks every recorded hash, and fails on an implicit expectation update.
- [x] 1.5 Integrate current `develop`, `ed/cute-taxes-cheat-jnrod`, and `ed/clickhouse-local-e2e-5medm` into one candidate while preserving released `develop` fixes and intentional post-upgrade contracts.
- [ ] 1.6 Reconcile `.github/workflows/ci.yml`, package version/scripts, collector naming, archive request paths, schema manifests, OpenSpec state, and documentation conflicts; record the resulting candidate commit and reviewed range-diffs.

## 2. Implement the Two-Source Strategy Contract

- [x] 2.1 Extend strategy classification so only `hb_runtime` and `maker_replay` may target the five approved strategy tables, and reject reserved-source non-strategy or mixed batches before ownership.
- [x] 2.2 Reuse the common legacy/v1/v2 schema, row/envelope provenance, UInt64 identity, row-count, and table-limit validation for both accepted strategy sources.
- [x] 2.3 Preserve `hb_runtime` durable SQLite admission, HTTP 202, quota/unavailable errors, isolated per-table drainage, and stable ClickHouse deduplication tokens.
- [x] 2.4 Route valid `maker_replay` batches through synchronous direct ClickHouse insertion, returning HTTP 200 only on success and HTTP 500 on failure without touching spool accounting.
- [x] 2.5 Add request/contract tests covering all five tables, both valid sources, mixed/non-strategy reserved-source rejection, unsupported sources, provenance mismatch, missing v2 identity, replay failure, and no replay-to-runtime source rewriting.
- [x] 2.6 Add bounded replay batch/row success and insertion-failure telemetry while proving existing admission/spool/drain metrics remain `hb_runtime`-only and unchanged by replay.
- [x] 2.7 Add durable-acceptance tests proving `maker_replay` never returns HTTP 202 or creates spool bytes, batches, work, retry, deduplication, terminal, or expiry state.

## 3. Reconcile and Complete the ClickHouse Local Lifecycle

- [x] 3.1 Import the pinned ClickHouse Local binary/bootstrap, persistent-path harness, archive lifecycle support, historical fixtures, smoke runner, and archive E2E command from the E2E branch.
- [x] 3.2 Adapt the lifecycle to import and type against `MarketDataCollector`, while retaining `OhlcvCollector` only as a compatibility value alias outside the canonical test contract.
- [x] 3.3 Prove the controlled ORDERBOOK, TICKER, TRADES, and OHLCV frames traverse normal gRPC wiring, `MarketDataCollector`, the writer queue/HTTP transport, production forwarder handler/router, and Local storage adapter with explicit barriers.
- [x] 3.4 Provision a unique real SQLite spool and worker for Local `hb_runtime` fixtures, assert HTTP 202 at admission, and wait for explicit per-table completion before querying ClickHouse.
- [x] 3.5 Add composed restart-recovery and isolated-table-retry cases that prove stable strategy deduplication and no completed-sibling reinsert.
- [x] 3.6 Add Local `maker_replay` fixtures that prove synchronous HTTP 200/500 behavior and unchanged spool counts.
- [x] 3.7 Restore the explicit 15-table historical inventory; test the ten market/execution/account tables through synchronous HTTP 200 and the five `hb_runtime` strategy tables through HTTP 202, spool drain, and exact query comparison.
- [x] 3.8 Restore the exact harness environment, canonical table/view names, order-book logical keys, and audit prohibiting all five removed configuration variables and equivalent policy/profile/attestation/write-mode objects.
- [x] 3.9 Retain canonical raw linkage, provenance, checksum recomputation, duplicate/conflict views, blocked-sink delivery, retry recovery, and exact loss records shaped as `{ timestamp, source, deployment_id, reason, payload }`, including `shutdown_forwarder_failure` and composed `queue_shed`.
- [x] 3.10 Align the Python canonical projection with TypeScript decimal normalization/field order and require all Python fixture tests to pass with the committed data.
- [x] 3.11 Run the pinned Local suite twice from clean temporary state and verify deterministic cleanup, offline fixture use, and failure on missing binary/schema/tests.

## 4. Produce the One-Time Real ClickHouse 24.8 A/B Upgrade Acceptance

- [x] 4.1 Add `bun run test:acceptance:archive-upgrade` with run-isolated ClickHouse Server 24.8 A and B lifecycle support, explicit readiness, unique endpoints, bounded diagnostics, and idempotent cleanup.
- [x] 4.2 Initialize both servers from the same committed `develop` DDL/data fixture and fail before upgrade unless table inventories, DDL hashes, exact projections, and cardinalities match.
- [x] 4.3 Keep A immutable and apply the production current schema manifest to B through the same initializer used by deployed archive-forwarder instances.
- [x] 4.4 Derive `[start_time_ms, end_time_ms)` from the fixture's minimum legacy source time and maximum plus one, then run the migration against B with `CEX_BROKER_CANONICAL_MIGRATION_CONFIRM=true` and the exact bounded window.
- [x] 4.5 Parse the migration summary and fail unless it reports `mode=write`, expected non-zero legacy book/candle counts, and the expected non-zero canonical row count; bind the identical window to every cutover SQL phase/parity query.
- [x] 4.6 Re-run schema initialization and the confirmed migration on B and assert stable canonical logical counts, checksums, source modes, conflict results, and legacy projections.
- [x] 4.7 Compare every B legacy projection/cardinality with unchanged A and report the exact table/stable key for any missing, changed, or duplicate legacy value.
- [x] 4.8 Verify migrated canonical rows use `legacy_migration_v1`, `provenance_complete=0`, and honest null bundle/raw/checksum provenance without synthetic capture identity.
- [x] 4.9 Assert zero parameter-bound production parity mismatches, empty deterministic order-book conflict views, and stable canonical/closed views before candidate writes are released.
- [x] 4.10 Start the upgraded deterministic broker and independent collector against B through the production forwarder and `@clickhouse/client`, then prove linked four-feed canonical output and zero new legacy ORDERBOOK/OHLCV rows.
- [x] 4.11 Recheck A immutability and B historical parity after upgraded writes, and retain non-destructive failure artifacts without dropping either dataset.
- [ ] 4.12 Execute the complete A/B command once against the final candidate and retain its commits, versions, invocation, fixture/query hashes, migration summaries, and assertion results as acceptance evidence rather than adding it to ordinary CI.

## 5. Build the CEX-Owned Conformance Sidecar

- [x] 5.1 Add `bun run archive:sidecar -- <up|ready|verify|down>` with the specified `up` flags, `--manifest` for later operations, optional `ready --timeout-ms` defaulting to 120000, fixed artifact paths, and exit codes 0/1/2.
- [x] 5.2 Compose ClickHouse Server 24.8, production archive-forwarder with unique SQLite spool, deterministic broker fixture using normal gRPC wiring, and the independent collector service entrypoint.
- [x] 5.3 Implement readiness for broker gRPC, ClickHouse schemas, forwarder health, spool writability, and collector subscriptions, returning exit code 1 with bounded diagnostics on timeout.
- [x] 5.4 Implement bounded idempotent shutdown that removes only run-owned processes, containers, ports, spool, and temporary database state while retaining selected evidence.
- [x] 5.5 Emit a whitelisted JSON manifest containing run/profile identity, resolved commits, non-secret endpoints, schema/checksum/tool versions, migration/spool outcomes, commands, and artifact hashes.
- [x] 5.6 Add manifest validation and redaction tests proving missing required identity fails and tokens, CEX credentials, raw environments, and credential-bearing payloads cannot enter evidence.
- [x] 5.7 Prove the sidecar uses production handlers/clients and controlled credentialless exchange data, and add a guard test showing normal broker startup still succeeds with archival configuration absent.

## 6. Prove Both FIET Maker Profiles

- [x] 6.1 Retain and document the direct-ClickHouse Parquet reference exporter as a FIET-907 compatibility tool, with no inline broker/forwarder materialization or exchange credential dependency.
- [x] 6.2 Add a native replay sidecar scenario that selects a bounded conflict-free canonical window, verifies export checksums/schema, and accepts Maker strategy evidence only as synchronous `maker_replay`.
- [x] 6.3 Add a production-compatible sidecar scenario that distinguishes the Maker Layer 12 broker client from the collector, admits strategy evidence only as durable `hb_runtime`, drains it, and queries all required market/strategy rows.
- [x] 6.4 Make sidecar verification reject native evidence that claims direct broker or `hb_runtime` behavior and live evidence that lacks HTTP 202 admission plus completed drainage/query proof.
- [ ] 6.5 In FIET Maker, resolve a clean `develop` checkout to its execution-time immutable commit, verify the PR 1067 wire contract is present, and add Maker-owned orchestration for the pinned CEX sidecar candidate without retaining a proposal-time Maker SHA.
- [ ] 6.6 Run the Maker native emulation/materializer profile with a shared run ID and capture its `maker_replay`, Parquet, and queried ClickHouse evidence.
- [ ] 6.7 Run the Maker Layer 12 live/sandbox profile with the same cross-repository contract, and capture real broker-boundary plus `hb_runtime` spool/drain evidence.
- [ ] 6.8 Store bounded cross-repository results that bind resolved Maker and CEX commits; keep any floating scheduled `develop` compatibility run informative and non-substitutive.

## 7. CI, Documentation, and Release Evidence

- [x] 7.1 Keep `test:e2e:archive` as the serialized pinned Local CI gate and expose the Server 24.8 A/B acceptance as a documented rerunnable command outside ordinary CI.
- [x] 7.2 Update CI to run normal tests, build/type/lint, TypeScript and Python fixtures, Local E2E, existing real-server integration, and `openspec validate --all --strict`; do not add the fixed A/B acceptance as a permanent CI job.
- [x] 7.3 Remove any CI validation of an archived OpenSpec change identifier and verify normal tests exclude dedicated archive E2E files so the expensive suite is not duplicated.
- [x] 7.4 Retain scheduled/manual credentialless public-feed smoke coverage as non-merge-gating and verify it introduces no credential profile/policy/attestation or archive write mode.
- [x] 7.5 Update `SERVICES_ARCHITECTURE.md` to classify the sidecar and A/B harness as test/operator compositions, preserve optional broker archival startup, and document collector versus third-party client roles.
- [x] 7.6 Update migration, archive E2E, sidecar, failure-diagnostics, baseline-regeneration, and rollback runbooks with exact commands, ownership, expected statuses, and cleanup behavior.
- [x] 7.7 Document truthful native/FIET-907 and production-compatible Maker data flows, including direct ClickHouse exporter ownership and `maker_replay` versus `hb_runtime` acknowledgement paths.
- [x] 7.8 Replace `Purpose: TBD` in the resulting main strategy, durable-acceptance, and market-capture specs and provide meaningful Purpose text for every newly synced capability.
- [ ] 7.9 Produce a release evidence report containing baseline/candidate/Maker commits, ClickHouse/tool versions, fixture hashes, one-time A/B migration/parity results, standard CI results, sidecar profiles, and an explicit statement that production soak was not performed or claimed.

## 8. Final Conformance and OpenSpec Closure

- [ ] 8.1 Run the complete ongoing CEX unit, strategy fault, schema, build/type/lint, Python, Local E2E, existing real-server, smoke-static, and strict OpenSpec validation matrix from a clean candidate checkout, then separately verify the recorded one-time A/B acceptance.
- [ ] 8.2 Run the pinned FIET Maker `develop` cross-repository native and production-compatible jobs against the exact CEX candidate and verify both evidence manifests agree.
- [ ] 8.3 Audit executable code, workflows, docs, and manifests for removed credential/profile/attestation/write-mode settings, floating required refs, secret leakage, fake production boundaries, and any mandatory archive startup regression.
- [ ] 8.4 Cross-reference completed evidence against FIET-901, FIET-903, FIET-907 ownership, Maker PR 1067 compatibility, and the deterministic definition of done without adding a production-soak task.
- [ ] 8.5 Verify implementation against every delta requirement, then sync main specs and archive `archive-upgrade-ab-maker-sidecar-e2e` only after all in-repository and external evidence tasks are complete.
