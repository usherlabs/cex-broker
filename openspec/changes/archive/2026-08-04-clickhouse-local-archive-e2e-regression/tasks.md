## 1. Prerequisite And Baseline Audit

- [x] 1.1 Integrate corrected canonical prerequisite commit `2730a00a0fcd6cbafbcb03cb432fa7f4224d269a`, confirm its final `canonical-cex-market-data-replay-archive` artifacts and canonical-only runtime are present, and verify this change does not edit those prerequisite-owned files.
- [x] 1.2 Install the locked Bun dependencies and prove the existing `@clickhouse/client` integration file loads before attributing failures to the new E2E suite.
- [x] 1.3 Verify `64fdf0607a234be05bac98f3edd3125e2c05d083` changes only OpenSpec artifacts relative to `d20daf895616cdce1cff65a8191c0bb937583c6a` and record that runtime equivalence in the baseline tooling.
- [x] 1.4 Extract the exact pre-canonical `SUPPORTED_TABLES` inventory and fail baseline generation unless it contains the specified five market, four execution, one account, and five strategy tables.
- [x] 1.5 Identify every baseline row builder, schema file, shared fixture, and deterministic input source used to generate expectations, including the external strategy-data envelope fixture.
- [x] 1.6 Record the integrated canonical inventory, proving that `market_data.cex_stream_events`, `market_data.cex_ticker_events`, and `market_data.cex_trades` are extended baseline tables; that exactly `market_data.cex_ohlcv`, `market_data.cex_order_book_levels`, and `market_data.cex_order_book_depth_summary` are post-baseline supported tables; and that the five specified canonical/conflict/closed views exist.

## 2. Immutable Baseline Fixture

- [x] 2.1 Add a versioned deterministic input corpus with fixed wall-clock time, payload timestamps, deployment id, account selectors, capture identifiers, event identifiers, nullable values, arrays, and payload strings.
- [x] 2.2 Add an explicit baseline-regeneration command and committed host recipe that pin the platform, Bun version, lockfile installation, ClickHouse version when used, environment inputs, and clean temporary export procedure without modifying or importing current runtime files.
- [x] 2.3 Generate baseline runtime rows for ORDERBOOK, TICKER, TRADES, OHLCV, and stream-event builders from the clean baseline export.
- [x] 2.4 Generate or copy deterministic contract rows for every `broker_execution`, `broker_account`, and `strategy_data` baseline table, preserving the production HTTP envelope shape.
- [x] 2.5 Record fixture schema version, baseline and parent commits, generation command, exact table inventory, SHA-256 source/input/schema hashes, explicit field types, legacy projections, comparison keys, and deterministic sort orders.
- [x] 2.6 Commit expected rows for all 15 tables, including every fixed timestamp, identifier, nullable field, array, and payload string used by comparison.
- [x] 2.7 Add fixture validation that rejects a missing/extra table, projection, comparison key, source hash, or expected row and proves normal validation needs no historical checkout or network access.
- [x] 2.8 Run regeneration twice from the same baseline and prove semantically byte-equivalent output; make verification fail on an uncommitted generated difference.
- [x] 2.9 Record the regeneration host and tool versions in fixture provenance and fail regeneration when the executing environment does not satisfy the committed recipe.

## 3. Pinned Runtime And RED Tests

- [x] 3.1 Commit the exact ClickHouse `v25.8.24.21-lts` Linux amd64 and arm64 artifact URLs, archive digests, extracted-binary expectations, and cache key.
- [x] 3.2 Add a bootstrap/verifier that accepts `CLICKHOUSE_LOCAL_BIN` only at the exact version, otherwise restores or downloads and verifies the official artifact, and fails every unsupported or unverifiable path.
- [x] 3.3 Add the dedicated archive E2E test directory and a local serialized command that cannot pass when no tests are discovered, while leaving CI wiring for the later workflow task.
- [x] 3.4 Add compileable test support contracts for the planned harness, HTTP endpoint, controlled exchange, fixed clock, and lifecycle barriers without completing their storage behavior.
- [x] 3.5 Write failing tests for mandatory binary/version checks, production schema execution, isolated persistent paths, serialized operations, and cleanup.
- [x] 3.6 Write failing tests for all-15-table HTTP insertion/query-back, exact legacy projections, source mismatch rejection, and unsupported baseline-table failures.
- [x] 3.7 Replace the obsolete dual/canonical matrix tests with failing tests for one `CEX_BROKER_ARCHIVE_SOURCE=broker_read` canonical-only four-feed lifecycle, independent all-15-table baseline compatibility, and absence of removed write-mode and credential-classification configuration.
- [x] 3.8 Write failing tests for order-book level and depth-summary identical duplicates, whole-request same-batch rejection, cross-batch conflict views, a blocked sink, recoverable retry, exact terminal journal records, and total emitted-row accounting.
- [x] 3.9 Run the verified E2E command after writing the configuration-correction assertions but before removing the obsolete behavior, capture behavioral RED evidence for the forbidden surfaces, and reject missing imports, fixtures, binaries, schema setup, skips, or no-test discovery as acceptable RED proof.

