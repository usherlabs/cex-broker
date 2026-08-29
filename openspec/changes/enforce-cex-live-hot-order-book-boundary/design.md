## Context

The current `develop` tree is merge `c81f60a`, whose first parent is `41dbe7c` and whose second-parent tree is `10f0811`. The merge contains seven intended archive-forwarder packaging and OKX correctness commits through `7db5916`, followed by ten Maker-preparation commits from `ae16314` through `10f0811`. A literal mainline merge revert would restore `41dbe7c`, remove the forwarder image packaging fix, and make a rebuilt `/archive` image unable to load all runtime helpers. The unwanted preparation series must therefore be reversed independently before the older vendor product is removed forward.

At runtime, the public-feed worker samples ORDERBOOK before archive delivery, but the archive path creates a raw event from the complete normalized upstream response and only then slices canonical level rows to the configured archive depth. Consequently the level table is bounded while `cex_stream_events.payload_json` is not. The current depth summary is calculated after the slice, uses best-side-relative band boundaries, and does not distinguish exact depth from a censored lower bound.

The current capture context carries one `schemaVersion` into raw, level, and summary rows. `raw_capture_id` hashes that version and the complete normalized payload checksum, while `snapshot_id` hashes the already retained-N bids and asks plus the same version. A summary-only semantic version bump therefore requires an explicit row-schema split; changing the shared context version would silently change stable raw and level identities.

Two OpenSpec authorities also conflict with the target. `cex-broker-order-book-depth-sourcing` still requires archived levels to reproduce Maker policy bands, and active change `complete-maker-preparation-output-contract` has 71 of 85 tasks complete while continuing to add preparation/export requirements to four capabilities this change removes. The sibling change must be preserved as historical work but never synchronized into main specs.

Maker's superseding hot/cold architecture queries the CEX-written ClickHouse hot layer directly and owns vendor-object cold reconstruction. FIET-907 may adopt the resulting evidence but does not source or backfill it. The only remaining cross-repository runtime wires owned jointly with CEX are live broker gRPC, durable `hb_runtime` strategy delivery, and the ClickHouse hot-summary schema.

## Goals / Non-Goals

**Goals:**

- Preserve current/live broker behavior and ordinary production archive delivery.
- Make every durable ORDERBOOK body structurally bounded while retaining sampled top-N analytical evidence.
- Author a closed, midpoint-relative summary `2.0.0` whose `exact|censored` status is sufficient for a downstream reader without inspecting raw bodies or level rows.
- Remove every CEX historical vendor, preparation, promotion, package, and export surface.
- Hard-cut runtime and supported queries to summary v2 without compatibility readers or aliases.
- Retain cross-repository conformance only for live gRPC and durable `hb_runtime` wires, and cover the hot-read schema through a separate stable fixture/query contract.
- Retire deployed vendor schema objects and retention exceptions through an explicit, terminal, separately approved operation.

**Non-Goals:**

- Implement Maker hot/cold selection, CryptoHFTData reconstruction, policy evaluation, or FIET-907 materialization.
- Change current snapshot or `Subscribe(ORDERBOOK)` response shapes.
- Remove unrelated legacy storage migrations, the generic `maker_replay` strategy ingestion path, logger/OTEL compatibility, or other compatibility not superseded here. The retained legacy order-book migration may emit bounded incomplete-provenance levels but may not emit any summary row.
- Pack ClickHouse levels into arrays or extend production retention beyond 90 days.
- Treat deterministic conformance as production soak evidence.

## Decisions

### 1. Specify the final CEX boundary before implementation

Create and approve this change while the old preparation change is still present, then make this change the sole authority for its removal. Before implementation, mark `complete-maker-preparation-output-contract` as superseded and remove it from the active change set without synchronizing its specs, such as an explicitly recorded `openspec archive --skip-specs` operation. Its remaining tasks, release steps, and unmerged ADDED/MODIFIED requirements are canceled. A normal archive that updates main specs is forbidden. Add a repository rule that a superseding internal contract deletes its old implementation, schemas, aliases, adapters, and readers unless an operator explicitly requests compatibility.

