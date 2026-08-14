# archive-e2e-regression

## Purpose

The archive E2E regression capability SHALL preserve historical storage compatibility and prove the canonical public-market-data lifecycle, integrity, failure isolation, and CI behavior against a mandatory pinned ClickHouse Local runtime, while keeping live CEX validation credentialless, public-only, and non-gating.

## Requirements

### Requirement: The archive E2E suite uses a mandatory pinned ClickHouse Local runtime
The system SHALL run archive E2E storage assertions with the standard ClickHouse binary in local mode at exactly `v25.8.24.21-lts`, using checksum-pinned official artifacts and a unique persistent `--path` directory for each harness instance. The suite MUST execute the production archive schema files, serialize all commands for one path, and MUST NOT silently skip because the runtime, schema, or tests are unavailable.

#### Scenario: Verified cached binary is available
- **WHEN** `test:e2e:archive` finds a cached or explicitly configured ClickHouse binary whose digest and reported version match the committed pin
- **THEN** it MUST use that binary in local mode for every schema, insert, and query operation
- **AND** all operations for one persistent path MUST be serialized

#### Scenario: No verified binary is initially available
- **WHEN** `test:e2e:archive` cannot find a verified cached or configured binary
- **THEN** its bootstrap MUST obtain the architecture-appropriate official artifact and verify it against a digest committed in the repository
- **AND** download, checksum, extraction, executable, platform, or exact-version failure MUST fail the command

#### Scenario: Archive schema initialization fails
- **WHEN** any production archive schema file is missing, excluded from the production manifest, or rejected by ClickHouse Local
- **THEN** the E2E command MUST fail before reporting any lifecycle assertion as passing
- **AND** the failure MUST identify the schema file or statement that could not be applied

#### Scenario: Harness execution finishes
- **WHEN** a harness completes, fails an assertion, or is aborted by test cleanup
- **THEN** it MUST stop owned processes and remove its temporary persistent data directory
- **AND** cleanup MUST be idempotent

### Requirement: The pre-canonical compatibility baseline is immutable and reproducible
The system SHALL retain a versioned golden fixture derived from a clean checkout of `64fdf0607a234be05bac98f3edd3125e2c05d083` and SHALL record its runtime-equivalent parent. This historical compatibility fixture is distinct from the `develop`-derived one-time A/B upgrade fixture and MUST contain sufficient provenance and deterministic expectations to detect a changed legacy row without executing historical code during normal CI.

#### Scenario: Historical baseline fixture is generated
- **WHEN** the explicit baseline-regeneration command runs against the clean baseline commit
- **THEN** it MUST record the baseline commit, runtime-equivalent parent, fixture schema version, generation command, exact 15-table inventory, and SHA-256 hashes of every source, schema, and input fixture used
- **AND** it MUST record deterministic inputs, explicit projected field names and types, comparison keys, sort order, and expected rows for every baseline table

#### Scenario: Normal E2E uses the historical baseline
- **WHEN** `test:e2e:archive` runs in a shallow or offline checkout
- **THEN** it MUST consume the committed fixture without fetching, checking out, or executing the historical commit
- **AND** it MUST compare fixed timestamps, identifiers, nullable values, arrays, and payload strings rather than omitting nondeterministic-looking fields

#### Scenario: Regeneration reproduces the current historical baseline
- **WHEN** the approved regeneration command is run twice with the same commit, inputs, tool versions, and environment
- **THEN** it MUST produce byte-equivalent semantic fixture content
- **AND** an uncommitted generated difference MUST fail the fixture verification command rather than update expectations implicitly

#### Scenario: A historical baseline revision is proposed
- **WHEN** an intentional legacy compatibility change requires new expectations
- **THEN** regeneration MUST require an explicit replacement baseline commit and review of the provenance and row differences
- **AND** the baseline MUST NOT change as part of an unrelated canonical addition, A/B fixture generation, or test repair