## 4. ClickHouse Local Harness And HTTP Endpoint

- [x] 4.1 Implement `ClickHouseLocalHarness` under test-only paths with a unique temporary `--path`, exact version probe, owned-process tracking, and idempotent cleanup.
- [x] 4.2 Reuse or expose the production ordered archive schema-file manifest so the harness cannot drift to a copied schema list.
- [x] 4.3 Apply every actual production schema file through ClickHouse Local and surface file/statement context on initialization failure.
- [x] 4.4 Implement a per-harness serialized command queue that prevents concurrent ClickHouse Local processes from opening the same persistent path.
- [x] 4.5 Implement the production-compatible `RowInserter` using `JSONEachRow`, table allowlist types, bounded stdin/stdout/stderr handling, and non-zero exit propagation.
- [x] 4.6 Implement ordered JSON query execution and fixture-type normalization for 64-bit integers, decimals, timestamps, arrays, nullable values, and payload strings.
- [x] 4.7 Implement deterministic inserter gates and scripted fail-then-succeed or persistent-failure wrappers without bypassing the production HTTP handler.
- [x] 4.8 Add a local HTTP listener that dispatches `/archive` to `handleArchiveRequest` with production parsing, routing, limits, telemetry, optional matched bearer authentication, and the harness inserter.
- [x] 4.9 Turn the runtime, schema, persistence, serialization, inserter, query, HTTP, error, and cleanup harness tests GREEN.

## 5. All-Table Storage Compatibility

- [x] 5.1 Post fixture-driven batches through the real local `/archive` endpoint for every one of the 15 baseline tables independently of current producer output.
- [x] 5.2 Query every baseline table with its committed projection and ordering and compare the exact expected multiset and legacy row cardinality.
- [x] 5.3 Prove additive current columns are ignored only through named baseline projections while a missing, changed, or duplicated legacy value fails.
- [x] 5.4 Add a production-path test that rejects envelope/row source disagreement and proves the rejected table batch leaves no stored row.
- [x] 5.5 Add a guard that compares the fixture inventory with the baseline allowlist and current forwarder support so an unsupported baseline table fails visibly and the only post-baseline supported tables are `market_data.cex_ohlcv`, `market_data.cex_order_book_levels`, and `market_data.cex_order_book_depth_summary`.
- [x] 5.6 Turn all 15 table schema, parsing, routing, insertion, query-back, and compatibility tests GREEN without changing the reviewed fixture expectations.

## 6. Real Four-Feed Lifecycle And Canonical Integrity

- [x] 6.1 Implement a controlled fake `Exchange` with deferred ORDERBOOK, TICKER, TRADES, and OHLCV emissions, fixed payloads, symbol resolution, and bounded shutdown.
- [x] 6.2 Compose the fake exchange with production `getServer` environment-equivalent broker-pool injection and the production collector implementation imported by `services/ohlcv-collector/index.ts`, without passing a credential-policy/profile object; prove the suite uses its real gRPC Subscribe client rather than a research watcher or fake gRPC service.
- [x] 6.3 Compose the real `BrokerExecutionArchiver` queue, batching, flush, retry, loss journal, and `node:http` transport with the production HTTP handler and ClickHouse Local harness.
- [x] 6.4 Before releasing frames, set only the retained archive controls, including `CEX_BROKER_ARCHIVE_SOURCE=broker_read` and production capture identity/environment; configure matched archive-forwarder authentication or disable it at both ends, and prove no removed write-mode or credential-classification variable is read or set.
- [x] 6.5 Remove the dual-write lifecycle and all mode-dependent row-count/legacy-output branches; prove the upgraded ORDERBOOK and OHLCV paths emit canonical rows and no legacy `orderbook_snapshots` or `candles` rows.
- [x] 6.6 Query the closed canonical inventory and prove at least one `market_data.cex_stream_events` raw row per feed links to its normalized output; fail every unexpected destination or unclassified row.
- [x] 6.7 Add a repository guard proving executable production, E2E, smoke, workflow, and operational paths do not restore the five removed environment variables or equivalent write-mode/profile/policy/attestation logic.
- [x] 6.8 Recompute raw and normalized checksums from queried stored projections for all four canonical-only feeds and compare them with stored checksum values and algorithm versions.
- [x] 6.9 Prove `market_data.cex_order_book_levels_canonical`, `market_data.cex_order_book_depth_summary_canonical`, and `market_data.cex_ohlcv_closed` return the expected conflict-free rows; prove both named conflict views are empty and the upgraded lifecycle writes no legacy order-book or candle rows.
- [x] 6.10 For both order-book base tables and their exact logical keys, prove identical cross-batch deliveries remain physical and deduplicate canonically, a same-request checksum conflict rejects the entire HTTP request with zero inserts from every included table, and cross-batch conflicts remain visible and excluded from the corresponding canonical view.
- [x] 6.11 Remove arbitrary lifecycle sleeps in favor of explicit frame-received, request-started, flush-complete, query-visible, stream-aborted, and cleanup-complete barriers.

