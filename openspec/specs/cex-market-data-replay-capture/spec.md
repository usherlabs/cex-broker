# cex-market-data-replay-capture Specification

## Purpose

Define canonical four-feed CEX capture, deployment provenance, integrity, collector continuity, and migration behavior for replay-ready ClickHouse archives.
## Requirements
### Requirement: Broker deployments retain the full service contract

The system SHALL register the same `ExecuteAction` and `Subscribe` RPC contract in TEE and non-TEE broker deployments, and SHALL NOT use an RPC/action allowlist as the mechanism that distinguishes read-only from write-capable deployments.

#### Scenario: Non-TEE broker starts with the full service

- **WHEN** a non-TEE broker is started with exchange credentials whose permissions are read-only
- **THEN** it MUST register the same broker RPCs and action handlers as a TEE broker
- **AND** public market-data calls MUST remain available through the normal broker contract

#### Scenario: Deployment archive role does not change RPC registration

- **WHEN** the archive source is configured as `broker_read` or `broker_write`
- **THEN** the selected value MUST affect archival provenance only
- **AND** it MUST NOT add or remove broker RPC methods

### Requirement: Credential resolution follows fixed source precedence

The system SHALL preserve the broker's established credential resolution order without adding archive-specific credential profiles, credential-source policy, or permission-attestation configuration. A matching environment-loaded broker SHALL take precedence over request-supplied credentials, request metadata SHALL be considered only when no matching environment broker exists, and credentialless public construction SHALL remain the final fallback only for operations that already support public access.

The selected exchange key's actual permissions SHALL establish effective privilege. The broker SHALL NOT infer a read-only or write-capable profile from archive source, deployment type, or credential location.

#### Scenario: Environment and request credentials are both present

- **WHEN** a matching environment-loaded broker exists and a request also supplies `api-key` or `api-secret` metadata
- **THEN** the environment-loaded broker MUST be selected
- **AND** request credentials MUST NOT replace it

#### Scenario: Only request credentials are present

- **WHEN** no matching environment-loaded broker exists and a request supplies a complete supported credential pair
- **THEN** the broker MUST construct the exchange from the request credentials using the existing in-flight path
- **AND** archival configuration MUST NOT reject that source

#### Scenario: No credentials are present for a public operation

- **WHEN** neither environment nor request credentials are available and the requested operation supports public exchange access
- **THEN** the broker MAY construct a credentialless public exchange
- **AND** it MUST retain the same RPC and action surface

#### Scenario: A non-TEE deployment is intended to be read-only

- **WHEN** credentials are supplied through either supported source
- **THEN** deployment and secret provisioning MUST restrict the exchange key to the intended permissions
- **AND** the archive plane MUST NOT add a credential profile, source-policy, or attestation environment variable to classify that key

### Requirement: Archive source identity is deployment controlled

The market-data archive source SHALL be derived from the deployed broker role and SHALL be limited to `broker_read` or `broker_write`. Caller-supplied row data SHALL NOT override the source. The public forwarder SHALL reject `external_backfill` and every unknown source before generic table routing or insertion.

#### Scenario: Read and write broker deployments use closed sources

- **WHEN** a live collector archives a row from a configured read or write deployment
- **THEN** the source SHALL be assigned as `broker_read` or `broker_write` respectively

#### Scenario: External historical source is explicitly rejected

- **WHEN** a batch, route, legacy worker, or crafted request presents `source = 'external_backfill'`
- **THEN** admission SHALL fail before table dispatch
- **AND** no raw, normalized, level, summary, evidence, or spool-success row SHALL be written for that item

#### Scenario: Arbitrary source strings fail closed

- **WHEN** a market row presents a source other than `broker_read` or `broker_write`
- **THEN** validation SHALL reject it even if all remaining row fields are structurally valid

### Requirement: Production captures have bundle and provider provenance

Every production market-data row SHALL identify the capture bundle, deployment, exchange, trading pair, provider, feed, source mode, source timestamp, broker-received timestamp, schema version, raw-capture identity and scope, raw checksum and algorithm version, and normalized-row checksum and algorithm version using the versioned replay-capture contract. The deployed full broker that hosts the subscription and archive writer SHALL own these production identities; the collector SHALL NOT duplicate or override them.

#### Scenario: Collector opens a configured feed

