## Context

Two independently implemented branches must now become one release candidate:

- `ed/cute-taxes-cheat-jnrod` contains the post-upgrade canonical archive schema, legacy table migration, independent multi-feed collector, direct broker archive path, FIET-907 reference exporter, and durable SQLite ownership for `hb_runtime` strategy rows.
- `ed/clickhouse-local-e2e-5medm` contains a deterministic ClickHouse Local archive lifecycle suite and an older historical compatibility fixture.

The E2E branch predates several post-upgrade contracts. It imports the deprecated `OhlcvCollector` alias as a type, treats strategy fixtures as synchronous writes without a spool, and has TypeScript/Python checksum fixture drift. Its workflow also validates an archived OpenSpec change name instead of the active main specifications. More importantly, it loads historical rows into the current schema; it does not prove an actual schema upgrade.

CEX Broker `develop` is the authoritative pre-upgrade release line. At proposal time both Gitea and GitHub resolve it to `7a83de5f29a08f42d81f64a75a83bc9318dce94a` and its `package.json` declares `0.2.38`. The post-upgrade feature branch is not an acceptable A-side. FIET Maker `develop` moves independently and therefore is resolved and pinned when conformance runs rather than being frozen to a proposal-time SHA; that execution must still include PR 1067's archive contract refinements.

The native Maker emulation harness is intentionally offline and does not connect to CEX Broker. The production-compatible Layer 12 runtime does use the broker boundary. These are different conformance profiles and must not be collapsed into a misleading single topology.

## Goals / Non-Goals

**Goals:**

- Integrate both CEX feature branches with the latest `develop` code and retain their intended behavior.
- Prove a real, repeatable `develop` schema/data to canonical schema/data upgrade.
- Exercise the fast deterministic lifecycle continuously and record one real production ClickHouse HTTP/server A/B acceptance for this upgrade.
- Give FIET Maker a stable, CEX-owned sidecar interface for cross-service tests.
- Prove native `maker_replay` and live `hb_runtime` under their correct source and delivery contracts.
- Produce commit-, schema-, tool-, and run-scoped evidence suitable for FIET-901/FIET-903 and Maker task review.

**Non-Goals:**

- Production soak or live-venue trading; deterministic conformance replaces the removed soak task, while production observation remains separately tracked.
- New production services, broker RPCs, credential profiles, credential policies, attestation settings, or archive write modes.
- Running the native Hummingbot backtest directly against the broker.
- Moving Parquet materialization into the broker or archive-forwarder. FIET-907 retains consumer-side fixture, coverage, and bundle ownership.
- Treating the ClickHouse Local row adapter as evidence for production `@clickhouse/client` transport.
- Reintroducing legacy/dual-write runtime selectors. Upgraded producers write the latest canonical schema only.

## Decisions

### 1. Build the candidate from three explicit inputs

Implementation will first resolve and record CEX Broker `develop`, export its baseline before applying feature changes, and then form one candidate containing `develop`, the post-upgrade branch, and `ed/clickhouse-local-e2e-5medm`. The integrated candidate commit is recorded only after conflict resolution and verification.

The current feature branch remains the implementation worktree, but it is the B-side input, not the control. Conflict resolution must preserve intentional post-upgrade archive contracts while independently retaining intervening `develop` fixes and version changes. `.github/workflows/ci.yml`, package scripts, collector naming, archive request classification, fixtures, and OpenSpec state require semantic reconciliation rather than a mechanical preference for either branch.

Alternative considered: merge only the E2E branch into the current feature branch. Rejected because that would leave unintegrated `develop` fixes and could falsely label a feature ancestor as the released control.

### 2. Keep two baseline fixtures with different purposes

The existing fixture derived from `64fdf0607a234be05bac98f3edd3125e2c05d083` remains an immutable long-horizon HTTP/storage compatibility fixture. A new `develop` upgrade fixture is generated from a clean checkout of the authoritative `develop` branch and contains:

- resolved branch and commit;
- source DDL and table manifest;
- deterministic seed rows and exact legacy projections;
- source/input hashes, generator command, Bun/Node and ClickHouse versions;
- fixture schema version and generation timestamp;
- the `package.json` version read from the resolved baseline commit;
- explicit table keys, ordering, null semantics, and expected cardinalities.

Normal CI consumes committed artifacts and never fetches or executes a floating branch. Regeneration is an explicit reviewer-visible operation that resolves `develop`, records the commit, and fails on an unreviewed diff. The proposed initial resolution is `7a83de5f29a08f42d81f64a75a83bc9318dce94a`; any later replacement must still be a clean `develop` resolution and update provenance deliberately.

