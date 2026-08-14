## MODIFIED Requirements

### Requirement: The production collector supervises all required CEX feeds
The production collector SHALL be an independent gRPC client of a separately deployed full CEX Broker and SHALL supervise configured `ORDERBOOK`, `TICKER`, `TRADES`, and `OHLCV` subscriptions independently for every strategy exchange and pair. It SHALL NOT start an embedded broker, instantiate CCXT exchanges, own CEX credentials, or own archive delivery. The collector SHALL sustain configured capture coverage and liveness, while the broker SHALL own and share each canonical physical public feed and its archive path with any matching third-party subscription.

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

#### Scenario: Matching third-party subscription is active
- **WHEN** the collector and a third-party client subscribe to the same canonical public feed
- **THEN** the broker MUST service both logical subscriptions from one physical exchange watcher and archive owner
- **AND** the collector MUST remain the coverage/liveness subscriber rather than the mechanism that prevents duplicate physical capture

#### Scenario: OHLCV bootstrap is supported
- **WHEN** the first OHLCV subscriber creates a canonical feed with a configured bootstrap window
- **THEN** the broker MUST fetch and archive available historical bars before or alongside the live stream
- **AND** bootstrap rows MUST use a source mode distinct from live stream rows
- **AND** later subscriber bootstrap delivery for the same feed MUST NOT create additional archived bootstrap rows

#### Scenario: Collector stops
- **WHEN** the collector receives a termination signal
- **THEN** it MUST cancel its remote subscriptions and close its gRPC client without waiting for or shutting down the remote broker
