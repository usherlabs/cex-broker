## 1. Align Task And Contract Scope

- [x] 1.1 Update Backlog TASK-5 through the Backlog interface with the approved generic-batch design, hard-cut action boundaries, broker-only implementation scope, and Maker `$handoff` deliverable before changing code.
- [x] 1.2 Add `FetchMarketRules = 16` and `Batch = 17` to the canonical action enum, regenerate descriptors, and prove `ActionRequest` and `ActionResponse` protobuf fields are unchanged.
- [x] 1.3 Define strict Zod/TypeScript schemas for `payload.requests` JSON-string encoding, child integer actions/string-valued payload maps, batch envelopes, and the three versioned evidence result documents, including canonical/unified/source symbols, canonical decimal strings, timestamps, source methods, digest metadata, and secret-free account scope.

## 2. Implement Registry-Driven Read-Only Batching

- [x] 2.1 Replace handler-only action registration with descriptors containing handler, read/write classification, and batchability; explicitly classify every existing action.
- [x] 2.2 Mark only `FetchBalances`, `FetchTicker`, `FetchCurrency`, `FetchAccountId`, `FetchFees`, `GetPerpConfigState`, and `FetchMarketRules` batchable in v1, with `Call`, `GetOrderDetails`, `FetchDepositAddresses`, mutations, and `Batch` prohibited.
- [x] 2.3 Implement full prevalidation for the outer batch and every child, including exact string-map decoding, a 32-child limit, a 256 KiB encoded request limit, unique ids, inherited exchange/account routing, forbidden override detection, nested-batch rejection, outer `INVALID_ARGUMENT`, and no provider calls on structural failure.
- [x] 2.4 Implement ordered sequential child dispatch through the selected authenticated broker with child-local callback collectors, verbatim symbol/payload forwarding, exactly one outer callback, outer gRPC `OK` for runtime child failures, and unary-equivalent status values in sanitized child errors.
- [x] 2.5 Isolate and snapshot Verity proof state per child, prevent proof inheritance, emit `cex-broker-action-batch/v1` through the existing `ActionResponse.result` with an empty outer proof, and add batch/item telemetry that contains no payloads or credentials.

## 3. Establish Clean Venue-Evidence Boundaries

- [x] 3.1 Implement canonical decimal normalization and exact decimal-fraction-to-basis-point conversion with no binary floating-point multiplication.
- [x] 3.2 Implement shared canonical source hashing and recursive secret removal/rejection by reusing repository canonical JSON and redaction primitives.
- [x] 3.3 Hard-cut `FetchFees` to one authenticated slash-delimited spot pair, allow `loadMarkets` only for symbol resolution, invoke account-authoritative `fetchTradingFee`, emit `cex-trading-fee-evidence/v1`, map `fee_unavailable:` to unary `FAILED_PRECONDITION`, and remove token-only funding behavior, legacy funding flags, public/default fallback, and obsolete response writers.
- [x] 3.4 Add `FetchMarketRules` on the selected authenticated broker for one active spot pair and emit `cex-market-rule-evidence/v1` with canonical/unified/exchange-native symbols, required increments/minimums, optional maxima, observation metadata, and source digest.
- [x] 3.5 Hard-cut `FetchCurrency` on the selected authenticated broker to one required asset/network target and emit `cex-transfer-network-evidence/v1` using existing discovery and alias resolution without the legacy raw/unscoped currency response.
- [x] 3.6 Ensure configured primary/secondary accounts and request-scoped credentials report the normalized selector plus `configured_pool` or `request_metadata` source without exposing credential identity or values.
- [x] 3.7 Map unavailable commission, market, and network facts to stable fail-closed errors and verify no action substitutes another pair, public fee defaults, controller defaults, or historical applicability claims.

## 4. Verify Contracts, Security, And Batching

- [x] 4.1 Add unit fixtures for the nested MEXC and CCXT commission shapes, including `0E-18`, `0.000500000000000000`, mismatched/missing fields, unsupported methods, exact `0`/`5` basis-point conversion, permitted `loadMarkets` symbol resolution, and rejection of token-only symbols and legacy flags.
- [x] 4.2 Add evidence tests for ARB-USDC versus ARB-USDT isolation; canonical, unified, and exchange-native symbol agreement; market required-field extraction with optional maxima; authenticated-broker use; transfer-network availability/fees/limits; deterministic key-order-independent digests; changed-source digests; and absence of effective interval fields.
- [x] 4.3 Add batch RPC tests for exact `payload.requests` encoding, successful mixed reads, direct unary parity, unchanged `GetPerpConfigState` payload semantics, secondary and request-credential routing, response ordering, child-local callback isolation, exactly one outer completion, outer `OK` on runtime child errors, outer `INVALID_ARGUMENT` on structural errors, per-child status preservation, Verity proof isolation, malformed payloads, duplicate ids, oversized batches, nested batches, exact per-pair commission source invocation counts, and rejection of every non-batchable action before side effects.
- [x] 4.4 Add adversarial secret tests proving responses, digests, errors, logs, telemetry, and retained fixtures exclude credential keys and configured secret values.
- [x] 4.5 Update CEX Broker action documentation with the breaking `FetchFees`/`FetchCurrency` contracts, `FetchMarketRules`, generic batch request/response examples, read-only registry policy, and the distinction among account commission, realized fill commission, transfer fees, and Maker DEX venue-fee revenue.
- [x] 4.6 Update current `FetchFees`/`FetchCurrency` RPC fixtures and known consumer-contract tests for the approved hard cut, then run focused tests, `bun test test`, `bun run build:ts`, `bun run check`, `bun run build`, and OpenSpec strict validation; record commands and outcomes in TASK-5.

## 5. Validate Live Evidence And Hand Off Maker Adoption

- [x] 5.1 Load the required FIET environment workflow before credential-backed validation, then run a secret-safe MEXC smoke against an authorized read-only account for ARB-USDC and ARB-USDT through one batch.
- [x] 5.2 Verify the live batch preserves observed pair-specific commission values, source symbols, account selector, independent timestamps/digests, market rules, and requested transfer-network facts without asserting an expected `0/5` profile or retaining raw signed traffic.
- [x] 5.3 Self-review the diff for dependency direction, obsolete compatibility paths, security leakage, regression risk, and one-task/one-PR scope; keep TASK-5 In Progress if any required verification is blocked.
- [x] 5.4 After the broker revision is final, use `$handoff` with `/home/azureuser/ao-repos/fiet-maker-develop` as the target workdir to create the Maker adoption handoff covering batch decoding, action-specific evidence models, canonical contract/proto updates, generated clients, fee-fixture materialization, release sequencing, and blockers.
- [x] 5.5 Append the final schema summary, verification evidence, live-smoke status, broker revision/PR, and Maker handoff path to TASK-5; complete its approved criteria and final summary only when all broker-owned evidence is verified.
