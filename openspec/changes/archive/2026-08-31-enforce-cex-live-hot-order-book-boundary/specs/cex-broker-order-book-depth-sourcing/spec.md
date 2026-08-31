## MODIFIED Requirements

### Requirement: Live ORDERBOOK stream remains backward compatible

The broker SHALL preserve existing `Subscribe(ORDERBOOK)` response behavior while allowing enriched order-book metadata for Maker live-envelope compatibility. ORDERBOOK is a normalized price-aggregated L2 feed used to measure displayed base quantity that can be immediately sold into bids or bought from asks inside a configured price band; true L3/order-by-order identity and queue position are outside its scope. The broker MUST resolve each subscriber request to a venue-specific physical acquisition profile, share explicitly enabled compatible candidates, conservatively isolate absent or inactive candidates, and project each retained in-memory base snapshot to the subscriber's requested `depthLimit` or legacy `limit`.

The live/current projection and its in-memory coverage verdict SHALL remain independent from the hot archive contract. In-memory levels MAY prove live band coverage for the requesting subscriber and CEX Proof A. Persisted level rows SHALL remain bounded diagnostics only; summary `schema_version = '2.0.0'` SHALL be the sole supported hot exact-or-censored depth claim. Reproducing a Maker position policy from archived CEX levels is not a CEX requirement.

#### Scenario: L2 levels support immediate hedgeability calculation

- **WHEN** FIET Maker evaluates immediate sell capacity inside band B from a current or live snapshot
- **THEN** the retained in-memory snapshot MUST preserve ordered bid `[price, amount]` levels so eligible displayed bid amounts at or above `mid * (1 - B / 10_000)` can be summed
- **AND** immediate buy capacity MUST be calculable from ordered ask `[price, amount]` levels at or below `mid * (1 + B / 10_000)`

#### Scenario: L3 identity is not required for the cap

- **WHEN** a subscriber or verifier derives the immediate hedgeability cap from normalized L2 levels
- **THEN** it MUST NOT require individual order IDs, maker identity, or queue priority to compute aggregate displayed quantity at each price
- **AND** executed-volume or passive-fill analysis MUST NOT be represented as part of this ORDERBOOK depth contract

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

#### Scenario: Enabled Binance candidate depths resolve to a coalesced profile

- **WHEN** a controlled composition explicitly enables the Binance candidate and ORDERBOOK subscribers request depths that its public L2 acquisition profile can satisfy, including the configured archive depth
- **THEN** the Binance resolver MUST map them to the same stable profile and MUST NOT pass their arbitrary raw projection limits as distinct physical channel identities
- **AND** one retained base snapshot MUST serve their independent top-N projections

#### Scenario: Enabled MEXC candidate depths resolve to a coalesced profile

- **WHEN** a controlled composition explicitly enables the MEXC candidate and ORDERBOOK subscribers request depths that its public L2 acquisition profile can satisfy, including the configured archive depth
- **THEN** the MEXC resolver MUST map them to the same stable profile and MUST NOT create depth-specific physical workers for limits that do not select distinct MEXC watch channels
- **AND** one retained base snapshot MUST serve their independent top-N projections

#### Scenario: Venue candidate is absent or inactive

- **WHEN** an ORDERBOOK request targets a venue without a candidate resolver or whose candidate is not in the explicitly supplied enabled-profile set
- **THEN** an explicit requested depth and an omitted-depth request MUST resolve to conservative distinct profile identities and preserve the existing upstream limit/default call behavior
- **AND** the broker MUST NOT claim that those requests share an equivalent physical feed

#### Scenario: Production candidate set is empty

- **WHEN** the broker runtime uses this change's ordinary production configuration without a test or controlled-sidecar candidate override
- **THEN** the enabled-profile set MUST be empty and Binance and MEXC requests MUST use conservative depth identities
- **AND** passing or locating an evidence artifact at runtime MUST NOT implicitly enable a candidate

#### Scenario: Existing profile cannot satisfy a later deeper request

- **WHEN** a later subscriber requires more retained depth than an active acquisition profile guarantees
- **THEN** the broker MUST start or attach to a separate compatible profile instead of mutating or hot-swapping the active worker
- **AND** subscribers on the original profile MUST continue without interruption

#### Scenario: In-memory levels prove live price-band coverage

- **WHEN** a live verification policy requires immediate hedgeability evidence for band B
- **THEN** the retained in-memory L2 snapshot MUST include a farthest bid at or below the bid boundary and a farthest ask at or above the ask boundary, or MUST carry validated provider evidence that the corresponding visible side is exhausted
- **AND** a nominal `depthLimit` count by itself MUST NOT be treated as proof that the live price band is covered

#### Scenario: In-memory levels stop inside a required band

- **WHEN** the farthest retained in-memory bid or ask remains inside a required live band and the provider does not prove exhaustion
- **THEN** the calculated displayed depth MUST be classified as an incomplete conservative lower bound
- **AND** CEX Proof A replay sufficiency MUST fail with band, side, boundary price, farthest retained price, and retained level count diagnostics before any exact live-policy claim is consumed

