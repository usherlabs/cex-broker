## Context

The archive path has strong tests at individual boundaries but no required test composes those boundaries. Subscribe-handler tests use a real local HTTP stub that records requests without executing the forwarder or ClickHouse insertion. Forwarder tests exercise parsing, routing, and `RowInserter` behavior independently. ClickHouse integration tests use `@clickhouse/client`, return early when a server is unavailable, and are not backed by a ClickHouse service in CI. Collector tests open all four feeds against a fake gRPC service rather than the broker's real Subscribe handler.

The prerequisite `canonical-cex-market-data-replay-archive` change adds canonical raw, order-book, ticker, trade, and OHLCV behavior. Its OpenSpec is anchored at commit `64fdf0607a234be05bac98f3edd3125e2c05d083`; that commit changes only OpenSpec artifacts relative to its parent, `d20daf895616cdce1cff65a8191c0bb937583c6a`, so its runtime tree is the pre-canonical baseline. This regression change is authored separately and does not edit the canonical change artifacts, but its implementation tasks begin only after the canonical runtime implementation is integrated.

Apply-time prerequisite correction: the canonical runtime implementation at `d018a386b55058bccb71b0feb4ea21358b8bd8d9` was superseded by corrected commit `2730a00a0fcd6cbafbcb03cb432fa7f4224d269a`. The corrected commit removes credential profile/source-policy/attestation behavior, removes the runtime archive write-mode switch and legacy row builders from the upgraded writer, and renames backfill configuration and tooling to migration terminology. Applying this regression change requires that corrected commit as an ancestor. Its final canonical OpenSpec artifacts remain prerequisite-owned and are not amended here.

The existing architecture already exposes the required seams. `getServer` accepts an injected broker pool, allowing a deterministic fake `Exchange` to drive the real Subscribe handler. The production collector service constructs the multi-feed gRPC Subscribe client implemented in `services/ohlcv-collector/collector.ts`; that service path, rather than a research watcher or fake gRPC server, is the collector under test. The archive writer uses the production `node:http` transport. The forwarder request handler accepts the existing production `RowInserter` interface. A test-only ClickHouse Local adapter can therefore replace only the network transport below that interface while leaving the production collector, writer, HTTP contract, parser, router, batching, and DDL in the tested path.

Repository dependency direction remains `server -> handlers -> helpers`. The E2E harness and fake exchange live under test-only paths; no domain logic is added to `src/server.ts`, and helpers do not import from handlers or server code.

## Goals / Non-Goals

**Goals:**

- Make a complete deterministic archive lifecycle a required, non-skipping CI gate.
- Preserve every pre-canonical table and legacy value represented by an immutable 15-table golden fixture.
- Prove all four public feeds traverse the real collector, gRPC server, Subscribe handler, archive writer, HTTP forwarder handler, router, schema, storage engine, and query-back path.
- Prove canonical linkage, provenance, checksums, duplicate semantics, and checksum-conflict visibility for the canonical-only writer under source `broker_read`.
- Prevent the regression harness, live smoke, and production runtime from reintroducing removed write-mode or credential-classification configuration.
- Prove blocked and failed archival remains asynchronous to gRPC delivery and that retry or terminal journaling accounts exactly for undelivered rows.
- Keep a bounded live-CEX smoke workflow for environmental and provider drift without making live network behavior a merge requirement.

**Non-Goals:**

- Validate the production `@clickhouse/client` HTTP transport with ClickHouse Local; the existing ClickHouse-server integration suite remains responsible for that boundary.
- Change protobufs, registered RPCs, public APIs, archive wire formats, or production deployment topology solely to support the test.
- Modify the canonical archive OpenSpec, weaken its requirements, or revise its baseline implicitly.
- Restore runtime legacy/dual/canonical write selection, credential profiles, credential-source policy, permission attestations, or broker-side read-only classification.
- Use live CEX data for deterministic regression assertions, place orders, submit transfers, inspect private account state, or move assets.
- Treat ClickHouse Local as a production substitute for ClickHouse server behavior such as networking, authentication, replication, or operational configuration.

## Decisions

### 1. The regression is a separate change with an explicit prerequisite

`clickhouse-local-archive-e2e-regression` owns test infrastructure and regression requirements. It references but does not modify `canonical-cex-market-data-replay-archive`. The OpenSpec may be reviewed independently, but implementation and GREEN evidence require the canonical runtime to be present.

