## ADDED Requirements

### Requirement: Archive lifecycle storage uses a mandatory pinned ClickHouse Local runtime

The repository SHALL expose `test:e2e:archive` as a serialized archive lifecycle command using ClickHouse Local exactly `v25.8.24.21-lts` from checksum-pinned official artifacts. Each harness instance MUST use a unique persistent `--path`, execute the production archive schema manifest, serialize operations against that path, and fail rather than skip when the binary, checksum, schema, or test is unavailable.

#### Scenario: Verified runtime is available
- **WHEN** the archive E2E command starts with a cached or explicitly configured binary whose checksum and reported version match the committed pin
- **THEN** every schema, insert, and query operation MUST use that binary in local mode
- **AND** the harness MUST remove only its run-owned path and processes during idempotent cleanup

#### Scenario: Runtime or schema prerequisite is invalid
- **WHEN** download, checksum, extraction, exact-version validation, a production schema statement, or E2E discovery fails
- **THEN** `test:e2e:archive` MUST fail with the missing prerequisite identified
- **AND** it MUST NOT return success through a conditional skip or pass-with-no-tests path

### Requirement: Historical forwarder compatibility remains immutable

The archive E2E suite SHALL retain the versioned golden fixture derived from clean commit `64fdf0607a234be05bac98f3edd3125e2c05d083`, with its recorded runtime-equivalent parent and deterministic provenance. It MUST cover the pre-canonical inventory of five `market_data`, four `broker_execution`, one `broker_account`, and five `strategy_data` tables through the production HTTP parser, allowlist, source validation, batching, inserter adapter, schema, and deterministic query-back path.

#### Scenario: Normal CI loads historical compatibility
- **WHEN** the suite runs in an offline or shallow checkout
- **THEN** it MUST consume the committed fixture without fetching or executing historical code
- **AND** exact legacy-column values, nulls, arrays, payloads, ordering, and cardinalities for all 15 tables MUST equal the fixture

#### Scenario: Current tables have additive columns
- **WHEN** the latest schema exposes columns that were absent from the historical fixture
- **THEN** the suite MUST compare the fixture's explicit legacy projection
- **AND** a changed value, missing row, or extra row within the fixture identity MUST fail even when new canonical rows are otherwise valid

#### Scenario: Historical fixture is regenerated
- **WHEN** an authorized compatibility update runs the documented regeneration command twice with the same commit, inputs, and tool versions
- **THEN** it MUST produce byte-equivalent semantic content and record the 15-table inventory plus every source/input hash
- **AND** changing the fixture commit or expected rows MUST require an explicit reviewed provenance change

### Requirement: All public feeds traverse the integrated production lifecycle

The suite SHALL drive deterministic ORDERBOOK, TICKER, TRADES, and OHLCV frames through a controlled fake exchange, normal gRPC server and Subscribe handler wiring, the production `MarketDataCollector` implementation, archive queue/writer and `node:http` transport, production archive-forwarder request/router logic, and ClickHouse Local storage. The `OhlcvCollector` value alias MUST NOT be used as the canonical collector type, and a research watcher or fake gRPC replacement MUST NOT satisfy this requirement.

#### Scenario: Integrated lifecycle starts
- **WHEN** the harness configures one deterministic exchange, pair, capture bundle, deployment, broker-read archive source, and all four subscriptions
- **THEN** `MarketDataCollector` MUST establish four gRPC Subscribe streams before frames are released
- **AND** missing archive URL, source, deployment, bundle, loss-journal path, or mismatched local sink token MUST fail setup without changing core broker startup behavior

#### Scenario: Four frames are released
- **WHEN** the fake exchange releases fixed ORDERBOOK, TICKER, TRADES, and OHLCV frames
- **THEN** the collector MUST observe every response and the writer MUST traverse its real queue, batching, and HTTP transport
- **AND** storage assertions MUST wait on explicit subscription, frame, flush, and query barriers rather than arbitrary sleeps

#### Scenario: Core broker has no archive configuration
- **WHEN** the normal production broker is started without archive configuration outside the composed harness
- **THEN** gRPC server construction and service registration MUST still succeed
- **AND** archival behavior MUST remain disabled rather than becoming a startup prerequisite

### Requirement: Canonical public-market rows have closed inventory and stored integrity

For the upgraded lifecycle, raw captures SHALL use `market_data.cex_stream_events`; normalized output SHALL use `market_data.cex_ticker_events`, `market_data.cex_trades`, `market_data.cex_ohlcv`, `market_data.cex_order_book_levels`, and `market_data.cex_order_book_depth_summary`. ORDERBOOK and OHLCV MUST NOT write `market_data.orderbook_snapshots` or `market_data.candles`. Assertions MUST recompute versioned raw and normalized checksums from queried stored values and query the named canonical, closed-candle, and conflict views.

#### Scenario: Canonical four-feed output is stored
- **WHEN** the integrated lifecycle finishes successfully under `source=broker_read`
- **THEN** each normalized row MUST link to a corresponding raw capture by capture bundle and raw capture ID and preserve provider, exchange, pair, source/received timestamps, source mode, schema, and checksum versions
- **AND** no lifecycle identity may appear in a removed legacy output table

#### Scenario: Stored checksums are verified
- **WHEN** TypeScript and Python contract verifiers project queried canonical rows
- **THEN** both implementations MUST produce the stored checksums using the same decimal normalization, field order, and algorithm version
- **AND** drift in either verifier or fixture MUST fail required CI

