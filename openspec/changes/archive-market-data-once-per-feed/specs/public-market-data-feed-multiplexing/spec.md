## ADDED Requirements

### Requirement: Canonical public feed identity excludes subscriber presentation and account identity
The broker SHALL identify a public market-data worker by normalized exchange, resolved symbol, market type, and feed type, with timeframe added for OHLCV. The identity MUST NOT include request credentials, account selector, ORDERBOOK `depthLimit` or legacy `limit`, or OHLCV bootstrap limit.

#### Scenario: Equivalent public subscriptions use one identity
- **WHEN** clients subscribe to the same exchange, resolved symbol, market type, and public feed with different account selectors, request credentials, or presentation options
- **THEN** the broker MUST attach them to the same canonical public feed worker
- **AND** credential values and credential-derived hashes MUST NOT enter the worker key

#### Scenario: Physically distinct feeds remain separate
- **WHEN** subscriptions differ by normalized exchange, resolved symbol, market type, or feed type, or OHLCV subscriptions differ by timeframe
- **THEN** the broker MUST create separate canonical feed workers

### Requirement: Public feed broker selection has stable precedence
For a canonical public feed, the broker SHALL use the configured primary exchange instance when available, then a request-credential exchange only when no configured deployment exchange exists, then a credentialless public exchange. Secondary account selection MUST NOT change public feed identity or select a secondary exchange instance.

#### Scenario: Configured primary exchange exists
- **WHEN** a public feed is requested for an exchange with a configured primary and one or more secondary accounts
- **THEN** the canonical worker MUST use the configured primary exchange regardless of the request account selector
- **AND** retiring the worker MUST NOT close the configured primary exchange

#### Scenario: Deployment exchange is absent
- **WHEN** no configured exchange exists and valid request credentials can create the requested exchange
- **THEN** the worker MUST use the request-created exchange and own its cleanup
- **AND** it MUST use a credentialless public exchange only when no request-credential exchange can be created

### Requirement: Each canonical public feed has one collection and archive owner
The broker runtime SHALL own at most one active upstream watch loop, ORDERBOOK sampler or OHLCV tracker, and market archive path for each canonical `ORDERBOOK`, `TICKER`, `TRADES`, or `OHLCV` feed. Each accepted physical observation MUST be offered to the archive path once before it is fanned out to subscribers.

#### Scenario: Concurrent identical subscriptions receive one physical observation
- **WHEN** two or more clients concurrently subscribe to the same canonical public feed and the exchange releases a frame
- **THEN** the broker MUST invoke the corresponding CCXT watch once for that feed iteration
- **AND** it MUST run one sampler or tracker and one archive submission for the physical observation
- **AND** every healthy subscriber MUST receive its applicable response frame

#### Scenario: Archive delivery is slow or disabled
- **WHEN** archive submission is disabled, sampled out, or completes independently of client delivery
- **THEN** the worker MUST preserve a single archive decision for the physical observation
- **AND** one subscriber's gRPC backpressure MUST NOT multiply or block the physical archive path

### Requirement: OHLCV bootstrap is archived once per worker
An OHLCV worker SHALL own one live bar tracker and one archived historical bootstrap for its timeframe. The first subscriber's bootstrap request MUST establish that archived bootstrap; a later subscriber bootstrap MUST be delivered only to that subscriber and MUST NOT update the shared tracker or archive path.

#### Scenario: First subscriber requests bootstrap history
- **WHEN** the first subscriber creates an OHLCV worker with a bootstrap limit
- **THEN** the broker MUST fetch and offer the available historical bars to the archive path once using the bootstrap source mode
- **AND** the worker MUST seed its single tracker consistently with that bootstrap

#### Scenario: Later subscriber bootstrap is fetched for delivery
- **WHEN** an OHLCV worker already exists and the broker fetches bootstrap history requested by a later subscriber for the same canonical key
- **THEN** the broker MUST deliver that fetched history only to the requesting subscriber
- **AND** it MUST NOT archive those later bootstrap rows or mutate the shared live tracker

### Requirement: Subscriber fanout is bounded and isolates slow clients
Each public feed subscription SHALL use an in-process O(1) ring buffer limited to 16 queued frames and 1 MiB of serialized queued response data. The production limits MUST be fixed, and test construction MUST support smaller injected limits solely to prove boundary behavior.

#### Scenario: Subscriber exceeds the frame limit
- **WHEN** enqueueing a frame would exceed one subscriber's 16-frame limit
- **THEN** the broker MUST terminate only that subscriber with the existing JSON terminal error form
- **AND** archival, the worker, and healthy subscribers MUST continue

#### Scenario: Subscriber exceeds the byte limit
- **WHEN** enqueueing a serialized response would exceed one subscriber's 1 MiB byte limit before the frame limit is reached
- **THEN** the broker MUST terminate only that subscriber and release its queued memory
- **AND** other subscribers MUST continue receiving the shared feed

#### Scenario: Overflow telemetry is emitted
- **WHEN** a subscriber is terminated for either capacity limit
- **THEN** the broker MUST record an overflow metric using credential-free public feed dimensions
- **AND** the metric MUST NOT contain account selectors, API keys, secrets, or credential-derived hashes

### Requirement: Worker retirement and failure are deterministic
The supervisor SHALL retire a worker when its final subscriber leaves, when its upstream watcher fails, or when the broker runtime shuts down. Retirement MUST remove the worker from the registry before asynchronous cleanup, ignore late watch results, invoke the feed-specific `unWatch*` method when supported, and close only worker-owned exchanges.

#### Scenario: One of multiple subscribers leaves
- **WHEN** one subscriber closes while another subscriber remains
- **THEN** the worker and upstream watch MUST remain active for the remaining subscriber

#### Scenario: Final subscriber leaves during an in-flight watch
- **WHEN** the final subscriber leaves and the in-flight watch later resolves
- **THEN** the retired worker MUST NOT archive or fan out that late result
- **AND** cleanup MUST invoke supported unwatch and owned-exchange close operations at most once

#### Scenario: Upstream watcher fails
- **WHEN** a canonical worker's CCXT watcher throws or cannot continue
- **THEN** every current subscriber MUST receive a terminal feed error and the worker MUST retire
- **AND** a later Subscribe call for the same key MUST create a fresh worker

#### Scenario: Bare stream close is observed without cancellation
- **WHEN** the gRPC call emits a bare `close` event without cancellation, end, error, or runtime shutdown
- **THEN** the broker MUST preserve the established subscription rather than treating the bare event alone as final unsubscribe

### Requirement: Credential-scoped and write behavior remains outside public multiplexing
The public feed supervisor SHALL accept only ORDERBOOK, TICKER, TRADES, and OHLCV. BALANCE, ORDERS, execution/write archive, account routing, and archive-forwarder retry and deduplication MUST retain their existing credential-scoped behavior.

#### Scenario: Account-scoped subscription is requested
- **WHEN** a client subscribes to BALANCE or ORDERS for a configured account
- **THEN** the request MUST use the existing account/user-data path and MUST NOT attach to a public feed worker

#### Scenario: Archive-forwarder retries a submitted batch
- **WHEN** archive delivery retries, restarts, or encounters a duplicate logical event after the public worker submits its single capture
- **THEN** the existing durable spool, retry token, append-only evidence, and canonical deduplication behavior MUST remain unchanged