### Requirement: Every pre-canonical forwarder table remains compatible through its actual ownership path
The archive E2E suite SHALL cover exactly these 15 historical tables: `market_data.candles`, `market_data.orderbook_snapshots`, `market_data.cex_stream_events`, `market_data.cex_ticker_events`, `market_data.cex_trades`, `broker_execution.order_events`, `broker_execution.market_metadata_snapshots`, `broker_execution.transfer_events`, `broker_execution.fill_events`, `broker_account.balance_snapshots`, `strategy_data.policy_evaluation_events`, `strategy_data.strategy_policy_snapshots`, `strategy_data.market_identity`, `strategy_data.symbol_mapping`, and `strategy_data.inventory_settlement_events`. Every table MUST traverse the production HTTP parser, allowlist, source validation, batching, schema, and query-back path, while direct and durable strategy ownership remain distinct.

#### Scenario: Baseline table inventory is checked
- **WHEN** the suite loads the committed baseline fixture
- **THEN** its table set MUST equal `market_data.candles`, `market_data.orderbook_snapshots`, `market_data.cex_stream_events`, `market_data.cex_ticker_events`, `market_data.cex_trades`, `broker_execution.order_events`, `broker_execution.market_metadata_snapshots`, `broker_execution.transfer_events`, `broker_execution.fill_events`, `broker_account.balance_snapshots`, `strategy_data.policy_evaluation_events`, `strategy_data.strategy_policy_snapshots`, `strategy_data.market_identity`, `strategy_data.symbol_mapping`, and `strategy_data.inventory_settlement_events`
- **AND** a missing, renamed, or unsupported baseline table MUST fail the suite

#### Scenario: Ten non-strategy baseline tables are archived
- **WHEN** fixture batches for the five market, four execution, and one account table are posted to the production endpoint
- **THEN** each valid batch MUST use the synchronous direct-insert path and return HTTP 200 only after the Local inserter adapter succeeds
- **AND** ordered queries MUST return the exact expected projected multiset for every target table

#### Scenario: Five historical strategy tables are archived
- **WHEN** the fixture's `source=hb_runtime` batches for the five strategy tables are posted with a unique writable SQLite spool and active worker
- **THEN** each valid batch MUST return HTTP 202 after durable admission rather than synchronous inserter success
- **AND** the suite MUST wait for explicit spool drainage before ordered queries compare the exact expected projected rows

#### Scenario: Envelope and row sources disagree
- **WHEN** a fixture-driven HTTP batch has an envelope source that differs from a row source
- **THEN** the production forwarder path MUST reject the inconsistent batch before direct insertion or spool admission
- **AND** ClickHouse Local MUST contain no row from the rejected batch

#### Scenario: Current schemas add columns
- **WHEN** a baseline table has additive post-baseline columns
- **THEN** the comparison MUST use the fixture's explicit legacy-column projection
- **AND** every projected value and legacy row cardinality MUST still match exactly

#### Scenario: Legacy data is changed or duplicated
- **WHEN** a projected baseline value changes, a baseline row is missing, or an extra legacy row appears within the fixture's test identity
- **THEN** the suite MUST fail even if canonical tables contain otherwise valid additive rows

### Requirement: All four public feeds traverse the complete integrated archive lifecycle
The archive E2E suite SHALL drive deterministic ORDERBOOK, TICKER, TRADES, and OHLCV frames through a controlled fake `Exchange`, the normal broker gRPC server and Subscribe handler, the production multi-feed gRPC Subscribe client implemented by `MarketDataCollector`, the production archive writer and `node:http` transport, the production HTTP forwarder handler and router, and the ClickHouse Local adapter. `OhlcvCollector` MUST remain a compatibility value alias rather than the canonical E2E type. A research watcher, fake gRPC service, or path bypassing the production HTTP handler SHALL NOT satisfy this requirement.

#### Scenario: Deterministic archive configuration is provisioned
- **WHEN** the lifecycle harness prepares to start before releasing any fake-exchange frame
- **THEN** it MUST set `CEX_BROKER_ARCHIVE_ENABLED=true`, `CEX_BROKER_MARKET_ARCHIVE_ENABLED=true`, `CEX_BROKER_ARCHIVE_SOURCE=broker_read`, and `CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT=production`, provision a unique writable `CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH`, local `CEX_BROKER_ARCHIVE_FORWARDER_URL`, and fixed non-empty `CEX_BROKER_DEPLOYMENT_ID` and `CEX_BROKER_CAPTURE_BUNDLE_ID`
- **AND** it MUST either disable archive authentication at both ends or give `CEX_BROKER_ARCHIVE_FORWARDER_TOKEN` and `ARCHIVE_FORWARDER_TOKEN` the same fixed value
- **AND** missing or inconsistent setup MUST fail before any frame is released or lifecycle assertion is reported as passing

