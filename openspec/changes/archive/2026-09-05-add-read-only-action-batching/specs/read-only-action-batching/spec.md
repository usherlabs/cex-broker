## ADDED Requirements

### Requirement: Batch execution uses the existing action envelope

The broker SHALL expose a generic `Batch` action through the existing `ExecuteAction(ActionRequest) -> ActionResponse` RPC. The protobuf `ActionRequest` and `ActionResponse` message field shapes MUST remain unchanged, and the outer `ActionResponse.result` MUST contain a versioned JSON batch envelope.

#### Scenario: Consumer submits a valid batch

- **WHEN** a consumer sends `Action.Batch` with a JSON `requests` payload containing valid child action requests
- **THEN** the broker MUST return one `ActionResponse`
- **AND** `ActionResponse.result` MUST decode as `cex-broker-action-batch/v1`
- **AND** the consumer MUST be able to correlate every child response by its caller-supplied id

#### Scenario: Batch requests use the string-map wire contract

- **WHEN** a consumer constructs a batch
- **THEN** it MUST set `payload.requests` to the JSON string encoding of the child array
- **AND** every child MUST contain a unique string id, an integer protobuf action value, a string symbol, and a string-valued payload map
- **AND** a child MUST NOT contain `cex`, metadata, credentials, or account-routing fields

#### Scenario: Child fields remain action-native

- **WHEN** the batcher dispatches a validated child
- **THEN** it MUST copy the child symbol and payload unchanged into the child action request
- **AND** it MUST NOT translate a top-level symbol into an action-specific payload field
- **AND** `GetPerpConfigState` callers MUST continue supplying its optional symbol in `child.payload.symbol`

#### Scenario: Existing unary action remains available

- **WHEN** a consumer sends any non-batch action directly
- **THEN** the broker MUST dispatch that action through its ordinary unary path
- **AND** batching MUST NOT be required for single-action callers

### Requirement: Batch eligibility derives from authoritative action metadata

The action registry SHALL assign every executable action an explicit mutability classification and batchability decision. Batch validation MUST derive eligibility from that registry metadata rather than maintain an independent allowlist that can drift from dispatch behavior.

#### Scenario: Read-only action is batchable

- **WHEN** a child action is registered as read-only and batchable
- **THEN** the batch validator MUST permit it subject to its ordinary payload validation

#### Scenario: Initial batchable set is explicit

- **WHEN** the v1 action registry is initialized
- **THEN** only `FetchBalances`, `FetchTicker`, `FetchCurrency`, `FetchAccountId`, `FetchFees`, `GetPerpConfigState`, and `FetchMarketRules` MUST be batchable
- **AND** `Action.Call`, `FetchDepositAddresses`, `GetOrderDetails`, all mutation actions, and `Batch` MUST NOT be batchable

#### Scenario: State-changing action is rejected

- **WHEN** any child requests a write, transfer, order, deposit, withdrawal, configuration mutation, or other action not registered as batchable
- **THEN** the broker MUST reject the complete batch before executing any child
- **AND** it MUST identify the prohibited child id and action without invoking the exchange

#### Scenario: Nested batch is rejected

- **WHEN** a child request names `Action.Batch`
- **THEN** the broker MUST reject the complete batch before executing any child

### Requirement: One batch has one exchange and credential context

A batch SHALL inherit `cex`, authentication metadata, Verity configuration, and account-selection metadata from the outer request. Child requests MUST NOT override exchange, credentials, account selector, authorization metadata, or transport policy.

#### Scenario: Secondary account batch is executed

- **WHEN** the outer metadata selects `secondary:N` and every child is valid
- **THEN** every child MUST use the same resolved secondary broker account
- **AND** no child result may claim a different account selector

#### Scenario: Request-scoped credentials are used

- **WHEN** no configured pool account is selected and valid request-scoped credentials create the broker
- **THEN** every child MUST use that same broker instance
- **AND** evidence responses MUST label the selector and credential source without returning credential values

#### Scenario: Evidence reads use the authenticated broker

- **WHEN** a batch contains fee, market-rule, or transfer-network evidence children
- **THEN** every child MUST use the authenticated broker selected for the outer request
- **AND** the batch MUST NOT create or substitute a public broker even when an underlying fact is publicly available

