## ADDED Requirements

### Requirement: FetchFees is an account-scoped trading-commission boundary

`FetchFees` SHALL accept one slash-delimited CCXT unified spot symbol and use an authenticated, account-authoritative trading-fee operation on the broker selected by the outer request metadata. It MUST NOT create a public broker or return transfer fees, public market defaults, or `broker.fees` as account commission.

#### Scenario: MEXC pair commission is observed

- **WHEN** `FetchFees` is called for a supported MEXC spot pair with valid selected-account credentials
- **THEN** the broker MUST call CCXT `fetchTradingFee` for that pair
- **AND** the underlying operation MUST resolve through MEXC's signed symbol commission endpoint
- **AND** the result MUST identify the normalized account selector and whether credentials came from the configured pool or request metadata

#### Scenario: Account commission is unavailable

- **WHEN** the selected exchange lacks a callable account-authoritative trading-fee operation or the response omits either maker or taker commission
- **THEN** unary `FetchFees` MUST fail with gRPC `FAILED_PRECONDITION` and a stable `fee_unavailable:` prefix
- **AND** a batch child failure MUST retain that gRPC status and stable code
- **AND** it MUST NOT populate commission evidence from market-level maker/taker fields, `broker.fees`, or a configured expected profile

#### Scenario: Market loading is symbol resolution only

- **WHEN** `fetchTradingFee` loads markets to resolve a unified symbol to the provider market id
- **THEN** that market loading MUST NOT be treated as the commission source
- **AND** the evidence source method MUST remain the authenticated trading-fee operation

#### Scenario: Token-only fee request is rejected

- **WHEN** `FetchFees` receives a token-only symbol without a base/quote separator
- **THEN** request validation MUST reject it
- **AND** the action MUST NOT reinterpret it as a transfer-fee request

#### Scenario: Legacy funding-fee flags are supplied

- **WHEN** a caller supplies legacy `includeAllFees` or `includeFundingFees` fields after the hard cutover
- **THEN** request validation MUST reject those fields
- **AND** the caller MUST use `FetchCurrency` for transfer-network fee evidence

### Requirement: Trading commission evidence is versioned and exact

A successful `FetchFees` result SHALL be a `cex-trading-fee-evidence/v1` JSON document containing exchange, market type, canonical pair, CCXT unified symbol, exchange-native source symbol, account selector, credential source, observation timestamp, source method, maker rate, taker rate, explicit units, digest algorithm, and deterministic source-response digest.

#### Scenario: Symbol identities are explicit

- **WHEN** evidence is produced for the MEXC ARB-USDC market
- **THEN** `canonicalPair` MUST be `ARB-USDC`
- **AND** `unifiedSymbol` MUST be `ARB/USDC`
- **AND** `sourceSymbol` MUST be the exchange-native symbol sent to the source operation, such as `ARBUSDC`
- **AND** all three fields MUST resolve to the same market

#### Scenario: Fractional rates are returned

- **WHEN** MEXC reports maker commission `0E-18` and taker commission `0.000500000000000000`
- **THEN** the evidence MUST preserve the economic values as canonical decimal strings
- **AND** it MUST report decimal-fraction units
- **AND** any derived basis-point values MUST be exactly `0` and `5` without binary floating-point drift

#### Scenario: Pair-specific rates differ

- **WHEN** ARB-USDC and ARB-USDT return different maker or taker commissions for the same account selector
- **THEN** each `FetchFees` result MUST preserve its own observed values and source symbol
- **AND** the broker MUST NOT coerce either pair to `0/5` or any other expected schedule

#### Scenario: Evidence is observed now

- **WHEN** trading commission evidence is emitted
- **THEN** it MUST report when the broker obtained the observation
- **AND** it MUST NOT include or infer `effectiveFrom`, `effectiveUntil`, or any historical applicability interval

### Requirement: FetchMarketRules exposes typed spot execution constraints

The broker SHALL expose a read-only `FetchMarketRules` action for one market symbol. A successful result SHALL be a `cex-market-rule-evidence/v1` JSON document containing exchange, spot identity, canonical pair, CCXT unified symbol, exchange-native source symbol, base and quote assets, active status, precision mode, price and amount increments, minimum amount, minimum notional, observation timestamp, source method, digest algorithm, and deterministic source-response digest.

#### Scenario: Active MEXC spot market is resolved

