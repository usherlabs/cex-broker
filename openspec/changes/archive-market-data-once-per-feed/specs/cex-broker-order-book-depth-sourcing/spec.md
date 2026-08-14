## MODIFIED Requirements

### Requirement: Live ORDERBOOK stream remains backward compatible
The broker SHALL preserve existing `Subscribe(ORDERBOOK)` response behavior while allowing enriched order-book metadata for Maker live envelope compatibility. ORDERBOOK is a normalized price-aggregated L2 feed in this capability; true L3/order-by-order identity is outside its scope. The broker MUST resolve each subscriber request to a venue-specific physical acquisition profile, share compatible profiles, conservatively isolate unverified profiles, and project each retained base snapshot to the subscriber's requested `depthLimit` or legacy `limit`.

#### Scenario: Existing raw order-book consumers still decode stream data
- **WHEN** a client subscribes to `Subscribe(ORDERBOOK)`
- **THEN** each successful frame's `data` JSON MUST continue to contain `bids` and `asks` arrays at the top level
- **AND** old clients that only read `bids` and `asks` MUST continue to work

#### Scenario: Stream frames include metadata for new clients
- **WHEN** the provider returns an order-book update with timestamp or sequence metadata
- **THEN** the broker MUST include equivalent metadata in the frame `data` JSON without removing the existing top-level `bids` and `asks`
- **AND** the `SubscribeResponse.timestamp` MUST record the broker received timestamp

#### Scenario: Compatible explicit and omitted depths overlap
- **WHEN** one client requests depth N and another omits depth for the same ORDERBOOK feed and the venue resolver maps both to the same acquisition profile
- **THEN** the broker MUST start one upstream watch loop for that resolved profile
- **AND** the explicit-depth response MUST contain at most N bids and N asks while the omitted-depth response MUST retain every level present in the profile snapshot
- **AND** the explicit response MUST report `depthLimit: N` while the omitted response MUST report the actual retained snapshot depth

#### Scenario: Binance depths resolve to a coalesced profile
- **WHEN** Binance ORDERBOOK subscribers request depths that one verified public L2 acquisition profile can satisfy, including the configured archive depth
- **THEN** the Binance resolver MUST map them to the same stable profile and MUST NOT pass their arbitrary raw projection limits as distinct physical channel identities
- **AND** one retained base snapshot MUST serve their independent top-N projections

#### Scenario: MEXC depths resolve to a coalesced profile
- **WHEN** MEXC ORDERBOOK subscribers request depths that one verified public L2 acquisition profile can satisfy, including the configured archive depth
- **THEN** the MEXC resolver MUST map them to the same stable profile and MUST NOT create depth-specific physical workers for limits that do not select distinct MEXC watch channels
- **AND** one retained base snapshot MUST serve their independent top-N projections

#### Scenario: Venue has no verified coalescing resolver
- **WHEN** an ORDERBOOK request targets a venue without a verified acquisition-profile resolver
- **THEN** an explicit requested depth and an omitted-depth request MUST resolve to conservative distinct profile identities and preserve the existing upstream limit/default call behavior
- **AND** the broker MUST NOT claim that those requests share an equivalent physical feed

#### Scenario: Existing profile cannot satisfy a later deeper request
- **WHEN** a later subscriber requires more retained depth than an active acquisition profile guarantees
- **THEN** the broker MUST start or attach to a separate compatible profile instead of mutating or hot-swapping the active worker
- **AND** subscribers on the original profile MUST continue without interruption

#### Scenario: Legacy limit alias is supplied
- **WHEN** a client supplies legacy `limit = N` instead of `depthLimit`
- **THEN** its streamed response MUST apply the same top-N projection and report the same `depthLimit: N` metadata as `depthLimit = N`
- **AND** the alias MUST resolve to the same acquisition profile as an equivalent `depthLimit`

#### Scenario: Base snapshot is deeper than the archive limit
- **WHEN** a resolved acquisition profile returns more levels than the configured ORDERBOOK archive depth
- **THEN** the archive decision MUST use the retained base snapshot before subscriber projection but MUST persist at most the configured N levels per side using `sampled_top_n_snapshot`
- **AND** subscriber projection MUST remain independent of the archive N and MUST NOT create a second archive offer

#### Scenario: Omitted or legacy subscription type remains orderbook
- **WHEN** a client omits subscription type or sends `NO_ACTION`
- **THEN** the broker MUST continue resolving the request to `ORDERBOOK`
- **AND** this compatibility behavior MUST be covered by tests

#### Scenario: Stream error frames remain explicit
- **WHEN** the broker cannot resolve or continue an order-book acquisition profile
- **THEN** it MUST emit an error frame or stream error that identifies the failure
- **AND** it MUST NOT emit an empty successful order-book frame as a failure substitute