If a RED test exposes a defect in production internals, the implementation may fix that defect under this regression change only when the expected behavior is already required by the canonical or pre-canonical contracts. A newly desired compatibility break or contract change requires its own OpenSpec and baseline review.

Alternative considered: add more tasks to the canonical change. Keeping a separate capability makes the permanent regression gate, immutable baseline, and CI ownership independently reviewable and avoids rewriting an in-flight canonical specification.

### 2. ClickHouse Local is exact-versioned and checksum-pinned

The suite uses the standard `clickhouse` multi-call binary in `local` mode at `v25.8.24.21-lts`. Persistent local databases are available from ClickHouse 25.4 onward, so each CLI invocation uses the same `--path` directory. Official Linux amd64 and arm64 archive URLs and their expected digests are committed in the bootstrap implementation; a checksum downloaded beside the archive is not itself trusted.

`CLICKHOUSE_LOCAL_BIN` may point to a pre-provisioned standard ClickHouse binary, but the bootstrap verifies that it reports the exact pinned version before use. Otherwise it restores or downloads a checksum-verified binary into a versioned cache. Unsupported platform, download, checksum, extraction, executable, version, or schema-initialization failures terminate `test:e2e:archive` with a non-zero result. There is no skip path.

Alternative considered: use the runner's latest ClickHouse package or a Docker server. An exact static binary makes the storage semantics reproducible and avoids a service container, while the retained server integration suite continues to cover the client/network boundary.

### 3. `ClickHouseLocalHarness` implements the existing storage boundary

A test-only `ClickHouseLocalHarness` owns:

- a unique temporary persistent `--path` directory;
- the verified ClickHouse binary and exact version probe;
- schema application from the same ordered production archive schema-file manifest;
- a `RowInserter` that sends `JSONEachRow` to the requested supported table;
- JSON query execution with explicit projections and deterministic ordering;
- a serialized command queue so no two ClickHouse Local processes open one path concurrently;
- injectable gates and deterministic failures around insertion; and
- idempotent process and filesystem cleanup in success and failure paths.

The production schema manifest is reused or exposed from the forwarder schema module rather than copied into a divergent test-only list. ClickHouse Local parses and executes the actual SQL files. Query helpers normalize ClickHouse JSON representations according to explicit fixture field types so 64-bit integer quoting or incidental JSON formatting cannot hide a value change.

Alternative considered: emulate ClickHouse with an in-memory map. That would not execute the DDL, engines, views, coercions, or query semantics being protected.

### 4. The lifecycle test composes the real topology

The deterministic lifecycle is:

```text
controlled fake Exchange
        |
        v
real broker gRPC server ---- real multi-feed collector
        |
        v
real Subscribe handler and archive row builders
        |
        v
real BrokerExecutionArchiver queue/batching/node:http
        |
        v
test HTTP listener -> production handleArchiveRequest/parser/router
        |
        v
ClickHouseLocalHarness RowInserter -> actual schema/tables/views
        |
        v
explicit ordered JSON queries and fixture comparison
```

The fake exchange supplies controlled ORDERBOOK, TICKER, TRADES, and OHLCV promises. The server receives it through the existing environment-equivalent broker-pool injection; no credential profile or source-policy object is passed into server wiring. The harness imports the production collector implementation used by `services/ohlcv-collector/index.ts`, supplies four production subscription configurations, and observes its real gRPC client and feed metrics. It does not substitute a one-off research watcher or fake gRPC service.

Before releasing any frame, the lifecycle provisions a fixed clock and payload timestamps plus the retained production archive controls: `CEX_BROKER_ARCHIVE_ENABLED=true`, `CEX_BROKER_MARKET_ARCHIVE_ENABLED=true`, `CEX_BROKER_ARCHIVE_SOURCE=broker_read`, `CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT=production`, a unique writable `CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH`, a local `/archive` `CEX_BROKER_ARCHIVE_FORWARDER_URL`, and fixed `CEX_BROKER_DEPLOYMENT_ID` and `CEX_BROKER_CAPTURE_BUNDLE_ID` values. Authentication is either disabled at both ends or uses the same fixed value for writer-side `CEX_BROKER_ARCHIVE_FORWARDER_TOKEN` and handler-side `ARCHIVE_FORWARDER_TOKEN`. Setup must complete before frame release so a missing URL, journal path, token, source, environment, or identity is reported as a harness prerequisite failure rather than lifecycle RED evidence.