#### Scenario: Legacy limit alias is supplied

- **WHEN** a client supplies legacy `limit = N` instead of `depthLimit`
- **THEN** its streamed response MUST apply the same top-N projection and report the same `depthLimit: N` metadata as `depthLimit = N`
- **AND** the alias MUST resolve to the same acquisition profile as an equivalent `depthLimit`

#### Scenario: Base snapshot is deeper than the archive limit

- **WHEN** a resolved acquisition profile returns more levels than the configured ORDERBOOK archive depth
- **THEN** summary v2 MUST be calculated from the complete validated observation before the archive persists at most configured N levels per side using `sampled_top_n_snapshot`
- **AND** subscriber projection MUST remain independent of archive N and MUST NOT create a second archive offer

#### Scenario: Hot archive does not reproduce a Maker position policy

- **WHEN** a downstream policy needs persisted hot depth evidence for requested depth P or one or more measurement bands
- **THEN** the supported summary-v2 row MUST be the sole source of exact-or-censored claim rights
- **AND** configured archive N need not be at least P
- **AND** bounded archived level rows MUST NOT reproduce, replace, or upgrade the summary-v2 coverage verdict

#### Scenario: Omitted or legacy subscription type remains orderbook

- **WHEN** a client omits subscription type or sends `NO_ACTION`
- **THEN** the broker MUST continue resolving the request to `ORDERBOOK`
- **AND** this compatibility behavior MUST be covered by tests

#### Scenario: Stream error frames remain explicit

- **WHEN** the broker cannot resolve or continue an order-book acquisition profile
- **THEN** it MUST emit an error frame or stream error that identifies the failure
- **AND** it MUST NOT emit an empty successful order-book frame as a failure substitute

### Requirement: Historical order-book snapshots return typed success or typed unsupported

The broker SHALL preserve the typed historical-result wire shape but SHALL NOT source, reconstruct, write, or advertise historical order-book snapshots. Every historical order-book request SHALL return the typed unsupported result; current or live observations SHALL never be relabeled as historical evidence.

#### Scenario: Historical request is typed unsupported

- **WHEN** a client requests historical snapshots for any exchange, symbol, start, end, cadence, construction mode, or depth limit
- **THEN** the response MUST include `exchange`, `symbol`, `unsupported = true`, and `unsupportedReason = "historical_order_book_provider_unsupported"`
- **AND** the broker MUST return this as a successful `ActionResponse.result` JSON payload rather than a transport failure

#### Scenario: Live book is not used as historical evidence

- **WHEN** a client requests historical snapshots for a past time window
- **THEN** the broker MUST NOT satisfy the request by sampling the current live order book after the requested window
- **AND** unavailable historical support MUST be reported as typed unsupported

#### Scenario: Exact reconstruction request is unsupported

- **WHEN** a client requests `constructionMode = "exact_l2_reconstruction"`
- **THEN** the broker MUST return typed unsupported and report exact reconstruction as unsupported in capability discovery
- **AND** it MUST NOT downgrade the request to sampled top-N

### Requirement: Capability discovery is truthful and provider-scoped

The broker SHALL report current and live order-book capabilities conservatively from actual broker/provider behavior for the requested exchange, symbol, and depth limit. Historical sampled-top-N and exact-L2-reconstruction capabilities SHALL remain false because historical sourcing and reconstruction are outside the CEX Broker boundary.

#### Scenario: Current and live support reflect provider methods

- **WHEN** `fetch_order_book_capability` is called
- **THEN** `supportsCurrentSnapshot` MUST be true only when the broker can fetch a current order-book snapshot for the requested exchange and symbol
- **AND** `supportsLiveStream` MUST be true only when the broker can stream order-book updates for the requested exchange and symbol

#### Scenario: Historical support remains outside CEX Broker

- **WHEN** capability is requested for any provider or supported construction mode
- **THEN** the broker MUST set `supportsHistoricalSnapshots = false`
- **AND** it MUST set `supportsSampledTopN = false` for historical acquisition

#### Scenario: Exact L2 reconstruction is not advertised

- **WHEN** capability is requested
- **THEN** `supportsExactL2Reconstruction` MUST be false

#### Scenario: MEXC capability uses CCXT provider identity

- **WHEN** capability is requested for MEXC
- **THEN** the broker MUST report a CCXT-backed provider identity for current/live order-book support when using CCXT
- **AND** historical sampled-top-N and exact reconstruction support MUST remain false

#### Scenario: Binance native Hummingbot capability is not fabricated

- **WHEN** capability is requested for Binance in this TypeScript broker
- **THEN** the broker MUST NOT advertise native Hummingbot historical support
- **AND** it MUST report CCXT-backed broker support only for current/live capabilities actually available through the broker
