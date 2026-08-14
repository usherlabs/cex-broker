## MODIFIED Requirements

### Requirement: Live ORDERBOOK stream remains backward compatible
The broker SHALL preserve existing `Subscribe(ORDERBOOK)` response behavior while allowing enriched order-book metadata for Maker live envelope compatibility. Matching ORDERBOOK subscribers SHALL share one exchange-default upstream watch, and the broker MUST project the full normalized snapshot to each subscriber's requested `depthLimit` or legacy `limit` without using depth as physical feed identity.

#### Scenario: Existing raw order-book consumers still decode stream data
- **WHEN** a client subscribes to `Subscribe(ORDERBOOK)`
- **THEN** each successful frame's `data` JSON MUST continue to contain `bids` and `asks` arrays at the top level
- **AND** old clients that only read `bids` and `asks` MUST continue to work

#### Scenario: Stream frames include metadata for new clients
- **WHEN** the provider returns an order-book update with timestamp or sequence metadata
- **THEN** the broker MUST include equivalent metadata in the frame `data` JSON without removing the existing top-level `bids` and `asks`
- **AND** the `SubscribeResponse.timestamp` MUST record the broker received timestamp

#### Scenario: Explicit and omitted depths overlap
- **WHEN** one client requests depth N and another client omits depth for the same canonical ORDERBOOK feed
- **THEN** the broker MUST call the upstream `watchOrderBook` without a depth argument once per physical iteration
- **AND** the explicit-depth response MUST contain at most N bids and N asks while the omitted-depth response MUST retain the exchange-default snapshot
- **AND** the broker MUST sample and archive the unsliced normalized snapshot once

#### Scenario: Legacy limit alias is supplied
- **WHEN** a client supplies legacy `limit = N` instead of `depthLimit`
- **THEN** its streamed response MUST apply the same top-N projection as `depthLimit = N`
- **AND** the alias MUST NOT create a distinct upstream watcher

#### Scenario: Omitted or legacy subscription type remains orderbook
- **WHEN** a client omits subscription type or sends `NO_ACTION`
- **THEN** the broker MUST continue resolving the request to `ORDERBOOK`
- **AND** this compatibility behavior MUST be covered by tests

#### Scenario: Stream error frames remain explicit
- **WHEN** the broker cannot continue an order-book stream
- **THEN** it MUST emit an error frame or stream error that identifies the failure
- **AND** it MUST NOT emit an empty successful order-book frame as a failure substitute