The test HTTP listener performs the same method/path dispatch for `/archive` and delegates to `handleArchiveRequest` with real telemetry and the harness inserter. It intentionally does not start `services/archive-forwarder/index.ts`, because that entry point constructs the production network client which ClickHouse Local cannot serve.

### 5. The baseline fixture is immutable, reviewable, and offline in CI

The baseline fixture is generated explicitly from a clean export of `64fdf0607a234be05bac98f3edd3125e2c05d083`. It records:

- fixture schema version, baseline commit, runtime-equivalent parent, and generation command;
- SHA-256 content hashes for every baseline source, schema, and input fixture used to derive expectations;
- the exact 15-table inventory;
- deterministic producer or HTTP inputs;
- explicit legacy column projections, field types, comparison keys, and sort order for every table; and
- expected projected rows, including timestamps, identifiers, nullable values, arrays, and payload strings.

The 15 baseline tables are:

- `market_data.candles`, `market_data.orderbook_snapshots`, `market_data.cex_stream_events`, `market_data.cex_ticker_events`, and `market_data.cex_trades`;
- `broker_execution.order_events`, `broker_execution.market_metadata_snapshots`, `broker_execution.transfer_events`, and `broker_execution.fill_events`;
- `broker_account.balance_snapshots`; and
- `strategy_data.policy_evaluation_events`, `strategy_data.strategy_policy_snapshots`, `strategy_data.market_identity`, `strategy_data.symbol_mapping`, and `strategy_data.inventory_settlement_events`.

Normal E2E and CI runs consume only the committed fixture; they do not fetch, check out, or execute the historical commit. Regeneration is a separate manual command with a committed host recipe that pins the supported platform, Bun version, dependency lockfile installation, ClickHouse version when used, environment inputs, and clean-export procedure. It requires an explicit replacement baseline commit, rewrites the provenance hashes and expected rows, and is reviewed as a compatibility decision. A generated-but-uncommitted difference fails the regeneration check rather than silently updating expectations.

Alternative considered: derive expected rows from current builders during every test. That would allow a regression and its expectation to change together and would depend on historical Git availability in shallow CI checkouts.

### 6. Lifecycle and fixture-driven coverage have different responsibilities

The all-four-feed lifecycle proves current canonical-only runtime composition. All 15 baseline tables, including the five historical market-data destinations, are independently exercised through deterministic HTTP batches sent to the real forwarder endpoint, proving request-body parsing, source validation, table allowlisting, per-table routing and limits, ClickHouse insertion, and ordered query-back. Historical compatibility therefore does not depend on or imply runtime dual-write behavior.

For each baseline table, the suite verifies the table remains accepted, every baseline projected column accepts the fixture value, and queried rows match the exact ordered expected multiset. Additive columns are ignored only by using the committed explicit projection. Extra rows are not accepted in a legacy comparison merely because canonical output is additive; permitted additive output is named and queried separately in canonical or raw-ledger tables.

The canonical inventory is closed and classified as follows:

- the raw capture table is the pre-existing `market_data.cex_stream_events`;
- normalized ticker and trade rows use the pre-existing `market_data.cex_ticker_events` and `market_data.cex_trades` tables;
- the three post-baseline supported base tables are `market_data.cex_ohlcv`, `market_data.cex_order_book_levels`, and `market_data.cex_order_book_depth_summary`; and
- query-only assertion targets are `market_data.cex_ohlcv_closed`, `market_data.cex_order_book_levels_canonical`, `market_data.cex_order_book_levels_conflicts`, `market_data.cex_order_book_depth_summary_canonical`, and `market_data.cex_order_book_depth_summary_conflicts`.

Because raw, ticker, and trade canonical records reuse baseline tables, lifecycle identities distinguish current canonical rows from fixture-driven historical rows rather than treating the whole table as additive. Views are queried but never treated as write destinations. Output outside this inventory is not accepted merely because it is additive.

This division does not claim that strategy or private-account rows originate from public subscription feeds. It tests their actual archive-forwarder contract while reserving the real subscription lifecycle for the four feeds that produce it.

### 7. Runtime capture is canonical-only and source remains provenance

