## MODIFIED Requirements

### Requirement: Archive source identity is deployment controlled
The archive plane SHALL support the closed source identities `broker_read` and `broker_write`, selected from immutable deployment configuration and propagated consistently to every row and batch envelope. Archive source SHALL remain provenance and SHALL NOT determine whether the full broker exposes its gRPC service.

#### Scenario: Read broker archives a market frame
- **WHEN** a broker configured with archive source `broker_read` archives a market-data frame
- **THEN** every normalized row and its archive envelope MUST contain `source = "broker_read"`
- **AND** clients MUST NOT be able to override that source through request fields or metadata

#### Scenario: Envelope and row sources disagree
- **WHEN** an archive batch contains a row whose source differs from the envelope source
- **THEN** the archive forwarder MUST reject the inconsistent batch or row before ClickHouse insertion
- **AND** it MUST emit a bounded diagnostic without exposing credentials or raw secrets

#### Scenario: FIET-901 production capture uses the read archive source
- **WHEN** deployment verification evaluates the broker/archiver hosting FIET-901 continuous production subscriptions
- **THEN** it MUST require archive source `broker_read`, an explicit deployment identity, and an explicit capture bundle before declaring the deployment ready
- **AND** the core broker MUST NOT infer or enforce that deployment role from subscription traffic
- **AND** unrelated TEE or write-broker deployments MAY archive their own market observations as `broker_write`

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

### Requirement: The production collector supervises all required CEX feeds
The production collector SHALL be an independent gRPC client of a separately deployed full CEX Broker and SHALL supervise configured `ORDERBOOK`, `TICKER`, `TRADES`, and `OHLCV` subscriptions independently for every strategy exchange and pair. It SHALL NOT start an embedded broker, instantiate CCXT exchanges, own CEX credentials, or own archive delivery.

#### Scenario: Strategy capture configuration is loaded
- **WHEN** production collection starts with strategy exchange/pair/feed configuration and an explicit broker target
- **THEN** it MUST validate that each required feed has a supervisor and required options such as depth limit or timeframe
- **AND** failure of one feed MUST NOT terminate supervisors for other feeds or pairs

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

#### Scenario: OHLCV bootstrap is supported
- **WHEN** an OHLCV subscription starts with a configured bootstrap window
- **THEN** the broker MUST fetch and archive available historical bars before or alongside the live stream
- **AND** bootstrap rows MUST use a source mode distinct from live stream rows

#### Scenario: Collector stops
- **WHEN** the collector receives a termination signal
- **THEN** it MUST cancel its remote subscriptions and close its gRPC client without waiting for or shutting down the remote broker

## ADDED Requirements

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