#### Scenario: Multi-feed lifecycle starts
- **WHEN** the test configures one deterministic exchange, pair, capture bundle, and all four public feed subscriptions
- **THEN** `MarketDataCollector` MUST open four gRPC Subscribe streams against a server created through normal production wiring
- **AND** the server MUST obtain frames from the injected controlled fake exchange through the real Subscribe handler

#### Scenario: Deterministic frames are released
- **WHEN** the fake exchange releases the fixed ORDERBOOK, TICKER, TRADES, and OHLCV payloads
- **THEN** the collector MUST observe a valid response for every feed and the writer MUST send archive rows through its real queue, batching, and HTTP transport
- **AND** the test MUST use explicit subscription, frame, flush, spool, and query barriers rather than arbitrary sleeps

#### Scenario: Core broker has no archive configuration
- **WHEN** the normal full broker starts outside the E2E composition without archive configuration
- **THEN** gRPC construction and service registration MUST succeed and archival behavior MUST remain disabled
- **AND** the E2E configuration contract MUST NOT become a production broker startup requirement

#### Scenario: Lifecycle rows reach storage
- **WHEN** the writer reports successful forwarding for the deterministic lifecycle
- **THEN** ClickHouse Local queries MUST find the expected feed-specific rows under the fixed deployment and capture identity
- **AND** the test MUST wait on explicit frame, flush, and query barriers rather than arbitrary sleeps

#### Scenario: Removed archive and credential configuration remains absent
- **WHEN** the suite audits executable production code, test support, scripts, workflows, and operational configuration
- **THEN** no path may read, set, or branch on `CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE`, `CEX_BROKER_CREDENTIAL_SOURCE_POLICY`, `CEX_BROKER_PROVISIONED_CREDENTIAL_PROFILE`, `CEX_BROKER_CREDENTIAL_ATTESTATION_KIND`, or `CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE`
- **AND** server and handler wiring MUST NOT accept an equivalent credential-policy, profile, permission-attestation, or market write-mode object

### Requirement: Canonical lifecycle output is restricted to the closed inventory
Raw captures SHALL use `market_data.cex_stream_events`; normalized ticker and trade rows SHALL use `market_data.cex_ticker_events` and `market_data.cex_trades`; and post-baseline normalized rows SHALL use only `market_data.cex_ohlcv`, `market_data.cex_order_book_levels`, and `market_data.cex_order_book_depth_summary`. View assertions MUST use `market_data.cex_ohlcv_closed`, `market_data.cex_order_book_levels_canonical`, `market_data.cex_order_book_levels_conflicts`, `market_data.cex_order_book_depth_summary_canonical`, and `market_data.cex_order_book_depth_summary_conflicts`.

#### Scenario: Canonical inventory is checked
- **WHEN** the suite compares the integrated forwarder and schema with the pre-canonical 15-table inventory
- **THEN** the post-baseline supported base tables MUST be exactly `market_data.cex_ohlcv`, `market_data.cex_order_book_levels`, and `market_data.cex_order_book_depth_summary`
- **AND** every named canonical and conflict view MUST execute against its corresponding base table

#### Scenario: Canonical output is evaluated
- **WHEN** canonical-only lifecycle output is queried
- **THEN** additive rows MUST be classified by the named raw or normalized destination and the lifecycle identity
- **AND** an unexpected table, view substitution, or unclassified extra row MUST fail the suite rather than be accepted as arbitrary additive output

### Requirement: The upgraded lifecycle remains canonical-only
The composed upgraded producer SHALL emit only the latest canonical archive inventory. Historical compatibility SHALL be verified independently through committed HTTP fixtures and MUST NOT rely on current producer output. No production, E2E, smoke, or migration path may provide a runtime legacy/dual/canonical write selector.

#### Scenario: Current producer archives ORDERBOOK and OHLCV
- **WHEN** the deterministic ORDERBOOK and OHLCV frames traverse the upgraded runtime
- **THEN** ORDERBOOK MUST write raw stream, canonical level, and canonical depth-summary rows and OHLCV MUST write raw stream and `market_data.cex_ohlcv` rows
- **AND** the lifecycle MUST write no `market_data.orderbook_snapshots` or `market_data.candles` row for its identity