Alternative considered: continue or normally archive the existing preparation OpenSpec and mark its historical paths optional. Rejected because either path makes the obsolete CEX package and promotion boundary authoritative and can synchronize requirements this change does not inherit.

### 2. Reverse only the accidentally co-merged preparation series

Reverse the ten linear commits from `10f0811` back through and including `ae16314`, preserving merge `c81f60a` and the seven-commit tree through `7db5916`. The authoritative intermediate gate compares every non-governance path to tree `7db5916`; only this change, `AGENTS.md`, and approved task documentation may differ. No intermediate package is published.

Alternative considered: `git revert -m 1 c81f60a`. Rejected because it reverses 81 paths, deletes the image packaging smoke gate, and restores a Dockerfile that omits imported runtime helpers.

### 3. Close historical admission before deleting the producer

The forwarder accepts only deployment-controlled `broker_read` or `broker_write` market rows. It rejects `external_backfill` before generic routing, removes historical evidence tables from the supported inventory, and removes vendor health/authorization/preflight surfaces. Ordinary `/archive`, durable strategy spool behavior, retries, loss journaling, telemetry, and non-market feeds remain unchanged.

Closing admission first prevents an old external worker from continuing to write while the product is removed. Removal of a route or allowlist entry alone is insufficient because generic row parsing otherwise accepts arbitrary string sources.

### 4. Delete the complete historical preparation product

Delete vendor adapters, source-tape and required-clock operations, forensics, preparation commands and bins, package subpaths, schemas, policies, fixtures, release tooling, workflows, and product-only dependencies. Delete both the packaged and script-level canonical Parquet exporters and their replay validator. The latter has no independent CEX consumer: its retained use is the obsolete `native_replay` sidecar path.

The first seven commits are only an intermediate rollback target. The final CEX tree retains the archive-forwarder packaging/smoke effect from `0011cf4`; vendor streaming, sequence diagnostics, re-anchoring, failure attribution, and provider-object quarantine from the other six commits are deleted from CEX. Git history remains the audit source; Maker may independently port required behavior without a runtime or checkout dependency on CEX.

### 5. Separate live L2 coverage from persisted hot claim rights

The current/live broker projection remains level-based. An in-memory acquisition-profile snapshot may prove that a live band is covered when its observed edge reaches the midpoint-relative boundary or the adapter supplies explicit exhaustion evidence; CEX-local Proof A continues to validate that behavior. This does not grant the persisted ClickHouse level rows the same authority.

The archive computes summary v2 from the complete validated physical observation before slicing. It then persists no more than the configured archive top-N per side as diagnostics. The supported CEX query and fixture do not provide a level-derived fallback or upgrade mechanism. Maker owns its reader behavior and policy claims, but no supported CEX output represents archived levels as sufficient to reproduce a Maker position policy.

Alternative considered: keep the existing requirement that archive depth must meet Maker policy depth. Rejected because it couples a policy-neutral producer to one downstream policy and contradicts summary-first hot/cold sourcing.

### 6. Split stable capture identities from summary schema identity

The complete normalized upstream observation produces `raw_checksum` and `raw_capture_id` under capture schema `1.0.0`. `raw_capture_id` includes the complete-observation checksum, so changes below retained N remain distinguishable. The retained-N bid/ask slice produces `snapshot_id` under the same capture schema `1.0.0`, preserving the current level identity algorithm. Raw and level rows remain `schema_version = '1.0.0'`.

The linked summary row alone uses `schema_version = '2.0.0'`. Summary schema version MUST NOT enter `raw_capture_id` or `snapshot_id`. Raw, level, and summary rows agree on source, deployment, capture bundle, provider, `raw_capture_id`, and `raw_checksum`; level and summary rows additionally agree on `snapshot_id`. The row families do not agree on `schema_version` or `normalized_row_checksum`. `producer_id` and `producer_run_id` remain strategy-row concepts and never become market-row provenance.