- **WHEN** `FetchMarketRules` is called for an active MEXC spot pair
- **THEN** the broker MUST use the selected authenticated broker even though the underlying market data is public
- **AND** it MUST derive the evidence from the loaded CCXT market record
- **AND** it MUST distinguish price and amount increments from minimum amount and minimum notional

#### Scenario: Market rules are incomplete

- **WHEN** the requested market is absent, not spot, inactive, or lacks `precision.price`, `precision.amount`, `limits.amount.min`, or `limits.cost.min`
- **THEN** the action MUST fail with `venue_discovery_unavailable`
- **AND** it MUST not require optional maximum amount, price, or notional limits
- **AND** it MUST NOT substitute controller defaults or values from another pair

### Requirement: FetchCurrency is a requested transfer-network boundary

`FetchCurrency` SHALL accept one asset in `ActionRequest.symbol` and one required network in the action payload. It MUST use the selected authenticated broker even when currency metadata is publicly available. A successful result SHALL be a `cex-transfer-network-evidence/v1` JSON document for only that asset/network target.

#### Scenario: Requested transfer network is resolved

- **WHEN** `FetchCurrency` is called for a supported asset and network
- **THEN** the response MUST identify the requested asset, operator network alias, resolved exchange network id, deposit availability, withdrawal availability, withdrawal fee, every available withdrawal limit, observation timestamp, source method, digest algorithm, and deterministic source-response digest

#### Scenario: Transfer network is unavailable

- **WHEN** the asset is unknown, the network alias cannot be resolved, or the requested network is absent
- **THEN** the action MUST fail with a stable venue-discovery or network-alias error
- **AND** it MUST NOT return another network or an unscoped currency blob

#### Scenario: Legacy unscoped currency request is supplied

- **WHEN** `FetchCurrency` omits the required network after the hard cutover
- **THEN** request validation MUST reject the request instead of returning every network and raw currency metadata

### Requirement: Evidence digests are independent and secret-free

Each evidence action SHALL compute its digest from the canonical, secret-redacted source object used for that fact. A batch envelope or downstream venue profile MUST NOT replace the independently computed trading-fee, market-rule, or transfer-network digest.

#### Scenario: Source object key order differs

- **WHEN** semantically identical source objects have different object-key insertion order
- **THEN** the canonical digest MUST be identical

#### Scenario: Different source fact is observed

- **WHEN** a fee rate, market rule, transfer-network value, symbol, account selector, or authoritative source object differs
- **THEN** the corresponding evidence digest MUST differ

#### Scenario: Secret-bearing material is encountered

- **WHEN** source data, an error, or provider metadata includes API keys, secrets, signatures, authorization fields, tokens, or credential values
- **THEN** those fields and values MUST be absent from evidence JSON, digest inputs, logs, test fixtures, and retained artifacts

### Requirement: Existing action boundaries compose through batching

`FetchFees`, `FetchMarketRules`, and `FetchCurrency` SHALL remain independently callable and batchable read-only actions. Batching SHALL reduce gRPC round trips without changing the authority, schema version, digest, timestamp, or error semantics of any child result.

#### Scenario: Maker requests two pairs and two transfer targets

- **WHEN** one valid batch contains separate `FetchFees` and `FetchMarketRules` children for ARB-USDC and ARB-USDT plus `FetchCurrency` children for the required transfer targets
- **THEN** the broker MUST return independently correlated child results in one gRPC response
- **AND** the consumer MUST be able to decode and bind those facts without exchange-specific field guessing

#### Scenario: One required fact fails

- **WHEN** one child returns `fee_unavailable`, market discovery failure, or transfer-network failure
- **THEN** the batch MUST identify that failed fact independently
- **AND** no successful sibling fact may imply that the complete venue profile is qualified

### Requirement: Delivery hands downstream adoption to FIET Maker

The completed CEX Broker delivery SHALL record implementation and verification evidence in Backlog TASK-5 and SHALL create a secret-free `$handoff` document under the FIET Maker project key describing downstream contract and materializer adoption. The repository MUST NOT add a Maker-specific handoff document under its own `docs/` tree.

#### Scenario: Broker delivery is ready for downstream adoption

- **WHEN** the CEX Broker implementation and verification are complete
- **THEN** TASK-5 MUST identify the delivered action contracts, verification commands and outcomes, live evidence status, PR or revision, and Maker handoff path
- **AND** the Maker handoff MUST describe batch decoding, action-specific evidence decoders, contract-generation updates, fixture materialization, release sequencing, and unresolved blockers without containing credentials