#### Scenario: Historical market rows are checked
- **WHEN** pre-canonical ORDERBOOK, TICKER, TRADES, OHLCV, and raw-stream fixture rows are tested
- **THEN** they MUST traverse the production HTTP parser, source validation, router, schema, inserter, and query-back path
- **AND** their exact compatibility MUST NOT depend on current producer output or a runtime write-mode switch

#### Scenario: A runtime write-mode branch is introduced
- **WHEN** executable production, E2E, or smoke code adds a legacy/dual/canonical selector or conditionally emits legacy rows from the upgraded producer
- **THEN** the regression suite MUST fail
- **AND** setting an unrecognized removed variable MUST NOT be treated as a supported way to alter canonical output

### Requirement: Canonical-only capture proves stored linkage, provenance, and checksums
The canonical integrity lifecycle SHALL set `CEX_BROKER_ARCHIVE_SOURCE=broker_read`. Every public feed MUST store a raw capture in `market_data.cex_stream_events` linked to its normalized output in the closed canonical inventory, and the suite MUST verify integrity from queried storage values rather than trusting only producer-side objects. Source MUST remain deployment-controlled provenance and MUST NOT be inferred from credentials, TEE state, provider, or feed type.

#### Scenario: Canonical ORDERBOOK is stored
- **WHEN** a deterministic ORDERBOOK frame is archived by the upgraded writer
- **THEN** one `market_data.cex_stream_events` raw capture, `market_data.cex_order_book_levels` rows, and one `market_data.cex_order_book_depth_summary` row MUST share the fixed capture bundle, raw capture, snapshot, provider, exchange, pair, schema, and source identities
- **AND** the lifecycle MUST write no legacy `orderbook_snapshots` row for that identity

#### Scenario: Canonical TICKER, TRADES, and OHLCV are stored
- **WHEN** deterministic TICKER, TRADES, and OHLCV frames are archived by the upgraded writer
- **THEN** rows in `market_data.cex_ticker_events`, `market_data.cex_trades`, and `market_data.cex_ohlcv` MUST link to their corresponding `market_data.cex_stream_events` raw rows and carry `broker_read`, capture bundle, provider, source mode, schema version, and source/received time provenance
- **AND** the lifecycle MUST write no legacy `candles` row for that identity

#### Scenario: Canonical lifecycle retains one raw capture per feed identity
- **WHEN** the deterministic lifecycle archives accepted ORDERBOOK, TICKER, TRADES, and OHLCV frames
- **THEN** `market_data.cex_stream_events` MUST contain at least one raw row for each of the four feed identities under the fixed capture bundle
- **AND** every normalized row MUST reference the corresponding raw row's `capture_bundle_id` and `raw_capture_id`

#### Scenario: Stored checksums are verified
- **WHEN** TypeScript and Python verifiers project queried raw and normalized rows
- **THEN** both MUST recompute every checksum from the same versioned stored-value contract, decimal normalization, field order, and algorithm version
- **AND** recomputed values MUST equal stored checksum fields

#### Scenario: Canonical views are queried
- **WHEN** the lifecycle has no checksum conflict
- **THEN** `market_data.cex_order_book_levels_canonical`, `market_data.cex_order_book_depth_summary_canonical`, and `market_data.cex_ohlcv_closed` MUST expose the expected logical rows with their stored provenance intact
- **AND** `market_data.cex_order_book_levels_conflicts` and `market_data.cex_order_book_depth_summary_conflicts` MUST be empty for the lifecycle identity

### Requirement: Duplicate and checksum-conflict behavior remains auditable
The archive E2E suite SHALL verify physical evidence, canonical deduplication, same-request rejection, and cross-batch conflict visibility for each of `market_data.cex_order_book_levels` and `market_data.cex_order_book_depth_summary` using their corresponding canonical and conflict views. The level logical key SHALL be `(capture_bundle_id, exchange, trading_pair, raw_capture_id, snapshot_id, schema_version, side, level_index)`, and the summary logical key SHALL use the same fields except `side` and `level_index`. The suite MUST NOT infer the same rejection semantics for raw, ticker, trade, or OHLCV tables.