Alternative considered: bump the shared capture context to `2.0.0` or hash the complete observation into a new snapshot identity. Rejected because both alter stable raw/level identities. Complete-observation distinction already belongs to `raw_capture_id`; retained canonical level identity belongs to `snapshot_id`.

### 7. Use a closed exact-or-censored summary-v2 schema

The worker passes a closed archive metadata object alongside the sampled snapshot: capture profile id, effective cadence, requested upstream depth, observed per-side counts, observed edge prices, and explicit exhaustion evidence when the venue adapter can prove it. The writer validates the complete observed snapshot, calculates summary bands, and then persists no more than the configured archive top-N levels per side.

Summary v2 uses midpoint-relative price boundaries. It records requested, observed, and retained depth/count boundaries and aligned per-side status for every configured band:

- `exact`: the observed boundary reaches the band or explicit venue evidence proves the side exhausted;
- `censored`: the observation ends inside the band without proven exhaustion, so the numeric depth is a lower bound.

Counts below a requested limit never prove exhaustion by themselves. Validated explicit exhaustion makes the affected band `exact`; it is not optional. Missing sides, missing or inconsistent boundary metadata, incomplete identity/provenance, invalid enums, misaligned arrays, and best-side-relative calculations reject the candidate instead of producing an `unknown` row. An unavailable interval is represented by absence from the supported v2 view.

The normative `cex-order-book-depth-summary-v2-conformance/v1` schema fixes every field name, order, type, nullability, and checksum input. It preserves the existing capture-core and top-of-book columns and adds `capture_profile_id`, `effective_cadence_ms`, nullable `requested_upstream_depth`, observed bid/ask counts and farthest prices, retained bid/ask farthest prices, explicit bid/ask exhaustion booleans, midpoint-relative bid/ask boundary-price arrays, bid/ask depth arrays, and bid/ask `exact|censored` status arrays. Existing `bid_level_count` and `ask_level_count` are the retained counts. `measurement_bands_bps` is one shared ascending array; both boundary arrays, both depth arrays, and both status arrays have the same length. Decimal fields use `Decimal(38,18)` and fixture/query projection renders them as canonical decimal strings.

The archive depth is deployment configuration `CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT`, default `25`, bounded to `1..500`. Measurement bands are normalized ascending unique configuration with default `[10,25,50,100]`. Every fixture case pins both values rather than inheriting process defaults.

`market_data.cex_order_book_depth_summary_canonical` is the supported summary view and `market_data.cex_order_book_depth_summary_conflicts` is its conflict evidence. Both retain the append-only logical key `(capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id, schema_version)` and filter to `broker_read|broker_write`, summary `2.0.0`, and complete provenance; the canonical view selects only checksum-consistent keys and excludes every key in the conflict view. The correspondingly named level canonical/conflict views filter to `broker_read|broker_write` and schema `1.0.0` but remain diagnostic surfaces using their established key with side and level index. Physical summary-v1 rows may age out under TTL but no application writer, reader, alias, fallback, canonical view, or conflict view consumes them.

Alternative considered: use selected level rows to repair a censored or missing summary. Rejected because levels are diagnostic-only after the cutover and optional rows must not grant claim rights absent from the summary contract.

### 8. Replace ORDERBOOK raw bodies with a closed fixed schema

For ORDERBOOK, the generic raw row uses `payload_encoding = 'orderbook_metadata_only_v1'`. Its canonical JSON contains exactly `capture_profile_id`, `effective_cadence_ms`, `requested_upstream_depth`, `archive_depth_limit`, `observed_bid_count`, `observed_ask_count`, `observed_farthest_bid`, `observed_farthest_ask`, `bid_exhausted`, `ask_exhausted`, `retained_bid_count`, `retained_ask_count`, and `measurement_bands_bps`. The requested upstream depth may be JSON `null` only when the acquisition profile has no explicit upstream limit; farthest prices are canonical decimal strings and all other keys are non-null. It contains no `bids`, `asks`, nested level arrays, provider body, extra key, or optional full-body representation.

