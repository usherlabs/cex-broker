# cex-broker-order-book-depth-sourcing

## Purpose

The cex-broker SHALL provide HB-compatible broker order-book capability discovery, normalized current snapshots, backward-compatible live stream metadata, typed historical snapshot results, and truthful provider-scoped capability reporting without exposing credentials or private provider metadata.

## Requirements

### Requirement: HB-compatible order-book Call methods
The broker SHALL expose HB-compatible order-book operations through `ExecuteAction` with `Action.Call` without removing the existing generic CCXT Call behavior.

#### Scenario: Maker method payload dispatches order-book capability
- **WHEN** a client sends `Action.Call` with payload field `method = "fetch_order_book_capability"`
- **THEN** the broker MUST return a JSON capability object for the requested `cex`, `symbol`, `depthLimit`, and `constructionMode`
- **AND** the broker MUST NOT attempt to invoke a CCXT method named `fetch_order_book_capability`

#### Scenario: Maker method payload dispatches current snapshot
- **WHEN** a client sends `Action.Call` with payload field `method = "fetch_order_book_snapshot"`
- **THEN** the broker MUST fetch or construct a current top-N order-book snapshot for the requested exchange and symbol
- **AND** the response MUST be decodable by Maker's `fetch_order_book_snapshot` helper

#### Scenario: Maker method payload dispatches historical snapshots
- **WHEN** a client sends `Action.Call` with payload field `method = "fetch_historical_order_book_snapshots"`
- **THEN** the broker MUST return either typed historical snapshots or a typed unsupported historical response
- **AND** the client MUST NOT need to infer historical support from a gRPC transport failure or an empty stream

#### Scenario: Existing generic Call behavior remains available
- **WHEN** a client sends `Action.Call` for a non-order-book CCXT method using the existing generic call payload shape
- **THEN** the broker MUST continue to validate and invoke the generic CCXT call according to existing behavior

#### Scenario: Malformed order-book Call payload is rejected
- **WHEN** an order-book Call payload omits required fields or provides an invalid `depthLimit`, time window, cadence, or construction mode
- **THEN** the broker MUST fail the request with a typed validation error
- **AND** the broker MUST NOT call the provider with partially validated input

### Requirement: Current order-book snapshots are normalized top-N payloads
The broker SHALL return current order-book snapshots using a normalized JSON object that preserves raw `bids` and `asks` arrays and includes source metadata required by Maker HB strategy compatibility.

#### Scenario: Current snapshot includes required fields
- **WHEN** `fetch_order_book_snapshot` succeeds for an exchange, symbol, and depth limit
- **THEN** the response MUST include `bids`, `asks`, `timestamp`, `receivedTimestamp`, `exchange`, `symbol`, and `depthLimit`
- **AND** each bid and ask level MUST be a two-item numeric `[price, amount]` array

#### Scenario: Sequence metadata is preserved when available
- **WHEN** the provider order book includes `sequence`, `updateId`, `lastUpdateId`, or `nonce`
- **THEN** the broker MUST include an equivalent sequence/update identifier in the normalized snapshot

#### Scenario: Snapshot depth honors requested depth limit
- **WHEN** a client requests `depthLimit = N`
- **THEN** the broker MUST request or truncate each side to at most N levels
- **AND** it MUST report `depthLimit = N` in the response

#### Scenario: Exchange and symbol are not substituted
- **WHEN** a client requests an order-book snapshot for a specific `cex` and `symbol`
- **THEN** the response MUST identify the same exchange and symbol
- **AND** the broker MUST NOT silently substitute another exchange or trading pair

### Requirement: Live ORDERBOOK stream remains backward compatible
The broker SHALL preserve existing `Subscribe(ORDERBOOK)` behavior while allowing enriched order-book metadata for Maker live envelope compatibility.

#### Scenario: Existing raw order-book consumers still decode stream data
- **WHEN** a client subscribes to `Subscribe(ORDERBOOK)`
- **THEN** each successful frame's `data` JSON MUST continue to contain `bids` and `asks` arrays at the top level
- **AND** old clients that only read `bids` and `asks` MUST continue to work

#### Scenario: Stream frames include metadata for new clients
- **WHEN** the provider returns an order-book update with timestamp or sequence metadata
- **THEN** the broker MUST include equivalent metadata in the frame `data` JSON without removing the existing top-level `bids` and `asks`
- **AND** the `SubscribeResponse.timestamp` MUST record the broker received timestamp