Alternative considered: reuse the old `64fdf060...` fixture as the A/B control. Rejected because the user-selected upgrade contract is the latest pre-upgrade `develop`, while the older fixture answers a separate compatibility question.

### 3. Use isolated real ClickHouse 24.8 instances for one-time upgrade acceptance

The repository exposes the runner as `bun run test:acceptance:archive-upgrade`. It starts isolated ClickHouse Server 24.8 A and B instances because the production schemas use fixed database names. Both instances receive the same committed `develop` DDL and seed export. This runner is mandatory evidence for accepting this canonical upgrade but is not installed as a permanent pull-request CI job. A future change may generalize it into an upgrade-test framework and then decide when that generalized framework belongs in CI.

The committed fixture determines one safe-integer, half-open migration window across both legacy sources: `start_time_ms` is the minimum of all `orderbook_snapshots.event_time_ms` and `candles.open_time_ms` values, and `end_time_ms` is the maximum plus one millisecond. The write phase sets `CEX_BROKER_CANONICAL_MIGRATION_CONFIRM=true`, supplies those exact values as `CEX_BROKER_MIGRATION_START_TIME_MS` and `CEX_BROKER_MIGRATION_END_TIME_MS`, targets B, and binds the same values to every `{start_time_ms:UInt64}` and `{end_time_ms:UInt64}` cutover query. A preflight dry-run may be diagnostic, but cannot satisfy acceptance.

The harness then:

1. leaves A unchanged as the control;
2. applies the current production schema manifest to B;
3. runs `scripts/migrate-legacy-market-data-to-canonical.ts` in confirmed write mode against B and parses its JSON summary;
4. requires `mode=write`, the fixture's expected non-zero legacy book/candle counts, and the expected non-zero canonical row count, then executes the parameter-bound phase and parity checks in `schema/clickhouse/migrations/canonical_market_data_replay_cutover.sql`;
5. repeats schema initialization and migration to prove idempotency;
6. compares every legacy projected value and cardinality in A and B;
7. verifies migrated canonical rows use `source_mode=legacy_migration_v1`, `provenance_complete=0`, and honest null raw/bundle provenance;
8. asserts canonical conflict views are empty and parity mismatches are zero;
9. starts the upgraded deterministic producer against B and proves new ORDERBOOK/OHLCV writes are canonical-only while A remains unchanged.

The real-server path must use the production `@clickhouse/client` HTTP inserter, production forwarder endpoint, schema initializer, and migration command. It may not replace them with the Local row adapter. The runner emits a bounded acceptance artifact and is executed once against the final candidate before this change is synced/archived; rerunning the same command remains possible for diagnosis or a corrected candidate.

Alternative considered: initialize only the latest schema and replay legacy rows. Retained as a compatibility check, but rejected as upgrade evidence because it never executes old DDL or the production migration.

### 4. Retain ClickHouse Local as a separate deterministic lifecycle gate

`test:e2e:archive` remains the serialized, pinned ClickHouse Local `v25.8.24.21-lts` suite. It exercises controlled fake exchange frames through the real gRPC server/Subscribe handler, the production `MarketDataCollector` implementation, archive queue/writer, HTTP handler/router, and Local storage adapter.

The merged suite must adapt to the current architecture:

- import and type against `MarketDataCollector`; the `OhlcvCollector` value alias is compatibility-only;
- retain the archived E2E specification's explicit 15-table inventory, exact environment contract, canonical table/view names, order-book logical keys, removed-variable audit, and loss-record fields;
- test the ten historical market/execution/account tables through synchronous HTTP 200 direct insertion;
- provision a real temporary SQLite strategy spool and worker for the five historical `hb_runtime` strategy fixtures, assert HTTP 202 after durable admission, and wait on spool work completion before querying them;
- keep non-strategy and `maker_replay` writes synchronous;
- verify spool restart recovery and isolated retry at least once in the composed server lifecycle, while retaining the exhaustive lower-level fault matrix;
- update the Python checksum projection to match the canonical stored-value contract and require both TypeScript and Python fixture checks;
- run `openspec validate --all --strict` (or validate a current main spec), never an archived change identifier.

The Local suite is the standard ongoing archive E2E CI gate. Existing real-server integration tests continue to validate production transport. The one-time two-instance A/B acceptance is separately recorded and is not inferred from Local success.

