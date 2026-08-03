## ADDED Requirements

### Requirement: Broker deployments retain the full service contract
The system SHALL register the same `ExecuteAction` and `Subscribe` RPC contract in TEE and non-TEE broker deployments, and SHALL NOT use an RPC/action allowlist as the mechanism that distinguishes read-only from write-capable deployments.

#### Scenario: Non-TEE broker starts with the full service
- **WHEN** a non-TEE broker is started with a read-only credential profile
- **THEN** it MUST register the same broker RPCs and action handlers as a TEE broker
- **AND** public market-data calls MUST remain available through the normal broker contract

#### Scenario: Deployment archive role does not change RPC registration
- **WHEN** the archive source is configured as `broker_read` or `broker_write`
- **THEN** the selected value MUST affect archival provenance only
- **AND** it MUST NOT add or remove broker RPC methods

### Requirement: Credential policy establishes non-TEE read-only posture
The system SHALL make the allowed credential source and provisioned profile explicit deployment policy so a non-TEE read-only deployment cannot be upgraded to write-capable credentials by request metadata or silently change between credentialed and public access.

#### Scenario: Provisioned-only credentials are selected
- **WHEN** a non-TEE deployment is configured with provisioned-only credential policy
- **THEN** broker construction MUST use its explicitly configured `public` or `read_only_key` profile
- **AND** request-supplied `api-key` or `api-secret` metadata MUST be rejected with gRPC `PERMISSION_DENIED` before exchange construction
- **AND** the rejection MUST be observable without logging credential values

#### Scenario: Public credential profile is selected
- **WHEN** a provisioned-only deployment explicitly selects the `public` profile for a public market-data operation
- **THEN** it MUST construct the exchange without credentials
- **AND** it MUST NOT use request metadata as a fallback credential source

#### Scenario: Read-only key profile is incomplete
- **WHEN** a provisioned-only deployment selects `read_only_key` but its provisioned key or secret is missing or invalid
- **THEN** broker construction MUST fail with a typed configuration or authentication error
- **AND** it MUST NOT silently fall back to credentialless public access

#### Scenario: Read-only permission is operationally attested
- **WHEN** an exchange does not expose a reliable API for inspecting key permissions
- **THEN** deployment validation MUST rely on credential provisioning records or operator attestation
- **AND** validation MUST NOT place, cancel, transfer, deposit, or withdraw real assets to test the key

### Requirement: Archive source identity is deployment controlled
The archive plane SHALL support the closed source identities `broker_read` and `broker_write`, selected from immutable deployment configuration and propagated consistently to every row and batch envelope.

#### Scenario: Read broker archives a market frame
- **WHEN** a broker configured with archive source `broker_read` archives a market-data frame
- **THEN** every normalized row and its archive envelope MUST contain `source = "broker_read"`
- **AND** clients MUST NOT be able to override that source through request fields or metadata

#### Scenario: Envelope and row sources disagree
- **WHEN** an archive batch contains a row whose source differs from the envelope source
- **THEN** the archive forwarder MUST reject the inconsistent batch or row before ClickHouse insertion
- **AND** it MUST emit a bounded diagnostic without exposing credentials or raw secrets

#### Scenario: FIET-901 production capture uses the read archive source
- **WHEN** the broker/archiver hosting FIET-901 production subscriptions starts with an archive source other than `broker_read`
- **THEN** production capture startup or deployment validation MUST fail before opening subscriptions
- **AND** unrelated TEE or write-broker deployments MAY continue to archive their own market observations as `broker_write`

### Requirement: Production captures have bundle and provider provenance
Every production market-data row SHALL identify the capture bundle, deployment, exchange, trading pair, provider, feed, source mode, source timestamp, broker-received timestamp, schema version, raw-capture identity and scope, raw checksum and algorithm version, and normalized-row checksum and algorithm version using the versioned replay-capture contract.

#### Scenario: Collector opens a configured feed
- **WHEN** the production collector opens a feed for a configured exchange and pair
- **THEN** it MUST attach the deployment-owned `capture_bundle_id` to every raw-capture and normalized row produced by that feed
- **AND** it MUST record the exact provider, feed-specific source mode, schema version, raw-capture integrity fields, and normalized-row integrity fields rather than infer them during replay

#### Scenario: Production bundle identity is missing
- **WHEN** production collection starts without a non-empty capture bundle identity
- **THEN** startup MUST fail configuration validation
- **AND** it MUST NOT archive ungrouped production rows

### Requirement: External fallback producers conform without expanding broker scope
The capture contract SHALL permit separately deployed direct CCXT or Hummingbot fallback producers, but this broker and collector change SHALL NOT require implementing or invoking those producers for FIET-901 completion.

#### Scenario: Broker feed is unavailable
- **WHEN** the broker collector cannot obtain a required feed and no separately deployed fallback producer is configured
- **THEN** it MUST record the feed as unavailable
- **AND** it MUST NOT instantiate an in-process direct CCXT or Hummingbot fallback as part of this change

#### Scenario: External fallback row is admitted
- **WHEN** an approved external fallback producer submits a row to the shared capture contract
- **THEN** ingestion MUST validate and preserve the configured exchange and pair
- **AND** the row MUST record the fallback provider, a versioned fallback source mode, and the fallback reason