#### Scenario: Child attempts to override routing

- **WHEN** a child payload includes a forbidden exchange, credential, or account-routing override
- **THEN** the broker MUST reject the complete batch before executing any child

### Requirement: Batch child contracts remain independently decodable

The batch envelope SHALL preserve each child's action, symbol, correlation id, JSON result string, proof, or sanitized error. The broker MUST NOT merge action-specific result objects into an aggregate venue schema, and consumers SHALL remain responsible for decoding each successful child result with the decoder for that action.

#### Scenario: All children succeed

- **WHEN** every child action completes successfully
- **THEN** the envelope MUST contain one success entry per child in input order
- **AND** each success entry MUST preserve the child `result` JSON string and child proof independently
- **AND** the outer proof MUST NOT claim to prove the complete batch

#### Scenario: Child completion does not complete the parent RPC

- **WHEN** any non-final child invokes its success or error callback
- **THEN** the callback MUST complete only that child-local result collector
- **AND** it MUST NOT invoke the outer transport callback or outer terminal telemetry
- **AND** the outer callback MUST execute exactly once after every validated child has completed

#### Scenario: Runtime child failure occurs

- **WHEN** a structurally valid child fails during provider execution
- **THEN** the outer batch RPC MUST still complete with gRPC `OK`
- **AND** the batch MUST continue executing the remaining validated children
- **AND** the failed entry MUST contain a stable error code, sanitized message, and the same gRPC status number the action would return when called directly
- **AND** the consumer MUST be able to reject an incomplete qualification without issuing another discovery request

#### Scenario: Child proof state is isolated

- **WHEN** the broker executes children with Verity enabled
- **THEN** every child MUST begin with empty proof state and snapshot only the proof produced during that child
- **AND** a failed or proof-less child MUST NOT inherit a previous child's proof
- **AND** the outer `ActionResponse.proof` MUST be empty

#### Scenario: Child result contains action-specific evidence

- **WHEN** a successful child returns a versioned trading-fee, market-rule, or transfer-network evidence document
- **THEN** batching MUST preserve that document byte-for-byte as the child result string
- **AND** batching MUST NOT replace its source digest or observation timestamp with a batch-level value

### Requirement: Batch execution is bounded and deterministic

The broker SHALL validate the entire batch before provider execution, require unique non-empty correlation ids, cap a batch at 32 children and the encoded `payload.requests` value at 256 KiB, execute valid children sequentially in request order for v1, and return entries in that same order.

#### Scenario: Oversized batch is rejected

- **WHEN** a batch contains more than 32 child requests
- **THEN** the broker MUST reject it before executing any child

#### Scenario: Oversized batch payload is rejected

- **WHEN** the UTF-8 encoded `payload.requests` value exceeds 256 KiB
- **THEN** the broker MUST reject it before parsing or executing any child

#### Scenario: Duplicate correlation id is supplied

- **WHEN** two children have the same correlation id
- **THEN** the broker MUST reject the batch before executing any child

#### Scenario: Structurally invalid batch reports a transport error

- **WHEN** a batch is malformed, exceeds the limit, repeats an id, contains an invalid child payload, requests a prohibited action, or attempts a routing override
- **THEN** the outer RPC MUST fail with gRPC `INVALID_ARGUMENT`
- **AND** no child provider operation may execute

#### Scenario: Provider call cardinality remains observable

- **WHEN** a batch contains account-commission requests for N distinct pairs
- **THEN** the broker MUST invoke the account-commission source exactly once for each requested pair
- **AND** every provider request MUST pass through the selected exchange instance and its configured rate limiter
- **AND** market loading or currency acquisition MAY reuse the selected exchange instance's cache

### Requirement: Batch serialization is secret-free

Batch responses, child errors, logs, telemetry, and retained test artifacts SHALL exclude API keys, secrets, signatures, authorization headers, credential metadata values, and other signing material.

#### Scenario: Provider error contains credential material

- **WHEN** a provider error or nested object includes a configured secret value or secret-bearing key
- **THEN** the emitted child error, logs, and batch response MUST redact that value
- **AND** no digest input retained for the batch may include the secret-bearing field