## 7. Failure Isolation And Loss Accounting

- [x] 7.1 Block the first real HTTP insertion, release later fake-exchange frames, and prove the collector observes those frames before the insertion gate resolves.
- [x] 7.2 Prove all four gRPC streams remain successful and active while the sink is blocked and close cleanly only through the test's explicit abort.
- [x] 7.3 Script an insertion failure followed by recovery, prove the production writer retries, and query every intended row with the expected physical/canonical duplicate semantics.
- [x] 7.4 Keep insertion failing through bounded writer shutdown and verify exactly one JSONL record per undelivered row with a parseable `timestamp`, matching `source` and `deployment_id`, reason `shutdown_forwarder_failure`, and the complete emitted `payload`.
- [x] 7.5 Correlate emitted, stored, retried, and journaled identities using `payload.table` and stable `payload.row` fields so every emitted row is accounted for and no stored row is classified as terminally lost.
- [x] 7.6 Exercise queue saturation within the composed lifecycle only if needed to close the accounting proof; if composed, require reason `queue_shed` while preserving the exact queue bounds already covered by writer tests. Queue saturation was not needed because the separate retry and terminal branches close the total-accounting proof and existing writer tests retain queue-bound coverage.
- [x] 7.7 Turn blocked, recoverable, terminal, and total-accounting tests GREEN without weakening delivery or durability assertions.

## 8. Commands, Required CI, And Documentation

- [x] 8.1 Add `test:e2e:archive` to `package.json` with explicit E2E file selection, serialized execution, deterministic timeouts, and failure when no test runs.
- [x] 8.2 Keep the normal test command distinct by excluding the archive E2E path while retaining every existing unit and integration test.
- [x] 8.3 Add a required CI step that caches or bootstraps the pinned binary, runs `test:e2e:archive`, and fails on binary, schema, fixture, test-discovery, or assertion errors.
- [x] 8.4 Retain the existing ClickHouse-server integration suite and document that it owns `@clickhouse/client` network transport coverage not supplied by ClickHouse Local.
- [x] 8.5 Add CI steps or existing-command coverage for normal tests, lint/check, type/build validation, and strict validation of this OpenSpec as separate failures.
- [x] 8.6 Update E2E documentation for canonical-only runtime capture, independent fixture-driven historical compatibility, retained archive controls, forbidden configuration surfaces, credentialless public smoke, binary behavior, failure diagnostics, and cleanup.

## 9. Live CEX Smoke Workflow

- [x] 9.1 Convert `test:smoke:archive` to the existing credentialless public exchange-construction path with a unique capture bundle and `CEX_BROKER_ARCHIVE_SOURCE=broker_read`, without exchange keys, credential policy/profile, attestation, or runtime write-mode configuration.
- [x] 9.2 Restrict the smoke implementation to public ORDERBOOK, TICKER, TRADES, and OHLCV Subscribe operations and add a guard proving it cannot invoke `ExecuteAction` or private/account/asset-moving paths.
- [x] 9.3 Add per-feed first-row timeouts, an overall deadline, bounded reconnect behavior, and explicit broker/stream/writer/forwarder/harness cleanup.
- [x] 9.4 Query at least one raw and linked normalized canonical row for every live feed and fail on a missing feed, provenance link, checksum, or cleanup deadline.
- [x] 9.5 Update the scheduled/manual-only workflow to require no CEX credential secrets or attestation variables while retaining no pull-request trigger and no merge-required status.
- [x] 9.6 Redact credentials and credential-bearing payloads from logs/artifacts and retain only bounded feed-specific failure diagnostics.
- [x] 9.7 Document credentialless public construction and verify the smoke never probes permissions or invokes an order, cancellation, transfer, deposit, withdrawal, or asset movement.

## 10. Final Verification

- [x] 10.1 Re-run baseline regeneration twice and verify the committed fixture and provenance manifest remain unchanged.
- [x] 10.2 Run `test:e2e:archive` from a clean shallow/offline-compatible checkout using only the committed fixture and verified binary cache/override after the canonical-only correction.
- [x] 10.3 Run the normal repository test command and the retained ClickHouse-server integration suite with a provisioned server when available after integrating the corrected prerequisite.
- [x] 10.4 Run repository lint/check, server line-budget, type, and build commands required by CI and resolve every failure after removing obsolete configuration logic.
- [x] 10.5 Run a manual credentialless public live smoke and verify all four linked feed assertions without invoking private or write operations.
- [x] 10.6 Run `openspec validate clickhouse-local-archive-e2e-regression --strict` and resolve every validation error after this amendment and its implementation.
- [x] 10.7 Review the final diff to prove corrected prerequisite commit `2730a00` is integrated, its canonical OpenSpec artifacts are unchanged by this change, fixture expectations were not weakened, no E2E skip path exists, no forbidden configuration remains executable, and no production protobuf/RPC/public API changed.
- [x] 10.8 Supersede the prior GREEN evidence and record fresh results for the dedicated E2E command, normal tests, build/type checks, strict OpenSpec validation, configuration-surface audit, and non-gating credentialless smoke.
