## ADDED Requirements

### Requirement: Canonical public feed identity excludes subscriber presentation and account identity
The broker SHALL identify a public market-data worker by exchange normalized with `trim().toLowerCase()`, resolved symbol, market type, and feed type, with a venue-resolved acquisition profile added for ORDERBOOK or timeframe added for OHLCV. An omitted or empty OHLCV timeframe MUST resolve to `1m`. The identity MUST NOT include request credentials, account selector, raw ORDERBOOK `depthLimit` or legacy `limit`, or OHLCV bootstrap limit.

#### Scenario: Equivalent public subscriptions use one identity
- **WHEN** clients subscribe to the same exchange, resolved symbol, market type, and public feed with different account selectors, request credentials, or presentation options that resolve to the same physical profile
- **THEN** the broker MUST attach them to the same canonical public feed worker
- **AND** credential values and credential-derived hashes MUST NOT enter the worker key

#### Scenario: Physically distinct feeds remain separate
- **WHEN** subscriptions differ by normalized exchange, resolved symbol, market type, or feed type, ORDERBOOK subscriptions resolve to incompatible acquisition profiles, or OHLCV subscriptions differ by resolved timeframe
- **THEN** the broker MUST create separate canonical feed workers

#### Scenario: Raw depths map to one physical profile
- **WHEN** two ORDERBOOK requests have different raw limits but a verified venue resolver maps both to one acquisition profile that covers their requested and archive depths
- **THEN** the raw limits MUST remain subscriber projection metadata and MUST NOT split the worker key

#### Scenario: Unknown venue uses conservative depth identity
- **WHEN** an ORDERBOOK request targets a venue without a verified coalescing resolver
- **THEN** the fallback profile MUST include the explicit requested depth or an omitted-depth sentinel
- **AND** the broker MUST preserve separate physical workers until equivalence is verified for that venue

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

#### Scenario: Departing request owner is not the final subscriber
- **WHEN** the first subscriber caused creation of a request-credential exchange, that subscriber disconnects, and another subscriber remains on the worker
- **THEN** the shared exchange MUST stay open and MUST NOT be closed by the departing RPC lifecycle
- **AND** final-subscriber retirement MUST close that exchange exactly once

#### Scenario: Public archive account selector is stable
- **WHEN** a public worker archives an observation using a configured deployment exchange
- **THEN** the row MUST use the configured primary account label as `account_selector` regardless of any subscriber's primary or secondary selector
- **AND** a public worker using a request-created or credentialless exchange MUST omit `account_selector`

### Requirement: Each canonical public feed has one collection and archive owner
The broker runtime SHALL own at most one accepted upstream watch loop, ORDERBOOK sampler or OHLCV tracker, and market archive path for each canonical `ORDERBOOK`, `TICKER`, `TRADES`, or `OHLCV` feed. Every resolved watch tick SHALL produce one archive decision, including a decision that is disabled or sampled out, before subscriber fanout; a decision does not necessarily produce a ClickHouse write. Each accepted physical observation MUST be offered to the archive path at most once by its worker.

#### Scenario: ORDERBOOK worker preserves immediate-hedgeability evidence
- **WHEN** a worker accepts an ORDERBOOK observation used by FIET Maker to cap counterpart DEX liquidity
- **THEN** its retained base snapshot MUST preserve normalized L2 price and aggregate amount levels before subscriber slicing
- **AND** the worker MUST NOT require or synthesize L3 order identity to represent immediately marketable displayed depth

#### Scenario: Concurrent identical subscriptions receive one physical observation
- **WHEN** two or more clients concurrently subscribe to the same canonical public feed and the exchange releases a frame
- **THEN** the broker MUST invoke the corresponding CCXT watch once for that feed iteration
- **AND** it MUST run one sampler or tracker and one archive decision for the physical observation
- **AND** every healthy subscriber MUST receive its applicable response frame

#### Scenario: Archive delivery is slow or disabled
- **WHEN** archive submission is disabled, sampled out, or completes independently of client delivery
- **THEN** the worker MUST preserve a single archive decision for the physical observation
- **AND** one subscriber's gRPC backpressure MUST NOT multiply or block the physical archive path

#### Scenario: Subscriber write is backpressured
- **WHEN** one subscriber's write returns backpressure while the shared watch continues producing observations
- **THEN** the worker MUST continue making archive decisions and enqueueing frames for other healthy subscribers without waiting for that subscriber's drain
- **AND** each healthy subscriber MUST receive its frames in FIFO order until its own capacity limit is exceeded