The raw row's `raw_checksum` and `raw_capture_id` are computed first from the complete normalized upstream observation under capture schema `1.0.0`; `normalized_row_checksum` is separately computed over the bounded metadata row. Thus changing a discarded deep level changes raw identity without expanding stored JSON.

There is no opt-in full ORDERBOOK body mode. TICKER, TRADES, and OHLCV raw behavior remains unchanged.

### 9. Thin the sidecar to controlled shared-wire Proof C

The sidecar exposes only `production_compatible`. It proves:

1. Layer12 reaches the real broker current/live ORDERBOOK gRPC boundary;
2. Maker and the collector can share one physical feed while producing one archive decision;
3. an `hb_runtime` ArchiveEmitter batch receives HTTP 202 only after durable spool admission; and
4. the spool drains the expected rows into the five strategy tables with exact producer/run identities.

Retain the existing non-interactive `up|ready|verify|down` verbs and exit-code contract. `up` accepts only `production_compatible`; an invocation with `native_replay` fails as invalid. The manifest and verification result advance to v2 and have no v1 decoder. Remove the `native_replay` profile, `maker_replay` sidecar branch, reference-export path, Parquet descriptors, FIET-907 loader assertion, `parquetOwnership`, synchronous-200 native result, and native profile commands. Retain resolved CEX and Maker commit identities and the downstream wire-test result, but replace PR-number ancestry and policy-proof requirements with a current, hash-bound shared-wire fixture/test identity.

Proof C uses a deterministic controlled/local fixture venue while traversing the real broker handlers, acquisition-profile resolver, collector, forwarder, spool, and ClickHouse schema. “Real broker” identifies production code paths, not an external public venue. Any public-network market smoke is a separate optional, non-gating job and is never Proof C evidence.

CEX Proof C is sufficient for the sidecar. CEX feed/coalescing Proof A remains a CEX-local regression and Maker policy-equivalence Proof B remains Maker-owned; neither is a sidecar pass condition. A dual-repository checkout is allowed for development conformance, but production thesis materialization cannot require a CEX checkout, package, executable, or sidecar.

### 10. Test hot-summary parity with a canonical typed fixture, not Parquet

Publish `cex-order-book-depth-summary-v2-conformance/v1`, a secret-free fixture containing normalized input snapshots and capture metadata plus expected summary-v2 rows, supported-view query projections, checksums, and rejection outcomes. It covers exact, censored, explicitly exhausted, asymmetric non-empty, truncated, duplicate, conflicting, incomplete-provenance, malformed, empty-bid, empty-ask, and both-empty cases.

CEX tests prove canonical writer/checksum material exactly and compare real ClickHouse output through a canonical typed projection: `Decimal(38,18)` values become normalized decimal strings, integer and enum values remain exact, arrays retain their specified order, and rows use the fixture's canonical ordering. Raw database-driver bytes are not a contract. A downstream repository may pin/copy the fixture and its SHA-256 for its own reader tests or run an optional cross-repository SQL compatibility job. Neither mechanism is a runtime dependency, and the core sidecar does not need to execute Maker's hot reader.

### 11. Keep legacy migration non-authoritative and retire historical schema terminally

The retained `legacy_migration_v1` order-book tool may convert old snapshots into bounded capture-schema-v1 level rows with honest incomplete provenance. It MUST NOT invoke the summary-v2 writer, emit a summary-v1 row, fabricate required v2 capture metadata, or make the migrated interval visible through the supported summary view. Existing legacy summary rows remain inert physical evidence. This keeps the unrelated bounded migration without creating an exception to the v2-only summary cutover.