- **WHEN** the production collector opens a feed for a configured exchange and pair through the deployed full broker
- **THEN** the broker MUST attach its deployment-owned `capture_bundle_id` to every raw-capture and normalized row produced by that feed
- **AND** it MUST record the exact provider, feed-specific source mode, schema version, raw-capture integrity fields, and normalized-row integrity fields rather than infer them during replay

#### Scenario: Production bundle identity is missing

- **WHEN** the full broker receives market-data frames while production archive provenance lacks a non-empty deployment or capture-bundle identity
- **THEN** the full broker MUST continue serving its normal RPCs and stream frames
- **AND** it MUST skip canonical market-data archival rather than emit ungrouped production rows
- **AND** it MUST emit a bounded diagnostic identifying the non-secret configuration reason

#### Scenario: Collector attempts to configure capture identity

- **WHEN** canonical collector JSON contains `environment`, `captureBundleId`, or another archive identity field
- **THEN** collector startup MUST reject the configuration as invalid
- **AND** operators MUST configure that identity on the deployed full broker instead

### Requirement: Raw captures and normalized rows have reproducible integrity

The archive SHALL compute stable identities and checksums from canonical normalized observations before persistence. For ORDERBOOK, the complete normalized observation SHALL produce `raw_checksum` and `raw_capture_id` under capture schema `1.0.0`; the retained-N bid/ask slice SHALL produce `snapshot_id` under capture schema `1.0.0`. Summary schema `2.0.0` SHALL NOT enter either identity. Raw and level rows SHALL use `schema_version = '1.0.0'`, while the linked summary alone SHALL use `schema_version = '2.0.0'`. Each row's `normalized_row_checksum` SHALL describe that row's own stored projection and SHALL NOT be treated as a shared checksum.

ORDERBOOK raw storage SHALL retain metadata-only payloads linked to the full normalized observation checksum; TICKER, TRADES, and OHLCV SHALL retain their existing canonical raw behavior. Repeated logical identity with identical row content SHALL be idempotent in canonical views while every physical delivery remains append-only; repeated identity with conflicting content SHALL remain visible through conflict evidence and excluded from supported output.

#### Scenario: ORDERBOOK metadata links to normalized output

- **WHEN** one ORDERBOOK observation produces a raw row, retained level rows, and a depth summary
- **THEN** every row SHALL carry the same source, deployment, capture bundle, provider, raw-capture identity, and full-observation checksum
- **AND** retained levels and the summary SHALL carry the same retained-N snapshot identity while the raw row need not duplicate it
- **AND** the raw payload SHALL satisfy `orderbook_metadata_only_v1`
- **AND** raw/level schema version and per-row checksums SHALL remain distinct from summary schema version and summary row checksum

#### Scenario: Non-order-book feeds are unchanged

- **WHEN** TICKER, TRADES, or OHLCV is archived
- **THEN** its established raw and normalized checksum contract SHALL remain unchanged by the ORDERBOOK bounding change

#### Scenario: Conflicting replay is rejected

- **WHEN** an existing capture identity is presented with different canonical content
- **THEN** the archive SHALL reject a same-batch conflict or expose a cross-batch conflict through the named conflict view
- **AND** it SHALL never overwrite the stored physical observation or select the conflicted key as supported output

### Requirement: The production collector supervises all required CEX feeds

The production collector SHALL be an independent gRPC client of a separately deployed full CEX Broker and SHALL supervise configured `ORDERBOOK`, `TICKER`, `TRADES`, and `OHLCV` subscriptions independently for every strategy exchange and pair. It SHALL NOT start an embedded broker, instantiate CCXT exchanges, own CEX credentials, or own archive delivery. The collector SHALL sustain configured capture coverage and liveness, while the broker SHALL own and share each canonical physical public feed and its archive path with any matching third-party subscription.

#### Scenario: Strategy capture configuration is loaded

- **WHEN** production collection starts with strategy exchange/pair/feed configuration and an explicit broker target
- **THEN** it MUST validate that each required feed has a supervisor and required options such as depth limit or timeframe
- **AND** failure of one feed MUST NOT terminate supervisors for other feeds or pairs

#### Scenario: Capture is intended to replay the Maker hedge envelope

- **WHEN** deployment capture is declared as replay evidence for a Maker position policy with ORDERBOOK depth P and configured measurement bands
- **THEN** the collector ORDERBOOK request and broker archive configuration MUST retain at least P levels unless explicit exhaustion or boundary evidence proves every band complete
- **AND** deployment verification MUST reject a capture profile whose archived rows cannot reproduce the live per-band bid and ask depth used as the immediate-hedgeability cap