#### Scenario: Late subscriber attaches to an active worker
- **WHEN** a subscriber attaches after a worker has already accepted one or more ORDERBOOK, TICKER, TRADES, or live OHLCV frames
- **THEN** it MUST wait for the next accepted physical observation and MUST NOT receive a cached live frame
- **AND** attachment MUST NOT create an additional archive offer for prior observations

### Requirement: OHLCV bootstrap is archived once per worker
An OHLCV worker SHALL own one live bar tracker and at most one successfully archived historical bootstrap for its timeframe. A zero or false bootstrap request MUST NOT claim archive-bootstrap ownership. The first positive bootstrap request MUST claim ownership atomically; failure MUST be non-fatal and release the claim for a later positive request. After successful completion, a later subscriber bootstrap MUST be delivered only to that subscriber and MUST NOT update the shared tracker or archive path.

#### Scenario: First positive subscriber requests bootstrap history
- **WHEN** an OHLCV worker has no completed bootstrap and a subscriber requests a positive bootstrap limit
- **THEN** the broker MUST fetch and offer the available historical bars to the archive path once using the bootstrap source mode
- **AND** the worker MUST seed its single tracker consistently with that bootstrap

#### Scenario: First subscriber disables bootstrap
- **WHEN** the first subscriber creates an OHLCV worker with bootstrap limit `0` or `false`
- **THEN** the worker MUST start live collection without fetching history and MUST keep archive-bootstrap ownership unclaimed
- **AND** a later positive collector attach or restart MUST be allowed to claim and archive the bootstrap once

#### Scenario: Archive-owner bootstrap fetch fails
- **WHEN** the positive request that claimed archive-bootstrap ownership cannot fetch history
- **THEN** the failure MUST NOT terminate its live subscription or mutate the shared tracker
- **AND** ownership MUST return to unclaimed so a later positive request can retry

#### Scenario: Later subscriber bootstrap is fetched for delivery
- **WHEN** an OHLCV worker already has a completed archived bootstrap and the broker fetches bootstrap history requested by a later subscriber for the same canonical key
- **THEN** the broker MUST deliver that fetched history only to the requesting subscriber
- **AND** it MUST NOT archive those later bootstrap rows or mutate the shared live tracker

#### Scenario: Later bootstrap is ordered before live delivery
- **WHEN** a later subscriber requests bootstrap while the shared worker continues accepting live OHLCV frames
- **THEN** that subscriber MUST receive its available bootstrap frames before its first live frame
- **AND** neither those bootstrap frames nor their ordering buffer MUST mutate the shared tracker or create archive offers

#### Scenario: Later bootstrap fetch fails
- **WHEN** a worker already has a completed archived bootstrap and a later subscriber-local bootstrap fetch fails
- **THEN** the subscriber MUST remain attached for subsequent live frames
- **AND** the shared tracker and archived-bootstrap state MUST remain unchanged

### Requirement: Subscriber fanout is bounded and isolates slow clients
Each public feed subscription SHALL use an in-process O(1) ring buffer limited to 16 queued frames and 1 MiB of protobuf-wire-encoded queued `SubscribeResponse` data. The production limits MUST be fixed, and test construction MUST support smaller injected limits solely to prove boundary behavior. Frames MUST remain FIFO while within capacity.

#### Scenario: Subscriber exceeds the frame limit
- **WHEN** enqueueing a frame would exceed one subscriber's 16-frame limit
- **THEN** the broker MUST terminate only that subscriber with `Public market-data subscriber fell behind` in the existing JSON terminal error form through the normal `writeSubscribeError` terminal path
- **AND** archival, the worker, and healthy subscribers MUST continue

#### Scenario: Subscriber exceeds the byte limit
- **WHEN** enqueueing a full wire-encoded response would exceed one subscriber's 1 MiB byte limit before the frame limit is reached
- **THEN** the broker MUST terminate only that subscriber, release its queued memory, and use the same terminal error text
- **AND** other subscribers MUST continue receiving the shared feed

#### Scenario: First frame alone exceeds byte capacity
- **WHEN** an empty subscriber queue receives one full wire-encoded `SubscribeResponse` larger than 1 MiB
- **THEN** that subscriber MUST fail immediately with `Public market-data subscriber fell behind`
- **AND** the oversized frame MUST NOT be retained or affect the worker, archive path, or other subscribers