#### Scenario: Identical delivery is repeated across batches
- **WHEN** the same order-book level or depth-summary logical key and checksum are delivered in two accepted HTTP batches
- **THEN** both physical deliveries MUST remain queryable in the append-only evidence table
- **AND** the corresponding `market_data.cex_order_book_levels_canonical` or `market_data.cex_order_book_depth_summary_canonical` view MUST expose one logical row

#### Scenario: Same batch contains conflicting checksums
- **WHEN** one HTTP archive request contains the same order-book level or depth-summary logical key with different normalized checksums
- **THEN** the production request handler MUST reject the entire request before insertion
- **AND** the forwarder MUST persist zero rows from every table represented in that request

#### Scenario: Different batches contain conflicting checksums
- **WHEN** accepted batches reuse one order-book level or depth-summary logical key with different normalized checksums
- **THEN** both physical values MUST remain queryable and the corresponding `market_data.cex_order_book_levels_conflicts` or `market_data.cex_order_book_depth_summary_conflicts` view MUST expose the logical key and distinct checksums
- **AND** the corresponding canonical view MUST exclude the conflicted key

### Requirement: Strategy fixtures use their actual acknowledgement and persistence contracts

The suite SHALL use a real temporary SQLite spool and worker for `hb_runtime` and the synchronous direct path for `maker_replay`. It MUST distinguish durable admission from ClickHouse delivery and MUST NOT turn live-runtime batches into immediate synchronous inserter success.

#### Scenario: Live-runtime strategy fixture is admitted
- **WHEN** a conforming `hb_runtime` fixture is posted
- **THEN** the endpoint MUST return HTTP 202 after SQLite admission without waiting for ClickHouse
- **AND** the suite MUST wait for explicit drainage and query all expected rows

#### Scenario: Replay strategy fixture is inserted
- **WHEN** a conforming `maker_replay` fixture is posted
- **THEN** the endpoint MUST return HTTP 200 only after direct insertion succeeds
- **AND** queued batches, queued work, and accounted spool bytes MUST remain unchanged

#### Scenario: Forwarder restarts with live work pending
- **WHEN** admitted `hb_runtime` work remains across a controlled forwarder restart
- **THEN** a new worker MUST recover and drain it with stable per-table deduplication tokens
- **AND** a deterministic failure in one table MUST NOT reinsert completed sibling tables

### Requirement: Archive sink latency and failure do not terminate delivery or hide loss
Archival SHALL remain asynchronous to successful gRPC market-data delivery. A terminal JSONL record MUST have exactly the required fields `timestamp`, `source`, `deployment_id`, `reason`, and `payload`; `payload` MUST contain the complete emitted `{ table, row }`. Bounded-shutdown failures use `reason=shutdown_forwarder_failure`, and composed queue shedding uses `reason=queue_shed`.

#### Scenario: Inserter is blocked
- **WHEN** the first HTTP archive insertion is held unresolved by a deterministic inserter gate
- **THEN** the fake exchange MUST be able to release later feed frames and the real collector MUST observe them before the gate resolves
- **AND** every gRPC stream MUST remain active without reporting an archive error because the sink is blocked

#### Scenario: Inserter failure is recoverable
- **WHEN** a deterministic insertion attempt fails and a later retry is allowed to succeed
- **THEN** the writer MUST retry the undelivered batch according to its production behavior
- **AND** queried storage MUST account for every intended row with the contract's expected idempotency semantics

#### Scenario: Inserter failure persists through shutdown
- **WHEN** insertion continues to fail and the writer reaches bounded shutdown with undelivered rows
- **THEN** successful gRPC frames MUST remain delivered and the persistent loss journal MUST contain exactly one valid JSONL record for every undelivered row with a parseable `timestamp`, the lifecycle `source` and `deployment_id`, and reason `shutdown_forwarder_failure`
- **AND** each record's `payload.table` and stable `payload.row` identity fields MUST match the emitted row exactly, and no successfully stored row may be classified as terminally lost

#### Scenario: Queue shedding is composed
- **WHEN** deterministic queue saturation causes a row to be shed
- **THEN** the exact emitted row MUST have one durable record with `reason=queue_shed` and the complete `payload`
- **AND** it MUST not also be classified as a shutdown failure or successful insert