Fresh-install DDL stops creating vendor evidence tables, cluster identity, replay-qualified views, external source defaults, and TTL exceptions. Automatic startup schema does not execute destructive deletes, drops, or TTL mutations against existing deployments.

After read-only inventory and backup, a separately approved operator migration:

1. confirms all historical writers are stopped and external admission is deployed;
2. exports required audit rows;
3. deletes `source = 'external_backfill'` rows and waits for mutations;
4. installs unconditional 90-day TTL on both hot order-book tables;
5. drops promotion, qualification, archive-selection, cluster-identity tables and both replay-qualified views; and
6. drops vendor-only `capture_origin` columns.

The operation is terminal: success requires those rows and objects to be absent, not deprecated.

### 12. Release only the final cutover

No rollback or cleanup intermediate is published. After all code and schema gates pass, reserve `0.3.0` if unused or the next unused `0.3.x`, freeze the exact commit, pack/audit it, and publish only the broker-supported surface.

The production writer cutover uses a maintenance window: quiesce market archive writes, apply non-destructive v2 columns and view definitions, deploy the v2-only writer, validate one bounded live capture, and resume. A post-cutover failure stops ORDERBOOK archival and requires a forward fix; it does not reactivate v1 or the historical product.

## Risks / Trade-offs

- **[Old consumers still invoke the preparation package]** → Inventory consumers before release and block deployment until owners move; do not retain an adapter or package alias.
- **[The superseded sibling change is archived normally]** → Record supersession and remove it from the active set without spec synchronization; validate that none of its ADDED requirements entered main specs.
- **[Partial rollback removes the forwarder packaging fix]** → Gate the intermediate non-governance tree against `7db5916` and require the image smoke test.
- **[A mislabeled v2 row receives ClickHouse defaults]** → Validate every v2 field in the writer and forwarder before insertion; supported views require v2 and complete provenance.
- **[Summary version changes stable capture identity]** → Keep raw/level capture schema `1.0.0`, compute their identities before stamping the linked summary `2.0.0`, and pin both algorithms in the fixture.
- **[V1 hot history becomes unavailable before TTL expiry]** → Treat it as unsupported physical audit data; downstream sourcing classifies the v2 pre-cutover interval as unavailable rather than reading v1.
- **[TTL normalization deletes historical external rows]** → Keep it out of startup schema, export evidence first, require explicit operator approval, and wait for ClickHouse mutations.
- **[Thinning sidecar loses policy confidence]** → Keep CEX Proof A and Maker Proof B in their owning regression suites; use the sidecar only to prove shared transport/storage wires.
- **[Summary-only evidence cannot answer arbitrary future bands]** → Retain bounded policy-neutral levels for analytics, but require a future explicit schema change rather than repairing current claim rights.

## Migration Plan

1. Merge the governance/specification change, record `complete-maker-preparation-output-contract` as superseded, remove it from the active set without synchronizing its specs, and correct CEX-relevant TASK-60 records.
2. Reverse the inclusive preparation commit series and prove the `7db5916` intermediate tree plus image health.
3. Deploy explicit historical-source rejection and remove forwarder historical admission.
4. Delete the preparation product, exporters, native sidecar profile, active docs/specs, and package assets.
5. Land and validate the split capture/summary identities, closed exact-or-censored summary v2, metadata-only ORDERBOOK raw schema, retained-N diagnostics, supported v2 views, and canonical typed fixture.
6. Stop legacy migration from emitting summaries and run full current/live, container, archive, ClickHouse, strategy-wire, controlled-sidecar, and optional public-smoke verification.
7. Inventory and back up deployed historical objects, then execute and verify the separately approved terminal schema migration.
8. Freeze, pack, audit, and publish the final `0.3.x` release; perform the maintenance-window v2 writer cutover and bounded live validation.

## Open Questions

None. The implementation must stop and return to specification review if current `origin/develop` no longer contains merge `c81f60a` with the audited commit topology, or if a named independent CEX consumer of a removal surface is discovered.