#### Scenario: Broker target is missing or malformed

- **WHEN** the independent collector starts without a valid `CEX_BROKER_URL` gRPC `host:port` target
- **THEN** startup MUST fail before opening any subscriptions
- **AND** it MUST NOT create a fallback loopback broker

#### Scenario: Deployed broker is unavailable

- **WHEN** the collector cannot connect to the configured full broker
- **THEN** each affected supervisor MUST reconnect with bounded backoff and jitter
- **AND** the broker and unrelated collector supervisors MUST remain independent

#### Scenario: Live stream disconnects

- **WHEN** an order-book, ticker, trade, or OHLCV stream ends or errors unexpectedly
- **THEN** its supervisor MUST reconnect with bounded backoff and jitter
- **AND** it MUST expose reconnect count, last-frame time, and current feed-health state

#### Scenario: Provider catch-up is unavailable

- **WHEN** a live order-book, ticker, or trade stream reconnects and the provider cannot replay the missing interval
- **THEN** the collector MUST record an explicit gap
- **AND** it MUST NOT synthesize missing market events

#### Scenario: Matching third-party subscription is active

- **WHEN** the collector and a third-party client subscribe to the same canonical public feed
- **THEN** the broker MUST service both logical subscriptions from one physical exchange watcher and archive owner
- **AND** the collector MUST remain the coverage/liveness subscriber rather than the mechanism that prevents duplicate physical capture

#### Scenario: OHLCV bootstrap is supported

- **WHEN** an OHLCV worker has no completed archive bootstrap and the first positive bootstrap request arrives, even if a zero-bootstrap client created the worker earlier
- **THEN** the broker MUST atomically claim, fetch, and archive available historical bars before or alongside the live stream
- **AND** bootstrap rows MUST use a source mode distinct from live stream rows
- **AND** later subscriber bootstrap delivery for the same feed MUST NOT create additional archived bootstrap rows

#### Scenario: OHLCV archive bootstrap fetch fails

- **WHEN** the positive subscriber that owns the archive-bootstrap attempt cannot fetch history
- **THEN** its live subscription MUST continue and the worker MUST remain available
- **AND** a later positive collector attach or reconnect MUST be allowed to retry ownership because no bootstrap completed

#### Scenario: Collector reconnects after another client kept the worker alive

- **WHEN** a positive-bootstrap collector disconnects and reconnects while a zero-bootstrap or other logical subscriber keeps the OHLCV worker alive
- **THEN** a previously completed archived bootstrap MUST NOT be repeated
- **AND** if no bootstrap previously completed, the reconnecting collector MUST be allowed to claim it

#### Scenario: Collector stops

- **WHEN** the collector receives a termination signal
- **THEN** it MUST cancel its remote subscriptions and close its gRPC client without waiting for or shutting down the remote broker

### Requirement: Optional market archival does not gate the full broker

The full broker SHALL keep its complete gRPC service available when optional archival is absent, disabled, or ineligible for canonical production market capture. This availability rule SHALL NOT weaken explicitly enabled archive-writer sink validation or the provenance required on rows that are emitted.

#### Scenario: Archive delivery is absent or disabled

- **WHEN** a production broker starts without `CEX_BROKER_ARCHIVE_ENABLED=true`
- **THEN** the full broker MUST bind its normal `ExecuteAction` and `Subscribe` service
- **AND** archive work MUST be a no-op

#### Scenario: Production market archive provenance is incomplete

- **WHEN** the shared archive writer is enabled but canonical production market provenance is incomplete or invalid
- **THEN** the full broker MUST remain available and skip market-data archival
- **AND** other eligible archive classes MAY continue using the configured writer

#### Scenario: Write broker has complete market provenance

- **WHEN** a production broker configured with source `broker_write` has complete deployment and capture-bundle provenance
- **THEN** it MAY archive its own market observations without changing its RPC service
- **AND** the runtime MUST NOT reject it as though every production broker were the FIET-901 read deployment

#### Scenario: Archive writer is explicitly enabled without a valid sink

- **WHEN** `CEX_BROKER_ARCHIVE_ENABLED=true` is supplied without the writer's required forwarder URL or durable loss-journal path
- **THEN** existing archive-writer configuration validation MUST fail closed
- **AND** the broker MUST NOT silently reinterpret the explicit enable request as disabled