The real lifecycle uses `CEX_BROKER_ARCHIVE_SOURCE=broker_read`, which is the source required by the production FIET-901 collector. Archive source remains deployment-controlled provenance and is not inferred from credentials, feed, provider, or TEE state. The upgraded runtime always emits the latest canonical inventory and exposes no legacy/dual/canonical selection.

Historical `broker_write` rows remain valid fixture inputs because `broker_write` is still a supported provenance identity. Their acceptance and exact values are tested through the all-table HTTP path, not by asking the upgraded producer to recreate them.

The suite includes a configuration-surface guard covering executable code, tests, scripts, workflows, and operational documentation. It rejects restoration of `CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE`, `CEX_BROKER_CREDENTIAL_SOURCE_POLICY`, `CEX_BROKER_PROVISIONED_CREDENTIAL_PROFILE`, `CEX_BROKER_CREDENTIAL_ATTESTATION_KIND`, or `CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE`, along with equivalent `writeMode`, credential-policy, profile, or attestation branches. Explicit negative assertions in regression artifacts may name a forbidden control, but no runtime or workflow may read, set, or act on it.

### 8. Canonical assertions recompute integrity from stored data

In the canonical-only lifecycle, each of ORDERBOOK, TICKER, TRADES, and OHLCV must produce at least one `market_data.cex_stream_events` raw row for its feed identity. Each raw row is joined by `capture_bundle_id` and `raw_capture_id` to its normalized output in the closed inventory. The suite verifies exchange/pair/feed identity, provider, source mode, source and received times, schema and checksum versions, and source `broker_read`. Stored raw and normalized checksums are recomputed from the committed contract projection rather than compared only with producer-side values.

Duplicate and conflict cases are limited to `market_data.cex_order_book_levels` and `market_data.cex_order_book_depth_summary`. The level logical key is `(capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id, schema_version, side, level_index)`; the summary key omits `side` and `level_index`. Their cases are separate:

- checksum-identical deliveries across batches remain physically auditable while the corresponding order-book canonical view returns one logical row;
- a same-request logical-key checksum conflict causes the production HTTP handler to reject the entire archive request before any table in that request is inserted; and
- a cross-batch conflict remains in physical evidence, appears in the corresponding order-book conflict view, and is excluded from its canonical view.

No same-batch checksum-conflict rejection is inferred for ticker, trade, OHLCV, or raw-stream tables. Extending that behavior requires a separate contract change.

### 9. Failure isolation uses three deterministic scenarios

A blocked inserter holds the first archive request unresolved. The fake exchange then releases later frames, and the test observes those later frames at the collector before resolving the sink gate. This proves sink latency is not on the gRPC delivery path.

A recoverable inserter failure returns an actual forwarder failure, after which the writer retries. The suite queries ClickHouse and proves every intended row eventually arrived with the expected retry/duplicate semantics.

A terminal inserter failure persists through bounded writer shutdown. The suite parses each JSONL record and requires the production shape `{ timestamp, source, deployment_id, reason, payload }`. Every undelivered row has exactly one record with a parseable timestamp, the lifecycle source and deployment, reason `shutdown_forwarder_failure`, and a full `payload` whose `table` and stable row identity match the emitted `BrokerArchiveRow`. No delivered row is misclassified as lost, and stream delivery does not terminate because of archival failure. Queue-shedding accounting remains covered by existing writer tests and may be composed here when it is needed to prove total emitted-row accounting; if composed, its production reason is `queue_shed` rather than the shutdown reason.

Alternative considered: one scenario accepting either retry or journaling. Separate scenarios prevent one durability branch from masking a broken branch in the other.

### 10. The E2E suite is a distinct required CI command

`test:e2e:archive` verifies/bootstrap the binary and runs only the archive E2E files with serialized test execution and explicit timeouts. Normal repository tests exclude the E2E path so `bun test` and the dedicated command do not run the expensive suite twice. CI runs dependency installation, normal tests, the dedicated E2E command, lint/type/build checks, and strict OpenSpec validation as distinct failing steps.

The existing conditional ClickHouse-server integration file remains intact. Its inability to reach a server may still skip that transport-specific suite, but it cannot satisfy or bypass the required ClickHouse Local job.

### 11. Live CEX smoke is bounded and non-gating

