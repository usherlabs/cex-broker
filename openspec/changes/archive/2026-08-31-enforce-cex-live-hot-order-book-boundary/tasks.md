## 1. Authority and implementation preflight

- [x] 1.1 Re-read this change against the current CEX and Maker boundary records and record any newly discovered named consumer or operator compatibility requirement before changing code.
- [x] 1.2 Record `complete-maker-preparation-output-contract` as superseded by this change and remove it from the active change set without synchronizing its delta specs, using a reviewed `openspec archive --skip-specs` operation or an approved equivalent; verify none of its remaining tasks, release actions, or unmerged requirements entered the main specs.
- [x] 1.3 Verify that the implementation base still contains merge `c81f60a`, first parent `41dbe7c`, second-parent tip `10f0811`, inclusive preparation series `ae16314^..10f0811`, and retained intermediate tree `7db5916`; stop for specification review if the topology differs.
- [x] 1.4 Correct the CEX-relevant TASK-60 and handoff records to state that the preparation series was merged, Maker/FIET-1015 owns cold sourcing, FIET-907 is only a consumer, and this OpenSpec is the CEX implementation authority.
- [x] 1.5 Add the repository instruction that superseded internal implementations, schemas, aliases, adapters, and readers are deleted unless an operator explicitly requires a bounded compatibility period.
- [x] 1.6 Inventory package consumers, deployed historical writers, canonical-Parquet consumers, sidecar callers, ClickHouse objects, and v1 summary readers; block removal only for a named current CEX consumer that requires specification review.

## 2. Focused preparation-series rollback

- [x] 2.1 Record the exact ten commits from `ae16314` through `10f0811` and the non-governance paths each commit changes so the inverse set is reviewable.
- [x] 2.2 Reverse the ten commits newest-to-oldest, including both `10f0811` and `ae16314`, with additive revert commits that preserve merge `c81f60a` and do not rewrite branch history.
- [x] 2.3 Compare every non-governance path in the rollback result to tree `7db5916` and resolve any difference not explicitly allowed for this OpenSpec, `AGENTS.md`, or approved task records.
- [x] 2.4 Prove the retained `0011cf4` archive-forwarder packaging effect by building the production image and running the runtime-helper image smoke test.
- [x] 2.5 Run formatting, type checking, and the focused archive/OKX regression set against the intermediate tree, and do not publish or deploy that intermediate state.

## 3. Close historical market-data admission

- [x] 3.1 Add failing unit and integration cases proving `external_backfill` and an arbitrary unknown source are rejected before generic routing, durable-success accounting, and ClickHouse insertion.
- [x] 3.2 Replace caller-controlled market source admission with a deployment-derived closed validator accepting only `broker_read` and `broker_write`.
- [x] 3.3 Remove external-backfill routing, authorization, health, preflight, and supported-inventory entries while preserving ordinary `/archive`, retry, spool, loss-journal, telemetry, strategy, and non-market behavior.
- [x] 3.4 Exercise a legacy worker-shaped request and a crafted generic envelope end to end and prove no raw, normalized, level, summary, evidence, or successful-spool row is produced.
- [x] **DEFERRED to separately governed operator rollout; not executed by this change:** 3.5 Before executing the separately approved terminal migration, deploy the source-rejection change ahead of historical producer or schema-object removal and capture the bounded admission evidence required by the migration runbook. (Operational rollout; not an implementation-completion gate.)

## 4. Remove the CEX historical preparation product