#### Scenario: Canonical views are queried
- **WHEN** the lifecycle has no checksum conflict
- **THEN** canonical level, summary, and closed-OHLCV views MUST expose the expected logical rows with provenance intact
- **AND** the order-book conflict views MUST be empty for the lifecycle identity

### Requirement: Order-book duplicate and conflict behavior is auditable

The suite SHALL verify append-only physical evidence, canonical deduplication, same-request rejection, and cross-request conflict visibility for order-book levels and depth summaries using the production logical keys and views. It MUST NOT project these order-book-specific semantics onto raw, ticker, trade, or OHLCV tables.

#### Scenario: Identical order-book evidence is delivered twice
- **WHEN** two accepted requests carry the same logical key and normalized checksum
- **THEN** both physical deliveries MUST remain queryable
- **AND** the corresponding canonical view MUST expose one logical row

#### Scenario: One request contains conflicting checksums
- **WHEN** one request contains the same order-book logical key with distinct normalized checksums
- **THEN** the whole request MUST be rejected before insertion
- **AND** no table represented by that request may receive a row

#### Scenario: Separate requests conflict
- **WHEN** accepted requests reuse an order-book logical key with distinct normalized checksums
- **THEN** the physical rows and distinct checksums MUST remain queryable in the conflict view
- **AND** the canonical view MUST exclude the conflicted key

### Requirement: Strategy fixtures use their actual ownership paths

The composed suite SHALL provide a unique writable SQLite strategy spool and worker for `hb_runtime` rows and SHALL keep `maker_replay` on the synchronous direct-insert path. It MUST distinguish durable admission from ClickHouse delivery and MUST NOT use the Local baseline adapter to turn a live-runtime batch into an immediate synchronous success.

#### Scenario: Live-runtime strategy fixture is admitted
- **WHEN** a conforming `hb_runtime` fixture is posted to the production endpoint
- **THEN** the endpoint MUST return HTTP 202 after SQLite admission without waiting for ClickHouse
- **AND** the suite MUST wait for explicit spool work completion and then query all expected strategy rows

#### Scenario: Replay strategy fixture is inserted
- **WHEN** a conforming `maker_replay` fixture is posted
- **THEN** the endpoint MUST return HTTP 200 only after direct insertion succeeds
- **AND** the fixture MUST consume no strategy spool quota

#### Scenario: Forwarder restarts with live work pending
- **WHEN** admitted `hb_runtime` work remains in SQLite across a controlled forwarder restart
- **THEN** a new worker MUST recover and drain it with the stable per-table deduplication token
- **AND** a deterministic failure in one table MUST NOT cause completed sibling tables to be reinserted

### Requirement: Archive failure does not terminate gRPC delivery or hide loss

Archival SHALL remain asynchronous to successful public market-data delivery. The suite MUST prove blocked-sink delivery, retry recovery, and terminal JSONL loss accounting containing `timestamp`, `source`, `deployment_id`, `reason`, and the complete emitted payload.

#### Scenario: Archive insertion is blocked
- **WHEN** a deterministic inserter gate holds the first archive operation unresolved
- **THEN** later feed frames MUST still reach the collector while all gRPC streams remain active
- **AND** no stream may fail solely because the archive sink is blocked

#### Scenario: Insertion fails and later recovers
- **WHEN** an archive attempt fails and a later retry succeeds
- **THEN** every intended row MUST become queryable under its expected idempotency semantics
- **AND** no successfully stored row may be reported as terminal loss

#### Scenario: Insertion remains failed through shutdown
- **WHEN** bounded writer shutdown ends with undelivered rows
- **THEN** each undelivered row MUST have exactly one parseable `shutdown_forwarder_failure` loss-journal record matching its table and stable identity
- **AND** any emitted row that is neither stored nor exactly journaled MUST fail the suite

### Requirement: Archive regression is a distinct required CI gate

Required CI SHALL run normal tests, build/type/lint checks, `test:e2e:archive`, TypeScript and Python canonical fixture verification, existing real ClickHouse integration coverage, and `openspec validate --all --strict` as separate failing steps. Normal tests MUST exclude the dedicated archive E2E files so the expensive suite is not run twice.

#### Scenario: Pull-request CI executes
- **WHEN** required CI runs for a supported branch or pull request
- **THEN** every required archive, cross-language, OpenSpec, test, and build step MUST be discovered and pass
- **AND** a missing runtime or service MUST fail rather than skip

#### Scenario: OpenSpec changes have been archived
- **WHEN** strict validation runs after an implementing change was synced and archived
- **THEN** CI MUST validate all current main specs or an existing main spec
- **AND** it MUST NOT reference an archived change name that the OpenSpec CLI cannot resolve

### Requirement: Live exchange smoke remains public-only and non-gating

The repository SHALL retain scheduled/manual `test:smoke:archive` coverage for credentialless public ORDERBOOK, TICKER, TRADES, and OHLCV subscriptions. It MUST not be a pull-request trigger or merge requirement and MUST NOT introduce exchange API keys, credential profiles, credential-source policies, permission attestations, or a runtime archive write mode.

#### Scenario: Public live smoke runs
- **WHEN** the scheduled/manual workflow can obtain all four public feeds
- **THEN** each feed MUST archive linked raw and normalized canonical evidence under a unique smoke identity
- **AND** all run-owned broker, stream, forwarder, Local path, and temporary resources MUST be cleaned within a bounded deadline

#### Scenario: Public feed or prerequisite is unavailable
- **WHEN** a required feed, pinned binary, schema, linkage assertion, or cleanup deadline fails
- **THEN** the smoke run MUST report failure with bounded secret-free diagnostics
- **AND** that failure MUST remain non-merge-gating