A separate scheduled/manual workflow invokes `test:smoke:archive`; it is not triggered by pull requests and is not a required merge check. It uses the broker's existing credentialless public construction path with no exchange key, secret, credential profile, source policy, or permission attestation. It selects only public ORDERBOOK, TICKER, TRADES, and OHLCV subscriptions and never calls `ExecuteAction` or private account feeds.

Each feed has a bounded connection/first-row timeout and bounded overall cleanup. The workflow uses a unique capture bundle and ClickHouse Local database, archives at least one linked raw/normalized row per feed, and reports failure without weakening deterministic CI. Logs and uploaded diagnostics exclude unredacted provider payloads and secret values. A missing binary, unavailable public feed, missing link, or cleanup deadline fails the smoke run rather than silently skipping it.

### 12. Apply-phase RED evidence is behavioral, not environmental

RED evidence is a development and review acceptance condition for applying this change, not a permanent product capability. Baseline provenance, the pinned binary, schema initialization, deterministic archive configuration, and test discovery are established before recording RED. Tests are then added against the expected interfaces and lifecycle and run before the harness or missing regression behavior is completed. The recorded RED result must identify unmet lifecycle, compatibility, or durability assertions; a missing dependency, unavailable binary, absent fixture, configuration failure, type error, or intentionally skipped test is not accepted as the required RED demonstration.

Expectations are not regenerated or weakened while turning the suite GREEN. A defect outside the agreed contracts is raised as a separate change rather than hidden by a fixture revision.

## Risks / Trade-offs

- [ClickHouse Local differs from the production server transport] -> Keep the existing `@clickhouse/client` server suite and state the boundary explicitly; Local owns deterministic DDL/storage/query coverage only.
- [The pinned archive is large or unavailable] -> Cache by exact version and architecture, commit trusted digests, support a verified local override, and fail visibly when no verified binary can be obtained.
- [Concurrent CLI processes corrupt or lock one local path] -> Serialize every command per harness and use an independent path per suite instance.
- [Fixture generation drifts with the code under test] -> Run regeneration only against an explicit clean historical export and commit provenance hashes and expected results; CI never regenerates.
- [Historical regeneration fails because the host toolchain drifted] -> Commit a pinned regeneration recipe covering platform, Bun, lockfile installation, ClickHouse when used, environment, and clean-export steps; record all versions in fixture provenance.
- [Asynchronous loops make rows or identifiers nondeterministic] -> Use controlled promises, one fixed clock, fixed payload times and identifiers, explicit flush/abort barriers, and deterministic query ordering.
- [Additive canonical data hides duplicate legacy output] -> Compare exact filtered multisets for every legacy projection and whitelist additive tables/rows explicitly.
- [A live provider is flaky or changes payload shape] -> Keep smoke non-gating, bound timeouts/retries, report feed-specific diagnostics, and never use live results as golden expectations.
- [Smoke configuration recreates credential policy] -> Run with an empty broker pool and no request credentials, guard the exact public Subscribe feed/RPC set, and reject dedicated profile, policy, attestation, or smoke-key configuration.
- [A removed runtime mode is restored by a test convenience] -> Make absence of write-mode and credential-classification configuration a permanent regression assertion across production and test entry points.
- [The canonical implementation changes before integration] -> Re-read its final artifacts and runtime before applying tasks; any contract divergence is resolved explicitly rather than modifying this baseline silently.

## Migration Plan

1. Integrate and validate corrected canonical archive commit `2730a00a0fcd6cbafbcb03cb432fa7f4224d269a` without editing its final OpenSpec artifacts from this change.
2. Capture and review the immutable baseline fixture and provenance manifest from the clean baseline commit.
3. Establish the verified ClickHouse Local bootstrap, then record meaningful failing lifecycle/regression tests.
4. Add the harness and turn schema, all-table, lifecycle, canonical, duplicate/conflict, and failure-isolation tests GREEN.
5. Add the dedicated CI step while retaining normal and ClickHouse-server tests; rollback is removal of the new required step only if the test infrastructure itself is proven invalid, not acceptance of a product regression.
6. Enable the scheduled/manual credentialless public smoke workflow. Disabling the smoke schedule does not disable deterministic CI.

## Open Questions

None. Binary version, baseline commit, table scope, canonical-only fake-CEX CI, credentialless public live smoke, compatibility policy, and gating behavior are fixed by this change.