- [x] 4.1 Delete vendor adapters, acquisition workers, reconstruction code, sequence/re-anchoring diagnostics, failure attribution, provider-object quarantine, qualification, promotion, selection, and their product-only helpers from CEX.
- [x] 4.2 Delete source-tape, required-clock, source-forensics, preparation command, file-job, schema, policy, fixture, and release-freeze implementations and tests.
- [x] 4.3 Delete the packaged and script-level canonical order-book Parquet exporters, exact-selection code, replay validator, schemas, fixtures, tests, and documentation.
- [x] 4.4 Remove historical commands, npm bins, package subpath exports, product pins, workflows, scripts, dependencies, and release assets from `package.json` and the packaged file set.
- [x] 4.5 Remove external-backfill client code and all stale references to qualification, promotion, replay-qualified views, vendor capture origin, and CEX-owned FIET-1015/FIET-907 preparation from active code and docs.
- [x] 4.6 Preserve only low-level code independently exercised by the live CEX path; document or test each retained item from the first seven commits and delete every otherwise vendor-only item.
- [x] 4.7 Pack the candidate package and assert that no removed bin, subpath, schema, policy, fixture, Parquet exporter, vendor dependency, or preparation artifact is present.

## 5. Define the bounded summary-v2 contract test-first

- [x] 5.1 Add the versioned `cex-order-book-depth-summary-v2-conformance/v1` fixture format and its SHA-256 manifest with exact, censored, explicitly exhausted, asymmetric non-empty, truncated, duplicate, conflicting, incomplete-provenance, malformed, empty-bid, empty-ask, and both-empty cases; pin archive depth and measurement bands in every case.
- [x] 5.2 Add failing pure-writer tests for midpoint-relative bands, the one shared bands array, aligned per-side boundary/depth/status arrays, requested/observed/retained boundaries, cadence/profile provenance, validated exhaustion, and the closed `exact|censored` enum.
- [x] 5.3 Add failing cases proving a short observed count does not imply exhaustion, validated exhaustion requires `exact`, best-side-relative math is rejected, missing or inconsistent boundary metadata is rejected rather than stamped unknown, and level rows cannot repair missing or censored summary evidence.
- [x] 5.4 Define the exact normative v2 column names, field order, ClickHouse types, nullability, canonical decimal representation, checksum inputs, and closed archive metadata type specified by the fixture and delta.
- [x] 5.5 Thread the archive metadata from the venue adapter and physical public-feed observation through the collector to the canonical order-book writer without changing current snapshot or `Subscribe(ORDERBOOK)` RPC shapes.
- [x] 5.6 Implement summary-v2 calculation from the complete validated observed snapshot before applying the configured retained top-N slice.
- [x] 5.7 Keep raw and level rows on capture schema `1.0.0`; compute `raw_checksum` and `raw_capture_id` from the complete normalized observation and `snapshot_id` from retained N without summary schema input; stamp only the linked summary as `2.0.0` and keep per-row normalized checksums distinct.
- [x] 5.8 Reject incomplete live provenance, invalid enums, invalid/null required boundary fields, empty or one-sided books, misaligned arrays, conflicting identities, and market-row `producer_id`/`producer_run_id` fields before supported insertion.
- [x] 5.9 Persist at most configured N bid and N ask level rows, with `CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT` default `25` and range `1..500`, normalize measurement bands with default `[10,25,50,100]`, and prove levels are diagnostics only.
- [x] 5.10 Update current/live depth-sourcing tests so in-memory L2 levels retain live coverage and Proof A semantics while persisted levels cannot reproduce Maker policy; make every historical snapshot request typed unsupported and every historical capability flag false.

## 6. Bound ORDERBOOK raw storage

- [x] 6.1 Add failing tests using an upstream snapshot larger than archive N to prove no ORDERBOOK raw column or diagnostic mode retains bids, asks, nested levels, or a provider body.
- [x] 6.2 Implement `orderbook_metadata_only_v1` with exactly the specified 13 JSON keys, types, nullability, canonical decimal strings, count constraints, and no generic extra-key or full-body fallback.
- [x] 6.3 Compute and retain schema-`1.0.0` raw-capture identity and checksum from the complete canonical normalized observation before discarding its full body; compute the metadata row's normalized checksum separately.
- [x] 6.4 Prove that changing a discarded upstream level changes raw identity while raw JSON remains fixed-shape, that missing/extra/mistyped metadata and empty sides reject the complete capture, and that identical retries remain idempotent while conflicts remain auditable.
- [x] 6.5 Prove TICKER, TRADES, and OHLCV raw encodings, checksums, and normalized writes are unchanged.