### Requirement: Market capture remains outside the strategy execution dependency path

Market-data archival SHALL use bounded asynchronous queues, bounded batches, retry policy, backpressure telemetry, and persistent loss journaling without making strategy execution or stream delivery depend on ClickHouse availability.

#### Scenario: ClickHouse or forwarder is unavailable

- **WHEN** the archive sink is temporarily unavailable
- **THEN** market-data stream delivery MUST continue independently
- **AND** archive delivery MUST retry within configured bounds before journaling undeliverable rows

#### Scenario: Archive queue reaches capacity

- **WHEN** the bounded archive queue cannot accept another row
- **THEN** the configured shedding or durability policy MUST be applied deterministically
- **AND** queue saturation and lost/journaled row counts MUST be observable by feed and source

#### Scenario: Broker shuts down with pending rows

- **WHEN** shutdown begins while archive rows remain queued
- **THEN** the broker MUST attempt a bounded flush
- **AND** rows still undeliverable at the deadline MUST be written to the configured persistent loss journal

### Requirement: Canonical non-order-book market tables preserve replay provenance

The archive plane SHALL write ticker, trade, OHLCV, and raw stream records to `market_data.cex_ticker_events`, `market_data.cex_trades`, `market_data.cex_ohlcv`, and `market_data.cex_stream_events` with the common replay-capture fields and deterministic checksums.

#### Scenario: OHLCV row is archived

- **WHEN** an OHLCV bar is normalized for archive
- **THEN** it MUST be written to `market_data.cex_ohlcv` with timeframe, open time, OHLCV values, closure/version state, capture provenance, and normalized-row checksum

#### Scenario: Ticker or trade row is archived

- **WHEN** a ticker snapshot or public trade is normalized for archive
- **THEN** it MUST retain its feed-specific values and common capture provenance
- **AND** it MUST link to the raw capture from which it was normalized

#### Scenario: Raw stream event is retained

- **WHEN** a broker-visible feed payload is accepted for production archive
- **THEN** `market_data.cex_stream_events` MUST record its redacted payload or reproducible capture metadata, raw-capture identity, raw checksum, and schema version

### Requirement: Legacy candle storage requires table migration before upgrade

The system SHALL migrate retained rows from `market_data.candles` to `market_data.cex_ohlcv` through a bounded ClickHouse table-to-table migration before deploying the upgraded canonical-only broker. The upgraded broker SHALL always write the latest canonical schema and SHALL NOT expose a runtime legacy/dual/canonical write mode.

#### Scenario: Existing deployment is prepared for upgrade

- **WHEN** an existing broker writes `market_data.candles` and the canonical-only version is scheduled for deployment
- **THEN** operators MUST apply canonical DDL, quiesce legacy writers, migrate every retained bounded partition, and validate parity before deploying the upgraded broker
- **AND** any missing row or value mismatch MUST block the upgrade

#### Scenario: Legacy candle lacks raw capture provenance

- **WHEN** a `market_data.candles` row is migrated and its original capture bundle, raw identity, or raw checksum is unavailable
- **THEN** the canonical row MUST record legacy source mode and incomplete provenance
- **AND** unavailable raw provenance fields MUST remain null rather than be fabricated

#### Scenario: Canonical-only broker is deployed

- **WHEN** canonical OHLCV migration and replay validation pass for every retained migration window
- **THEN** the upgraded broker MUST write new OHLCV captures only to `market_data.cex_ohlcv`
- **AND** legacy candle query names and closed-candle semantics MUST remain available through documented compatibility views for the migration retention period

#### Scenario: Candle cutover is rolled back

- **WHEN** a blocking integrity or replay defect is found after canonical OHLCV deployment
- **THEN** operators MUST stop the upgraded broker and MAY restore the retained legacy names before rolling back to the previous legacy-writing application version
- **AND** the defect and affected capture bundles MUST remain diagnosable

### Requirement: Capture output is replay-consumable

Supported CEX capture output SHALL be consumable directly from the live/hot ClickHouse contract: metadata-only raw events, bounded diagnostic order-book levels, summary-v2 rows, and the unchanged normalized non-order-book tables. CEX SHALL NOT define a canonical Parquet export, qualified historical selection, or preparation-package handoff as part of replay consumption.

#### Scenario: Hot order-book reader uses supported tables