#### Scenario: External fallback crosses venues
- **WHEN** a fallback row identifies an exchange different from the configured strategy exchange
- **THEN** ingestion MUST reject the row
- **AND** it MUST NOT substitute or relabel the cross-venue data

### Requirement: Raw captures and normalized rows have reproducible integrity
The archive plane SHALL assign each broker-visible capture a reproducible raw-capture identity and checksum, and SHALL assign every normalized output row a deterministic row checksum under a versioned canonicalization algorithm.

#### Scenario: CCXT-normalized object is the earliest available capture
- **WHEN** the broker receives a CCXT-normalized object rather than exchange wire bytes
- **THEN** `raw_capture_scope` MUST identify the object as broker-visible or CCXT-normalized
- **AND** metadata MUST NOT claim that its checksum represents the original exchange wire frame

#### Scenario: Raw capture checksum is recomputed
- **WHEN** the retained capture payload and checksum algorithm version are supplied to the verifier
- **THEN** canonical serialization and hashing MUST reproduce the stored raw-capture checksum

#### Scenario: Normalized row checksum is recomputed across languages
- **WHEN** TypeScript and Python normalize the same contract fixture
- **THEN** both implementations MUST produce the same normalized-row checksum
- **AND** the checksum projection MUST exclude its own checksum field and ingestion-only mutable fields

#### Scenario: Capture contains credential-like data
- **WHEN** a provider payload contains headers, keys, secrets, signatures, or credential metadata
- **THEN** the archive plane MUST redact those fields before retained-payload serialization
- **AND** no integrity field may embed the secret value

### Requirement: The production collector supervises all required CEX feeds
The production collector SHALL supervise configured `ORDERBOOK`, `TICKER`, `TRADES`, and `OHLCV` subscriptions independently for every strategy exchange and pair.

#### Scenario: Strategy capture configuration is loaded
- **WHEN** production collection starts with strategy exchange/pair/feed configuration
- **THEN** it MUST validate that each required feed has a supervisor and required options such as depth limit or timeframe
- **AND** failure of one feed MUST NOT terminate supervisors for other feeds or pairs

#### Scenario: Live stream disconnects
- **WHEN** an order-book, ticker, trade, or OHLCV stream ends or errors unexpectedly
- **THEN** its supervisor MUST reconnect with bounded backoff and jitter
- **AND** it MUST expose reconnect count, last-frame time, and current feed-health state

#### Scenario: Provider catch-up is unavailable
- **WHEN** a live order-book, ticker, or trade stream reconnects and the provider cannot replay the missing interval
- **THEN** the collector MUST record an explicit gap
- **AND** it MUST NOT synthesize missing market events

#### Scenario: OHLCV bootstrap is supported
- **WHEN** an OHLCV subscription starts with a configured bootstrap window
- **THEN** the collector MUST fetch and archive available historical bars before or alongside the live stream
- **AND** bootstrap rows MUST use a source mode distinct from live stream rows

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

### Requirement: Legacy candle storage migrates without fabricated provenance
The system SHALL migrate from `market_data.candles` to `market_data.cex_ohlcv` using staged dual-write, validated backfill, consumer cutover, compatibility views, and reversible deployment controls.

#### Scenario: New OHLCV capture is dual-written during migration
- **WHEN** the candle migration dual-write phase is enabled
- **THEN** each normalized OHLCV bar MUST populate both `market_data.candles` and `market_data.cex_ohlcv`
- **AND** parity metrics MUST expose value, closure-state, or version mismatches before cutover

#### Scenario: Legacy candle lacks raw capture provenance
- **WHEN** a `market_data.candles` row is backfilled and its original capture bundle, raw identity, or raw checksum is unavailable
- **THEN** the canonical row MUST record legacy source mode and incomplete provenance
- **AND** unavailable raw provenance fields MUST remain null rather than be fabricated

#### Scenario: Candle consumer cutover is complete
- **WHEN** canonical OHLCV parity and replay validation pass for the agreed observation window
- **THEN** new writes MUST switch to `market_data.cex_ohlcv`
- **AND** legacy candle query names and closed-candle semantics MUST remain available through documented compatibility views for the migration retention period

#### Scenario: Candle cutover is rolled back
- **WHEN** a blocking integrity or replay defect is found after canonical OHLCV cutover
- **THEN** producers MAY return to the legacy candle write path without dropping canonical data
- **AND** the defect and affected capture bundles MUST remain diagnosable

### Requirement: Capture output is replay-consumable
The system SHALL prove that canonical ClickHouse rows can be selected by exchange, pair, capture bundle, and replay window and converted into Maker-compatible inputs without losing source identity or checksum verifiability.

#### Scenario: Replay selects a capture window
- **WHEN** a replay consumer queries one or more capture bundles for an exchange, pair, and time window
- **THEN** the query MUST return only matching source-time rows
- **AND** every returned normalized row MUST retain enough metadata to verify its capture linkage and checksum

#### Scenario: Cross-language contract fixture is validated
- **WHEN** CI runs the broker-to-Maker replay contract fixtures
- **THEN** the ClickHouse row projection and Maker reader MUST agree on field semantics, timestamps, source modes, and checksum values