### 5. Make the sidecar a test composition, not a production service

CEX Broker owns a bounded archive-conformance composition exposed as `bun run archive:sidecar -- <operation>`. `up` requires `--run-id`, `--profile native_replay|production_compatible`, `--candidate-sha`, `--maker-sha`, and `--artifacts-dir`; it writes `<artifacts-dir>/<run-id>/manifest.json`. `ready`, `verify`, and `down` require `--manifest <path>`. `ready` accepts `--timeout-ms` and defaults it to `120000`. Exit code `0` means success, `2` means invalid invocation/manifest, and `1` means lifecycle, readiness, or verification failure. Verification writes `<artifacts-dir>/<run-id>/verification.json`. The composition starts:

- ClickHouse Server 24.8;
- the production archive-forwarder with a unique SQLite spool;
- a deterministic broker fixture server using the normal gRPC wiring and a controlled fake exchange;
- the independent collector service entrypoint configured as a loopback gRPC client.

Readiness requires broker gRPC, forwarder health, writable spool, ClickHouse schema readiness, and collector subscription readiness. Shutdown is bounded, idempotent, and removes only run-owned resources. Failed readiness or verification always exits non-zero and retains bounded diagnostics below the run artifact directory.

The interface emits a JSON evidence manifest containing run ID, resolved CEX baseline/candidate and Maker commits, capture bundle/deployment IDs, non-secret endpoints, schema/checksum versions, ClickHouse/Bun/Python versions, migration counts, spool-drain results, and artifact hashes. It must never include tokens, CEX credentials, or raw environment dumps.

No new core broker environment setting is introduced. Existing archive variables can be supplied inside the test composition. The deterministic exchange is credentialless and production broker startup remains valid when archival configuration is absent.

Alternative considered: place the whole composition in FIET Maker. Rejected because CEX Broker owns its service topology, schemas, migration, and verification semantics. Maker owns when and how the composition is invoked from its repository.

### 6. Define native replay and production-compatible Maker profiles separately

The native replay profile is:

`collector -> CEX Broker -> archive-forwarder -> ClickHouse -> FIET-907 materializer -> Parquet -> native HB emulation`

Native strategy evidence posts `source=maker_replay` to the forwarder. It is synchronous, offline/replay evidence and is not routed through the live-runtime durability spool. The CEX reference Parquet exporter queries ClickHouse directly and is tested as a compatibility tool for FIET-907; full materialization, coverage, and bundle assembly remain Maker/FIET-907 responsibilities.

The production-compatible profile is:

`Layer 12 live/sandbox runtime <-> CEX Broker`, with `hb_runtime -> archive-forwarder -> durable SQLite spool -> ClickHouse`, while the collector independently keeps the configured market subscriptions alive.

The Maker-owned job runs from a clean `develop` checkout, resolves and records its commit at execution time, confirms the expected PR 1067 wire contract is present, starts a pinned CEX candidate sidecar, uses one run identity across both repositories, executes the selected profile, and invokes the CEX verifier. A pinned candidate SHA is mandatory for required evidence; an additional floating scheduled compatibility job may resolve current `develop` but cannot replace pinned evidence.

Alternative considered: run native emulation while claiming direct broker interaction. Rejected because Maker explicitly defines that harness as offline and such a test would not exercise the claimed architecture.

### 7. Add `maker_replay` without weakening `hb_runtime` ownership

Strategy request classification becomes a closed two-source contract:

- `hb_runtime`: approved strategy tables only, existing v1/v2 validation, durable SQLite admission, HTTP 202, asynchronous isolated table drainage and stable ClickHouse deduplication tokens;
- `maker_replay`: approved strategy tables only, the same row schema/provenance validation, direct ClickHouse insertion, HTTP 200 only after success and HTTP 500 on insertion failure, and no spool quota consumption.

Mixed strategy/non-strategy batches and strategy tables under all other sources remain HTTP 400. `maker_replay` cannot be upgraded, rewritten, or inferred as `hb_runtime`; source remains caller-declared run provenance checked against every row.

Both sources share legacy/v1/v2 schema-version validation and row/envelope provenance checks before path selection. The pinned Maker wire fixture remains authoritative for `hb_runtime`; replay tests reuse the same row field/version contract without claiming byte equality to a Maker replay fixture unless Maker publishes one. Spool admission/drain metrics remain `hb_runtime`-only, while bounded replay success/failure counters distinguish synchronous replay inserts without request-derived labels.