#### Scenario: Omitted or legacy subscription type remains orderbook
- **WHEN** a client omits subscription type or sends `NO_ACTION`
- **THEN** the broker MUST continue resolving the request to `ORDERBOOK`
- **AND** this compatibility behavior MUST be covered by tests

#### Scenario: Stream error frames remain explicit
- **WHEN** the broker cannot continue an order-book stream
- **THEN** it MUST emit an error frame or stream error that identifies the failure
- **AND** it MUST NOT emit an empty successful order-book frame as a failure substitute

### Requirement: Historical order-book snapshots return typed success or typed unsupported
The broker SHALL define historical sampled top-N order-book behavior as a typed result contract even when no provider currently supports the requested historical data.

#### Scenario: Historical snapshot success payload
- **WHEN** the broker supports sampled top-N historical snapshots for the requested exchange, symbol, start, end, cadence, construction mode, and depth limit
- **THEN** the response MUST include `exchange`, `symbol`, and a `snapshots` array
- **AND** each snapshot MUST satisfy the normalized current snapshot field requirements

#### Scenario: Historical unsupported payload
- **WHEN** the broker does not support the requested historical snapshots
- **THEN** the response MUST include `exchange`, `symbol`, `unsupported = true`, and `unsupportedReason = "historical_order_book_provider_unsupported"`
- **AND** the broker MUST return this as a successful `ActionResponse.result` JSON payload rather than a transport failure

#### Scenario: Live book is not used as historical evidence
- **WHEN** a client requests historical snapshots for a past time window
- **THEN** the broker MUST NOT satisfy the request by sampling the current live order book after the requested window
- **AND** unavailable historical support MUST be reported as typed unsupported

#### Scenario: Exact reconstruction request is unsupported without continuity
- **WHEN** a client requests `constructionMode = "exact_l2_reconstruction"` and the broker lacks a validated snapshot-plus-delta reconstruction path
- **THEN** the broker MUST return typed unsupported or report exact reconstruction as unsupported in capability discovery
- **AND** it MUST NOT downgrade the request to sampled top-N without the client changing construction mode

### Requirement: Capability discovery is truthful and provider-scoped
The broker SHALL report order-book capabilities conservatively from actual broker/provider behavior for the requested exchange, symbol, construction mode, and depth limit.

#### Scenario: Current and live support reflect provider methods
- **WHEN** `fetch_order_book_capability` is called
- **THEN** `supportsCurrentSnapshot` MUST be true only when the broker can fetch a current order-book snapshot for the requested exchange and symbol
- **AND** `supportsLiveStream` MUST be true only when the broker can stream order-book updates for the requested exchange and symbol

#### Scenario: Historical support is not inferred from current support
- **WHEN** the provider supports current order-book snapshots but does not support historical sampled top-N snapshots for the requested parameters
- **THEN** the broker MUST set `supportsHistoricalSnapshots = false`
- **AND** it MUST set `supportsSampledTopN = false` for that historical capability

#### Scenario: Exact L2 reconstruction is not advertised prematurely
- **WHEN** the broker has not implemented snapshot-plus-delta reconstruction with sequence-continuity validation
- **THEN** `supportsExactL2Reconstruction` MUST be false

#### Scenario: MEXC capability uses CCXT provider identity
- **WHEN** capability is requested for MEXC
- **THEN** the broker MUST report a CCXT-backed provider identity for current/live order-book support when using CCXT
- **AND** historical support MUST remain false unless real CCXT-backed historical top-N snapshots are implemented for the requested parameters

#### Scenario: Binance native Hummingbot capability is not fabricated
- **WHEN** capability is requested for Binance in this TypeScript broker
- **THEN** the broker MUST NOT advertise native Hummingbot historical support unless a real native Hummingbot adapter is implemented
- **AND** it MUST report CCXT-backed broker support only for capabilities actually available through the broker

### Requirement: Order-book responses do not leak secrets
The broker SHALL keep order-book response payloads free of raw credentials, API secrets, authorization metadata, and private provider configuration.

#### Scenario: Snapshot response excludes credentials
- **WHEN** a current, live, historical, or capability order-book response is emitted
- **THEN** the response MUST NOT include API keys, API secrets, request signing material, authorization headers, or secret-backed metadata values

#### Scenario: Unsupported response excludes credentials
- **WHEN** a historical request returns typed unsupported
- **THEN** the unsupported response MUST include only non-secret diagnostic fields such as exchange, symbol, provider identity, and unsupported reason