- **WHEN** a consumer reads a supported live ORDERBOOK interval
- **THEN** it SHALL read summary `2.0.0` through the supported view and MAY read bounded level rows for diagnostics
- **AND** it SHALL NOT require raw full-book JSON or a CEX-generated Parquet artifact

#### Scenario: Unsupported interval is not synthesized

- **WHEN** an interval contains only summary-v1 physical rows or lacks valid summary-v2 evidence
- **THEN** the supported contract SHALL expose the interval as unavailable
- **AND** it SHALL NOT synthesize claim rights from diagnostic level rows

### Requirement: ORDERBOOK raw payloads are structurally bounded

Every archived ORDERBOOK raw event SHALL use capture schema `1.0.0` and `payload_encoding = 'orderbook_metadata_only_v1'`. Its canonical `payload_json` object SHALL contain exactly these keys and no others:

- `capture_profile_id`: non-empty JSON string;
- `effective_cadence_ms`: non-negative JSON integer;
- `requested_upstream_depth`: JSON integer in `1..500`, or JSON `null` only when the acquisition profile has no explicit upstream limit;
- `archive_depth_limit`: JSON integer in `1..500`;
- `observed_bid_count` and `observed_ask_count`: positive JSON integers;
- `observed_farthest_bid` and `observed_farthest_ask`: positive canonical decimal strings;
- `bid_exhausted` and `ask_exhausted`: JSON booleans that may be true only when backed by validated provider evidence;
- `retained_bid_count` and `retained_ask_count`: positive JSON integers no greater than `archive_depth_limit` or the corresponding observed count; and
- `measurement_bands_bps`: a non-empty, ascending, unique JSON array of positive integers, defaulting by deployment configuration to `[10,25,50,100]` and pinned explicitly in fixtures.

The object SHALL contain no bids, asks, nested level arrays, provider response body, optional full-body diagnostic representation, null beyond the one allowed field, or unrecognized key. Missing sides or required boundary metadata SHALL reject the entire ORDERBOOK capture instead of producing a partial raw row.

#### Scenario: Complete upstream book does not escape through raw storage

- **WHEN** the exchange returns more levels than the configured archive depth
- **THEN** the raw event body SHALL remain fixed-shape metadata
- **AND** neither the retained raw event nor an alternate diagnostic column SHALL contain the discarded levels

#### Scenario: Full-observation integrity remains auditable

- **WHEN** the writer emits a metadata-only ORDERBOOK raw event
- **THEN** it SHALL retain `raw_checksum` and `raw_capture_id` computed from the complete normalized upstream observation under capture schema `1.0.0`
- **AND** changing any normalized upstream level SHALL change that checksum even though the levels are absent from `payload_json`

#### Scenario: Metadata-only shape fails closed

- **WHEN** an ORDERBOOK metadata object has an extra key, missing key, invalid type, invalid null, empty side, inconsistent count, or invalid band configuration
- **THEN** the writer or forwarder SHALL reject the complete capture before durable insertion
- **AND** it SHALL NOT preserve a generic JSON fallback body

### Requirement: Market deployment admission is non-empty and row-bound

When market archive identity is configured, both source and deployment ID SHALL be non-empty after trimming and SHALL be configured together. Every admitted `market_data.*` row SHALL carry a source and deployment ID equal to the authenticated envelope and configured deployment identity.

#### Scenario: Blank or partial identity is configured

- **WHEN** either market source or deployment ID is absent, blank, or whitespace-only while the other is configured
- **THEN** archive-forwarder startup SHALL fail before accepting requests

#### Scenario: Market row overrides deployment identity

- **WHEN** a market envelope matches the configured source and deployment but one row omits or changes `deployment_id`
- **THEN** admission SHALL reject the batch before routing, spooling, or insertion

### Requirement: ORDERBOOK measurement bands are closed and bounded

ORDERBOOK measurement bands SHALL normalize to ascending unique integer values. The normalized array SHALL contain `1..64` entries, and every entry SHALL be in `1..10000` basis points.

#### Scenario: Oversized or out-of-range bands are configured

- **WHEN** normalized bands contain more than 64 entries or any value is outside `1..10000`
- **THEN** the writer SHALL reject configuration or capture before summary calculation

#### Scenario: Forwarder receives invalid bands

- **WHEN** ORDERBOOK raw metadata or a summary-v2 row violates the same cardinality or value bounds
- **THEN** the forwarder SHALL reject it before ClickHouse insertion