Alternative considered: spool `maker_replay` too. Rejected because replay is bounded and restartable by its producer, while the established spool ownership contract is specifically required for the one-attempt live Maker path.

### 8. Keep ongoing CI distinct from one-time upgrade acceptance

CEX required CI contains normal tests/build/lint, strict OpenSpec validation, the standard Local archive lifecycle, cross-language checksum fixtures, and existing real-server contract tests. Missing required prerequisites or discovered-zero-tests is a failure, not a skip. The two-instance A/B runner is executed once against the final candidate and its manifest is required release/change-acceptance evidence, but it is not added to every pull request. If upgrade testing is later generalized, that future change must define the reusable baseline/version selection and CI trigger contract rather than silently normalizing this one-off fixture.

Maker conformance is external evidence because it is orchestrated from FIET Maker `develop`. Closure records both repository commits and command outputs, verifies the expected source/delivery profile, and proves queried ClickHouse rows. No production-soak task is included.

## Risks / Trade-offs

- **[Branch integration accidentally drops released fixes]** -> Form the candidate with explicit `develop`, post-upgrade, and E2E inputs; review range-diffs and run all three test classes before recording the candidate commit.
- **[A committed baseline becomes mistaken for a floating `develop`]** -> Record branch plus resolved commit and require explicit regeneration/review; normal CI never fetches `develop`.
- **[A one-time A/B result becomes irreproducible]** -> Commit the fixture, runner, exact invocation, output hashes, and resolved commits so the acceptance can be rerun for a corrected candidate even though it is not a permanent CI job.
- **[Local behavior differs from production HTTP transport]** -> Assign lifecycle determinism to Local and all transport/migration/dedup claims to Server 24.8; neither gate substitutes for the other.
- **[Maker native replay is confused with live integration]** -> Emit distinct profile and source fields in evidence and fail if native emulation claims `hb_runtime` or broker interaction.
- **[Strategy 202 is mistaken for stored delivery]** -> Sidecar verification waits for explicit spool completion and queries ClickHouse; admission and drainage remain separate evidence.
- **[Cross-repository branches move]** -> Required runs pin resolved SHAs in the manifest. A scheduled floating check is informative only.
- **[Migration duplicates rows on rerun]** -> Execute it twice and assert stable canonical logical results, physical evidence expectations, conflict views, and exact parity.
- **[Secrets leak through test manifests]** -> Use fixed local sink tokens if authentication is enabled, redact process output, and whitelist evidence fields instead of serializing environments.

## Migration Plan

1. Resolve CEX Broker `develop`, confirm the authoritative remote commit, and generate/review the immutable `develop` DDL/data fixture before integrating feature code.
2. Integrate `develop`, the post-upgrade implementation, and the E2E branch; reconcile CI, collector, forwarder, fixture, schema, and documentation conflicts.
3. Repair and pass the Local E2E suite, TypeScript/Python checksum checks, strict OpenSpec validation, and existing unit/integration tests.
4. Add and execute the one-time two-instance ClickHouse Server 24.8 A/B acceptance runner with confirmed write mode, fixture-derived parameter binding, migration rerun, parity, provenance, conflict, and canonical-only producer assertions; retain its manifest outside the ongoing CI gate.
5. Add `maker_replay` classification/direct insertion and preserve the existing `hb_runtime` durable-spool behavior.
6. Add the CEX-owned sidecar lifecycle and evidence manifest, then validate both profiles with CEX fixtures.
7. Coordinate a FIET Maker `develop` job that pins the candidate CEX SHA and produces cross-repository evidence for native replay and production-compatible profiles.
8. Update `SERVICES_ARCHITECTURE.md`, E2E/operator docs, FIET-907 exporter references, main-spec Purpose text, and release evidence; run standard CI plus the recorded one-time acceptance before sync/archive.

The data migration is append-only into canonical tables and retains legacy tables/views. Rollback therefore stops the upgraded producer, preserves both databases and evidence, and redeploys the prior broker only if its legacy schema remains available. No automated rollback may drop canonical or legacy data. A failed parity/conflict check blocks cutover and leaves the legacy dataset authoritative.

## Open Questions

- The exact Maker workflow filename and sandbox command are Maker-repository implementation details; they must be selected while applying the cross-repository task and recorded in evidence.
- If CEX Broker `develop` advances before baseline generation, reviewers must confirm the new resolved commit still represents the intended pre-upgrade release and update the proposal-time SHA explicitly rather than silently regenerating.
