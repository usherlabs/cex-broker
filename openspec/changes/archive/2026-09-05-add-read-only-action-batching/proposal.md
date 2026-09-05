## Why

CEX Broker currently requires consumers to make separate gRPC calls for related read-only facts, while `FetchFees` also conflates public/default trading metadata with transfer fees and does not prove the authenticated account commission used by a replenishment venue. FIET Maker needs fewer gRPC round trips without collapsing trading-fee, market-rule, and transfer-network authority into one ambiguous contract.

## What Changes

- Add a generic, versioned batch action over an explicit allowlist of read-only broker actions while retaining the existing `ActionRequest` and `ActionResponse` protobuf message types.
- Preserve each child action's request, result JSON, proof, and sanitized error independently inside the batch envelope so consumers can decode each child with its action-specific decoder.
- Restrict each batch to one exchange and one credential/account-selection context; reject state-changing actions, nested batches, oversized batches, and malformed child requests before executing provider calls.
- Evolve fee discovery into an authenticated, pair-scoped trading-commission evidence boundary that uses an account-authoritative exchange operation, reports maker and taker rates with explicit units, and never falls back to public/default fee metadata.
- Evolve currency discovery into a transfer-network evidence boundary for one requested asset and network, including availability, withdrawal fee, available limits, observation time, source method, and deterministic source digest.
- Add a typed market-rule evidence action for one spot pair, including canonical/source identity, active status, price and amount increments, minimum amount/notional, observation time, source method, and deterministic source digest.
- Keep source facts independently versioned, timestamped, and hashed even when transported in one batch; batching does not imply an atomic exchange snapshot or one aggregate authority.
- Preserve pair-specific MEXC values such as ARB-USDC and ARB-USDT independently and do not coerce observations to an expected fee profile or fabricate historical applicability windows.
- Produce the downstream FIET Maker adoption handoff with the `$handoff` workflow under the Maker project key, and record implementation/verification evidence plus the handoff path in Backlog TASK-5. No Maker-specific handoff document is added to this repository.

## Capabilities

### New Capabilities

- `read-only-action-batching`: Generic one-exchange, one-account batching of allowlisted read-only `ExecuteAction` operations through the existing protobuf request/response envelope.
- `cex-venue-evidence`: Clean, independently authoritative trading-commission, market-rule, and transfer-network evidence contracts suitable for batched downstream qualification.

### Modified Capabilities

<!-- None. Existing architecture requirements remain applicable; this change adds behavior without modifying their requirements. -->

## Impact

- Affected CEX Broker surfaces include the action enum/descriptor, action registry and dispatch context, payload validation, fee and currency handlers, a new market-rule handler, shared canonical hashing/redaction helpers, RPC tests, and public action documentation.
- Existing protobuf `ActionRequest` and `ActionResponse` message shapes remain unchanged; the action enum gains a batch operation and action-specific JSON results become versioned evidence contracts.
- Existing consumers of legacy `FetchFees` and `FetchCurrency` result JSON require an explicit hard-cut migration decision during implementation; compatibility aliases are not retained without an operator-owned exception, lifetime, and removal condition.
- MEXC account commission acquisition uses the existing `@usherlabs/ccxt` `fetchTradingFee` capability, which maps to the signed spot `GET /api/v3/tradeFee` operation.
- The batch reduces consumer-to-broker gRPC round trips but does not eliminate provider calls: MEXC still requires one signed commission request per symbol, while market and currency discovery can be shared within the selected broker instance.
- FIET Maker source changes are out of scope. Its required contract, generated-client, materializer, and qualification updates are delivered as a project-scoped handoff and Backlog evidence for subsequent work.
