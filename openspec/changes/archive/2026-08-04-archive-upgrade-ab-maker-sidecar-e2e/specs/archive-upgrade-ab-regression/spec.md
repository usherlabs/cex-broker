## ADDED Requirements

### Requirement: The upgrade control is a clean pinned CEX Broker develop export

The A/B upgrade fixture SHALL be generated from a clean checkout of the authoritative CEX Broker `develop` branch, never from `ed/cute-taxes-cheat-jnrod`, the integrated candidate, or another feature branch. The committed fixture MUST record the resolved `develop` commit, branch name, `package.json` version from that commit, source DDL, deterministic data, table inventory, generator command, tool versions, comparison projections, and SHA-256 hashes of all source and input artifacts. At proposal time the verified `develop` resolution is `7a83de5f29a08f42d81f64a75a83bc9318dce94a` and its package version is `0.2.38`.

#### Scenario: Upgrade fixture is generated
- **WHEN** the explicit regeneration command runs
- **THEN** it MUST reject a dirty source checkout or a source ref that is not the resolved `develop` baseline
- **AND** its recorded package version MUST equal the version read from the resolved commit and it MUST record enough immutable provenance to reproduce every pre-upgrade table and row without historical code execution in normal CI

#### Scenario: Normal upgrade CI runs
- **WHEN** the A/B suite loads the committed baseline
- **THEN** it MUST NOT fetch a floating branch or execute the current feature branch as the A-side
- **AND** it MUST fail when the fixture's DDL, data, hashes, projections, or recorded commit are incomplete

#### Scenario: Develop has advanced since proposal
- **WHEN** reviewers intentionally replace the proposal-time baseline with a later `develop` resolution
- **THEN** regeneration MUST update the resolved commit and all affected provenance in one reviewed change
- **AND** an implicit expectation update or unreviewed generated diff MUST fail verification

### Requirement: A and B begin as identical isolated pre-upgrade databases

The required A/B harness SHALL start two isolated ClickHouse Server 24.8 instances and initialize each from the exact same committed `develop` DDL and deterministic data export. Instance A MUST remain the pre-upgrade control; only instance B may receive candidate schemas, migration writes, or upgraded producer rows.

#### Scenario: A/B initialization completes
- **WHEN** both database instances report ready
- **THEN** every baseline table projection, row count, and deterministic value in A MUST exactly equal B before upgrade
- **AND** the harness MUST record the ClickHouse image/version and distinct endpoints without exposing secrets

#### Scenario: Initial databases differ
- **WHEN** any pre-upgrade DDL digest, table inventory, projected row, null value, or cardinality differs between A and B
- **THEN** the upgrade test MUST fail before applying candidate schema or migration
- **AND** it MUST identify the first differing database/table/projection

### Requirement: B executes the production canonical migration idempotently

The B-side upgrade SHALL use the current production schema manifest, `scripts/migrate-legacy-market-data-to-canonical.ts`, and the operator phase/parity contract in `schema/clickhouse/migrations/canonical_market_data_replay_cutover.sql`. The fixture MUST define one safe-integer half-open window `[start_time_ms, end_time_ms)` where start is the minimum of all baseline `orderbook_snapshots.event_time_ms` and `candles.open_time_ms` values and end is the maximum plus one millisecond. The write phase MUST set `CEX_BROKER_CANONICAL_MIGRATION_CONFIRM=true`, pass those values through `CEX_BROKER_MIGRATION_START_TIME_MS` and `CEX_BROKER_MIGRATION_END_TIME_MS`, target B, and bind the same values to every cutover SQL parameter. Schema initialization and the confirmed migration MUST each run at least twice, with no legacy table drops, runtime dual-write selector, or fixture-only migration substitute.

#### Scenario: First B migration runs
- **WHEN** the candidate schema and migration are applied to B
- **THEN** legacy candles and order-book snapshots MUST remain readable and their corresponding canonical rows MUST be created according to the production migration
- **AND** the migration summary MUST report `mode=write`, the fixture's expected non-zero legacy book and candle counts, and the expected non-zero canonical row count before parameter-bound cutover checks execute against the real server

#### Scenario: Migration is repeated
- **WHEN** schema initialization and the same migration are run again against the migrated B instance
- **THEN** canonical logical row counts, checksums, provenance classifications, and conflict results MUST remain stable
- **AND** the rerun MUST again report confirmed write mode and expected inputs while creating no additional canonical logical value for an already migrated legacy key

#### Scenario: Required write mode or window is absent
- **WHEN** the migration reports `mode=dry_run`, omits either bounded window variable, uses a window different from the committed fixture, produces zero source/canonical rows where the fixture expects rows, or parity queries receive different parameters
- **THEN** the one-time A/B acceptance MUST fail
- **AND** no dry-run or ad hoc query result may be represented as migration evidence

#### Scenario: Migration or parity command is bypassed
- **WHEN** the harness initializes only the latest schema and inserts fixture-shaped canonical rows directly
- **THEN** the run MUST NOT qualify as A/B upgrade evidence
- **AND** the acceptance command MUST fail the missing production migration phase

### Requirement: Legacy data remains exactly compatible across the upgrade

After migration, every committed legacy projection and cardinality in B SHALL exactly match the unchanged A control. Additive columns and canonical rows MUST NOT hide a changed, missing, or duplicated legacy value.

#### Scenario: Legacy A/B comparison passes
- **WHEN** B migration finishes
- **THEN** ordered projected values, nullable fields, arrays, payload strings, and row counts for every baseline table MUST equal A
- **AND** A MUST still equal its pre-test digest and counts