#### Scenario: An emitted row is unaccounted for
- **WHEN** any row produced by the failure lifecycle is neither verifiably stored nor represented by the exact required loss-journal record
- **THEN** the E2E suite MUST fail
- **AND** queue saturation, retry exhaustion, or shutdown MUST NOT permit silent loss

### Requirement: Archive E2E is the standard ongoing CI regression gate
The repository SHALL expose `test:e2e:archive` as a required serialized CI command alongside normal tests, build/type/lint, TypeScript and Python checksum fixtures, existing real-server integration tests, and `openspec validate --all --strict`. The one-time two-instance A/B acceptance for this change SHALL NOT become a permanent CI job unless a future specification generalizes upgrade regression across version pairs.

#### Scenario: Pull-request CI runs
- **WHEN** required CI executes for a supported branch or pull request
- **THEN** it MUST run normal checks, `test:e2e:archive`, cross-language fixtures, existing integration checks, and strict current-spec validation as failing steps
- **AND** normal tests MUST exclude dedicated archive E2E files so the expensive suite is not run twice

#### Scenario: E2E prerequisite is missing in CI
- **WHEN** the pinned binary cannot be verified, schema initialization fails, the fixture is incomplete, or no E2E test is discovered
- **THEN** the required CI step MUST fail
- **AND** it MUST NOT return success through a conditional skip or pass-with-no-tests path

#### Scenario: Normal tests run separately
- **WHEN** the repository's normal test command runs
- **THEN** it MUST exclude the dedicated archive E2E files so the expensive suite is not run twice
- **AND** all existing unit and integration tests, including the ClickHouse-server suite when its server is provisioned, MUST remain present

#### Scenario: OpenSpec implementing changes have been archived
- **WHEN** strict validation runs after an implementing change was synced and archived
- **THEN** CI MUST validate all current main specs or an existing main spec
- **AND** it MUST NOT reference an archived change name that the CLI cannot resolve

#### Scenario: This upgrade has already been accepted
- **WHEN** later ordinary pull requests run after the recorded A/B acceptance
- **THEN** standard archive E2E and existing integration checks MUST remain sufficient for this change's ongoing regression contract
- **AND** CI MUST NOT recreate the fixed pre/post upgrade acceptance unless upgrade testing is deliberately generalized

### Requirement: Live CEX smoke coverage is bounded, public-only, credentialless, and non-gating
The repository SHALL provide `test:smoke:archive` in a scheduled/manual workflow that is not a pull-request trigger or merge requirement. It MUST use the credentialless public exchange path and only public ORDERBOOK, TICKER, TRADES, and OHLCV subscriptions. It MUST NOT introduce exchange keys, a credential profile, credential-source policy, permission attestation, or archive write mode.

#### Scenario: Scheduled or manual smoke succeeds
- **WHEN** each configured public feed is available without exchange credentials within its timeout
- **THEN** every feed MUST archive at least one valid raw row linked to at least one valid normalized canonical row under a unique smoke capture bundle
- **AND** the workflow MUST clean up its broker, streams, forwarder, ClickHouse Local path, and temporary files within a bounded deadline

#### Scenario: Smoke code selects operations
- **WHEN** the live smoke constructs its broker and requests
- **THEN** it MUST use only public market-data Subscribe types
- **AND** it MUST NOT invoke `ExecuteAction`, account streams, order placement, cancellation, deposits, withdrawals, transfers, or asset movement

#### Scenario: Smoke configuration is inspected
- **WHEN** the scheduled/manual workflow and smoke entry point are reviewed
- **THEN** they MUST provide no exchange API key, exchange API secret, credential policy, credential profile, or permission attestation
- **AND** archive-forwarder authentication MAY use its existing matched token because that token authenticates the local archive sink rather than a CEX account

#### Scenario: Smoke prerequisite or feed is unavailable
- **WHEN** the pinned binary, schema initialization, any required public feed, raw linkage, normalized linkage, or cleanup deadline is unavailable
- **THEN** the smoke workflow MUST report a failing run rather than silently skip the missing assertion
- **AND** that failure MUST remain non-merge-gating

#### Scenario: Smoke diagnostics are retained
- **WHEN** a live smoke run fails
- **THEN** any feed-specific diagnostics retained according to workflow policy MUST be bounded to the failed smoke run
- **AND** logs and artifacts MUST exclude credentials, secret values, and unredacted credential-bearing payloads