#### Scenario: Overflow telemetry is emitted
- **WHEN** a subscriber is terminated for either capacity limit
- **THEN** the broker MUST record an overflow metric using credential-free public feed dimensions
- **AND** the metric MUST NOT contain account selectors, API keys, secrets, or credential-derived hashes

### Requirement: Worker retirement and failure are deterministic
The supervisor SHALL retire a worker when its final subscriber leaves, when its upstream watcher fails, when the broker runtime is replaced, or when the broker stops. Retirement MUST remove the worker from the attachable registry before asynchronous cleanup, ignore late watch results, invoke the feed-specific `unWatch*` method when supported, and close only worker-owned exchanges.

#### Scenario: One of multiple subscribers leaves
- **WHEN** one subscriber closes while another subscriber remains
- **THEN** the worker and upstream watch MUST remain active for the remaining subscriber

#### Scenario: Request-created exchange outlives its creating RPC
- **WHEN** the RPC that caused a request-created public exchange disconnects while another subscriber remains
- **THEN** the worker MUST retain the exchange and its watch for the remaining subscriber
- **AND** only final-subscriber retirement MUST close the exchange, at most once

#### Scenario: Final subscriber leaves during an in-flight watch
- **WHEN** the final subscriber leaves and the in-flight watch later resolves
- **THEN** the retired worker MUST NOT archive or fan out that late result
- **AND** cleanup MUST invoke supported unwatch and owned-exchange close operations at most once

#### Scenario: Configured primary lacks feed-specific unwatch
- **WHEN** the final subscriber retires a worker on a configured primary that has no relevant `unWatch*` method
- **THEN** a generation-fenced retirement barrier MUST ignore the predecessor's late result and prevent a replacement worker from starting its first watch until the in-flight predecessor settles
- **AND** expiration of the bounded retirement timeout MUST fail the new subscription explicitly rather than run overlapping accepted loops on the same exchange instance

#### Scenario: Subscriber arrives during configured-primary retirement
- **WHEN** a new matching Subscribe call arrives while a configured-primary predecessor is retiring
- **THEN** it MUST NOT attach to the retired worker or share its in-flight promise
- **AND** it MUST wait for the retirement barrier before a fresh worker starts, preserving at most one accepted watch loop for the profile

#### Scenario: Upstream watcher fails
- **WHEN** a canonical worker's CCXT watcher throws or cannot continue
- **THEN** every current subscriber MUST receive a terminal feed error and the worker MUST retire
- **AND** a later Subscribe call for the same key MUST create a fresh worker subject to any retirement barrier

#### Scenario: Bare stream close is observed without cancellation
- **WHEN** the gRPC call emits a bare `close` event without cancellation, end, error, runtime shutdown, or a blocked write
- **THEN** the broker MUST preserve the established subscription rather than treating the bare event alone as final unsubscribe

#### Scenario: Bare close occurs during blocked drain
- **WHEN** a subscriber is waiting for gRPC drain and the call emits `close` without a separate cancellation
- **THEN** the blocked write MUST follow the existing terminal transport-failure behavior and remove only that subscriber
- **AND** the worker, archive path, and other subscribers MUST continue

#### Scenario: Broker runtime is replaced
- **WHEN** `CEXBroker.run()` replaces the active gRPC runtime after a policy reload
- **THEN** it MUST retire and await all old public workers before replacement completes
- **AND** it MUST preserve configured primary exchanges while closing request-created exchanges once

#### Scenario: Broker stops
- **WHEN** `CEXBroker.stop()` shuts down the runtime
- **THEN** it MUST wait for supervisor retirement and cleanup before resolving
- **AND** configured primary exchanges MUST remain owned by their existing pool shutdown path while request-created public exchanges close once

### Requirement: Credential-scoped and write behavior remains outside public multiplexing
The public feed supervisor SHALL accept only ORDERBOOK, TICKER, TRADES, and OHLCV. BALANCE, ORDERS, execution/write archive, account routing, and archive-forwarder retry and deduplication MUST retain their existing credential-scoped behavior.

#### Scenario: Account-scoped subscription is requested
- **WHEN** a client subscribes to BALANCE or ORDERS for a configured account
- **THEN** the request MUST use the existing account/user-data path and MUST NOT attach to a public feed worker

#### Scenario: Archive-forwarder retries a submitted batch
- **WHEN** archive delivery retries, restarts, or encounters a duplicate logical event after the public worker submits its single capture
- **THEN** the existing durable spool, retry token, append-only evidence, and canonical deduplication behavior MUST remain unchanged