## 7. Cut ClickHouse and readers directly to summary v2

- [x] 7.1 Add non-destructive fresh-install DDL for the exact summary-v2 field/type/nullability contract and a supported view restricted to broker sources, `schema_version = '2.0.0'`, complete provenance, and checksum-consistent canonical keys.
- [x] 7.2 Update the forwarder schema, validators, insertion mapping, canonical/conflict queries, diagnostics, and fixture types to accept complete v2 rows and reject mislabeled or default-filled rows.
- [x] 7.3 Remove every active summary-v1 writer, reader, decoder, alias, fallback, compatibility view, and version-laundering query; change `legacy_migration_v1` to emit bounded incomplete-provenance schema-v1 levels only and no summary of either version.
- [x] 7.4 Update fresh-install schema inventory to omit vendor evidence, qualification, promotion, selection, archive-cluster identity, replay-qualified views, external-source defaults, vendor-only `capture_origin`, and historical TTL exceptions.
- [x] 7.5 Preserve append-only physical base rows plus the exact level and summary logical keys; make `cex_order_book_levels_{canonical,conflicts}` broker-source schema-v1 diagnostic views and `cex_order_book_depth_summary_{canonical,conflicts}` broker-source, complete-provenance, schema-v2-only views; prove identical retries collapse only in canonical output and cross-batch conflicts remain physical, visible, and excluded.
- [x] 7.6 Run the shared fixture through the production writer and real ClickHouse and compare its canonical typed supported-view projection, including canonical decimal strings and deterministic array/row ordering, rather than raw driver bytes.
- [x] 7.7 Add real-ClickHouse duplicate, checksum-conflict, incomplete-provenance, malformed-array, empty-side, v1-exclusion, source-rejection, and top-N bound cases.
- [x] 7.8 Scan active code, SQL, tests, docs, and packaged files to prove no v1 consumer or removed historical schema surface remains.

## 8. Thin the conformance sidecar to Proof C

- [x] 8.1 Replace sidecar contract tests with failing v2-only cases for the sole `production_compatible` profile and explicit rejection of `native_replay` and v1 manifests/results.
- [x] 8.2 Delete the native profile, `maker_replay` sidecar branch, synchronous-native result, CEX reference export, Parquet fields including `parquetOwnership`, replay validator, FIET-907 loader assertion, and combined Proof A/B gates.
- [x] 8.3 Define v2 manifest/result schemas containing resolved CEX and Maker commits, bounded timestamps and row ids, the hash-bound shared-wire fixture/test identity, feed-sharing/archive-decision evidence, durable-202/spool evidence, and exact five-table producer/run identities.
- [x] 8.4 Keep the real Layer12 current/live ORDERBOOK snapshot and subscription checks and prove Maker and the collector share one physical feed with no more than one archive decision per physical observation.
- [x] 8.5 Keep the ArchiveEmitter `hb_runtime` wire test and prove HTTP 202 follows durable spool admission and the expected batch drains into all five strategy tables with exact producer, run, batch, and row-count identities.
- [x] 8.6 Replace PR-number ancestry checks with resolved clean commits plus the content hash of the current shared-wire fixture/test; keep dual-repository checkout support development-only.
- [x] 8.7 Make successful Proof C sufficient for sidecar success, keep Proof A in the CEX-local coalescing regression, keep Proof B in Maker, and state explicitly that sidecar success does not prove hot-reader parity or production soak.
- [x] 8.8 Retain and test the existing non-interactive `up|ready|verify|down` commands and exit-code contract; reject `up --profile native_replay` and the unadopted `prepare|execute|cleanup` verbs without reinterpretation.
- [x] 8.9 Run Proof C against a deterministic controlled/local fixture venue through production handlers, acquisition-profile, collector, forwarder, spool, and ClickHouse paths; keep any public-network market smoke separate, optional, and non-gating.

## 9. Rebuild archive regression and documentation