#### Scenario: Legacy data changes during upgrade
- **WHEN** any B legacy projected value changes, a baseline row disappears, or an extra legacy row appears within the fixture identity
- **THEN** the A/B suite MUST fail even if canonical parity queries otherwise report success
- **AND** the differing table and stable key MUST be reported

### Requirement: Migrated canonical rows preserve honest incomplete provenance

Rows produced from legacy candles and order-book snapshots SHALL carry `source_mode=legacy_migration_v1`, `provenance_complete=0`, and honest null capture-bundle, raw-capture, and raw-checksum fields where the historical source lacks that evidence. The migration MUST NOT synthesize bundle, raw-event, provider, or credential provenance.

#### Scenario: Migrated rows are inspected
- **WHEN** canonical OHLCV, order-book level, and depth-summary rows derived from the baseline are queried
- **THEN** their normalized values and checksums MUST satisfy the versioned migration projection
- **AND** incomplete provenance fields MUST remain explicitly incomplete under the migration source mode

#### Scenario: Migration invents provenance
- **WHEN** a migrated row claims a production capture bundle, raw capture linkage, raw checksum, or other provenance absent from the legacy row
- **THEN** the A/B suite MUST fail
- **AND** cutover MUST remain blocked

### Requirement: Migration parity and conflict checks gate cutover

All migration parity queries SHALL report zero missing or mismatched logical rows, and the canonical order-book conflict views SHALL contain no key created by the deterministic baseline migration. Any mismatch or conflict MUST block candidate cutover without dropping either legacy or canonical evidence.

#### Scenario: Parity is clean
- **WHEN** the production cutover queries execute after the second migration run
- **THEN** every required mismatch count MUST be zero and the expected canonical views MUST return stable rows
- **AND** the result set and query/source hashes MUST be recorded in the evidence manifest

#### Scenario: Parity or conflict fails
- **WHEN** a parity count is non-zero or a deterministic migrated key appears in a conflict view
- **THEN** the job MUST fail before upgraded producer release
- **AND** both databases and bounded diagnostics MUST remain available for failure artifact collection

### Requirement: The upgraded B producer writes canonical tables only

After migration gates pass, the harness SHALL start the integrated upgraded broker and independent collector against B, release deterministic public feed frames, and use the production forwarder and ClickHouse HTTP client. New ORDERBOOK and OHLCV data MUST target the latest canonical inventory only; the A control and B legacy tables MUST receive no row for the upgraded run identity.

#### Scenario: Upgraded frames are released
- **WHEN** ORDERBOOK, TICKER, TRADES, and OHLCV frames traverse the post-upgrade broker/collector/archive lifecycle on B
- **THEN** linked raw and normalized rows MUST be queryable from the canonical inventory with complete production capture provenance
- **AND** no run-identity row may be written to `market_data.orderbook_snapshots` or `market_data.candles`

#### Scenario: Control is checked after candidate production
- **WHEN** upgraded B capture completes
- **THEN** A table digests and counts MUST remain unchanged
- **AND** B's historical legacy projections MUST still equal A while its canonical tables contain the separately identified migrated and new-production rows

### Requirement: Real ClickHouse A/B is one-time acceptance evidence for this upgrade

The repository SHALL expose `bun run test:acceptance:archive-upgrade` as the documented, rerunnable ClickHouse Server 24.8 command, and the suite SHALL run it once against the final candidate using the production `@clickhouse/client` path and network interface. Its successful manifest MUST be retained with this change's release evidence before sync/archive. It SHALL NOT be normalized into ordinary pull-request CI; the standard archive E2E and existing integration suite remain the ongoing CI contract. A future specification MAY generalize upgrade regressions across arbitrary version pairs and then define a reusable CI job.

#### Scenario: Final candidate is accepted
- **WHEN** `bun run test:acceptance:archive-upgrade` runs against the recorded baseline and final candidate
- **THEN** it MUST initialize both servers, migrate B twice in confirmed write mode, compare A/B, run parameter-bound parity/conflict checks, and exercise upgraded writes
- **AND** its manifest MUST record baseline commit/version, candidate commit, exact invocation, fixture and query hashes, ClickHouse version, migration summaries, and all assertion results

#### Scenario: One-time acceptance is missing or failed
- **WHEN** Server 24.8 is unavailable, no A/B test is discovered, the runner skips a phase, or any assertion fails
- **THEN** this upgrade MUST remain unaccepted and the associated OpenSpec change MUST not be synced or archived
- **AND** standard CI success MUST NOT substitute for the missing acceptance artifact

#### Scenario: Ordinary CI runs after acceptance
- **WHEN** later pull requests execute the repository's standard CI matrix
- **THEN** CI MUST run the normal archive E2E and existing integration tests without recreating this fixed pre/post upgrade run
- **AND** the A/B runner may enter CI only through a future generalized upgrade-regression contract rather than a path filter tied to this change

### Requirement: Failed cutover is non-destructive and recoverable

The upgrade harness and operator documentation SHALL retain legacy tables and canonical evidence on failure. Automated rollback MUST NOT drop or rewrite either dataset; a prior broker may be redeployed only while its legacy schema is still available and the failed candidate remains quiesced.

#### Scenario: Upgrade gate fails
- **WHEN** schema application, migration, parity, conflict, or upgraded producer verification fails
- **THEN** the harness MUST stop candidate writes and preserve A/B failure evidence for bounded artifact collection
- **AND** it MUST not perform a destructive database rollback

#### Scenario: Operator resumes after correction
- **WHEN** a corrected candidate is tested against a fresh pair of databases initialized from the same committed baseline
- **THEN** it MUST rerun the entire A/B sequence rather than reuse a partially accepted result
- **AND** the new candidate commit and result hashes MUST be recorded independently
