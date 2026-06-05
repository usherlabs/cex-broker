## 1. Layout And Documentation Precedent

- [x] 1.1 Document canonical folder layout and dependency rules in `design.md` (done in OpenSpec) and add a short pointer in `README.md` or `AGENTS.md` for contributors
- [x] 1.2 Confirm no `src/utils/` tree is introduced; all new modules live under `src/helpers/` or `src/handlers/`

## 2. Phase 0 — Shared Primitives

- [x] 2.1 Create `src/helpers/shared/guards.ts` with `isRecord` and `asRecord` (or unified export)
- [x] 2.2 Create `src/helpers/shared/errors.ts` with `getErrorMessage` and `safeLogError`
- [x] 2.3 Replace duplicate `isRecord` in `src/server.ts` and `src/helpers/order-book.ts` with shared import
- [x] 2.4 Replace duplicate record guard in `src/helpers/order-telemetry.ts` with shared import
- [x] 2.5 Replace six inline error ternaries in `Subscribe` with `getErrorMessage`
- [x] 2.6 Add `test/shared-guards.test.ts` and `test/shared-errors.test.ts`

## 3. Phase 1a — gRPC Helpers

- [x] 3.1 Create `src/helpers/grpc/payload.ts` and move `parsePayload` from `server.ts`
- [x] 3.2 Create `src/helpers/grpc/status.ts` with `stableGrpcErrorCode` and `mapCcxtErrorToGrpcStatus`
- [x] 3.3 Wire `server.ts` imports; remove local copies
- [x] 3.4 Add `test/grpc-status.test.ts` covering stable prefix and CCXT error class mappings

## 4. Phase 1b — Domain Helpers

- [x] 4.1 Create `src/helpers/treasury-discovery.ts` (`ExchangeWithDiscovery`, `callArgs`, `handleTreasuryDiscoveryCall`, `fetchCurrencyMetadata`)
- [x] 4.2 Create `src/helpers/transfer-network.ts` (`resolveTransferNetwork`, evidence builders, `networkAliasSet`)
- [x] 4.3 Create `src/helpers/deposit.ts` (deposit field, status, matching, amount/address helpers)
- [x] 4.4 Move `emitOrderExecutionTelemetryInBackground` into `src/helpers/order-telemetry.ts`
- [x] 4.5 Wire `server.ts` imports; remove ~350 lines of local helpers
- [x] 4.6 Add `test/deposit-helper.test.ts` for pure deposit helpers
- [x] 4.7 Run `bun test` including `test/treasury-discovery-rpc.test.ts` and `test/internal-transfer-rpc.test.ts`

## 5. Phase 2 — RPC Boilerplate Patterns

- [x] 5.1 Add `resolveGrpcError` (or equivalent) in `helpers/grpc/status.ts` composing message + stable + CCXT mapping
- [x] 5.2 Add payload guard helper that maps validation failures to `INVALID_ARGUMENT` consistently
- [x] 5.3 Extract repeated broker resolution sequence into a small helper (explicit deps: brokers, metadata)
- [x] 5.4 Refactor `ExecuteAction` cases to use new patterns without behavior change
- [x] 5.5 Run full `bun test` and `bun run check`

## 6. Phase 3 — ExecuteAction Handlers (incremental)

- [x] 6.1 Create `src/handlers/execute-action/index.ts` with `ExecuteActionContext`, handler registry, and types
- [x] 6.2 Extract `Action.Deposit` to `handlers/execute-action/deposit.ts` as template; verify deposit/treasury RPC tests
- [x] 6.3 Extract `Action.Withdraw` to `handlers/execute-action/withdraw.ts`
- [x] 6.4 Extract order actions (CreateOrder, GetOrderDetails, CancelOrder) to `handlers/execute-action/orders.ts`
- [x] 6.5 Extract `Action.Call` treasury branch to `handlers/execute-action/treasury-call.ts`
- [x] 6.6 Extract pass-through actions (FetchBalances, FetchTicker, FetchCurrency, etc.) to `handlers/execute-action/pass-through.ts`
- [x] 6.7 Reduce `server.ts` `ExecuteAction` to context build + registry dispatch
- [x] 6.8 Confirm `getServer` export path unchanged for all RPC tests

## 7. Phase 4 — Subscribe Modularization

- [x] 7.1 Extract subscription type handlers to `src/handlers/subscribe/` or `src/helpers/subscribe/` per design
- [x] 7.2 Ensure all stream error paths use `getErrorMessage`
- [x] 7.3 Delegate ORDERBOOK loop to existing `order-book` helpers where possible
- [x] 7.4 Run order-book and subscribe-related RPC tests

## 8. Guardrails And Validation

- [x] 8.1 Measure `server.ts` line count; target under 400 lines after Phases 3–4 (or document remaining debt) — `server.ts` is 45 lines; action logic lives under `handlers/execute-action/`
- [x] 8.2 Optional: add CI script to fail if `server.ts` exceeds agreed line budget — `scripts/check-server-line-budget.sh`, `bun run check:server-lines`
- [x] 8.3 Run `bun test`
- [x] 8.4 Run `bun run check`
- [x] 8.5 Run `openspec validate cex-broker-server-modularization --strict`