- [x] 9.1 Replace vendor/promotion/export E2E inventory and assertions with the final live/hot closed inventory, historical-source rejection, metadata-only raw, bounded levels, v2-only view, and removed-object absence gates.
- [x] 9.2 Preserve and run the four public-feed lifecycle, current snapshot, live subscription, physical-feed coalescing Proof A, strategy durable-acceptance, loss/retry, telemetry, and image/container regressions.
- [x] 9.3 Update operator and architecture documentation and the main `cex-order-book-replay-archive` Purpose to show `live exchange -> bounded top-N diagnostic levels + summary v2 -> ClickHouse hot` and to assign direct vendor-object cold reads and historical reconstruction to Maker/FIET-1015.
- [x] 9.4 Document that FIET-907 may consume FIET-1015 evidence and loader outputs but owns no sourcing, reconstruction, or historical CEX write.
- [x] 9.5 Document the three independent conformance boundaries: CEX-local Proof A, Maker-local Proof B, shared-wire sidecar Proof C, plus the separate summary-v2 fixture/query parity gate.
- [x] 9.6 Run formatting, linting, type checking, unit tests, integration tests, ClickHouse Local E2E, archive-forwarder image smoke, controlled production-compatible sidecar conformance, and—when available—the separately named optional public-network live smoke.

## 10. Prepare and verify the terminal deployed-schema migration

- [x] 10.1 Implement a read-only inventory command that reports external rows, current TTL expressions, mutations, vendor-only columns, and every obsolete table/view without changing deployed state.
- [x] 10.2 Write an operator runbook requiring stopped historical writers, deployed source rejection, backup/export location, maintenance approval, expected row/object counts, rollback limits, and an explicit destructive-operation approval.
- [x] 10.3 Implement a separately invoked migration that deletes `external_backfill` rows, waits for ClickHouse mutations, applies unconditional 90-day TTLs to both hot order-book tables, drops promotion/qualification/selection/cluster-identity tables and replay-qualified views, and drops vendor-only `capture_origin` columns.
- [x] 10.4 Add isolated-ClickHouse tests for precondition failures, interrupted mutations, idempotent rerun, exact TTLs, object absence, column absence, and proof that normal startup never executes the destructive migration.
- [x] **DEFERRED to separately governed operator rollout; not executed by this change:** 10.5 After explicit operator approval, inventory and back up the target deployment, execute the migration, wait for all mutations, and attach terminal absence evidence. (Operational rollout tracked separately; not an implementation-completion gate.)

## 11. Final cutover and release

- [x] 11.1 Confirm all known preparation-package and v1-summary consumers have migrated and that no compatibility exception or independent CEX Parquet consumer was discovered.
- [x] 11.2 Reserve `0.3.0` if unused or the next unused `0.3.x`, freeze the exact final commit, and verify that no rollback or cleanup intermediate has been published.
- [x] 11.3 Pack and audit the release, install it in a clean environment, run the archive-forwarder image/runtime-helper smoke gate, and assert the public package contains only broker-supported surfaces.
- [x] **DEFERRED to separately governed operator rollout; not executed by this change:** 11.4 Schedule the writer maintenance window, quiesce market archive writes, apply non-destructive v2 columns/views, deploy the v2-only writer, validate one bounded live observation and supported v2 query, then resume archival. (Operational rollout; not an implementation-completion gate.)
- [x] **DEFERRED to separately governed operator rollout; not executed by this change:** 11.5 Verify current snapshot and live ORDERBOOK subscription behavior, one archive decision per physical feed observation, metadata-only raw storage, top-N row bounds, v2 exact/censored evidence, and normal strategy delivery after cutover. (Post-deployment operational verification.)
- [x] **DEFERRED to separately governed operator rollout; not executed by this change:** 11.6 Configure post-cutover failure handling to stop ORDERBOOK archival and forward-fix the v2 path without reactivating v1, historical admission, preparation commands, or compatibility views. (Post-deployment operational verification.)
- [x] **DEFERRED to separately governed operator rollout; not executed by this change:** 11.7 Publish the final `0.3.x` only after explicit operator approval and the separately governed rollout/migration gates pass, then update release records with the exact commit and evidence digests. (Publication is not an implementation-completion gate.)
