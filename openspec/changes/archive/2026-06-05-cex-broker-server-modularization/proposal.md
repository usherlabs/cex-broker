## Why

[`src/server.ts`](src/server.ts) has grown to roughly 2,300 lines and now mixes gRPC service wiring, cross-cutting error handling, treasury/discovery logic, deposit validation, and large `ExecuteAction` / `Subscribe` handler bodies. Domain helpers already live under [`src/helpers/`](src/helpers/) (for example `order-book.ts`, `order-telemetry.ts`), but new work continues to land in `server.ts`, and primitives such as `isRecord` and `getErrorMessage` are duplicated across files. Without an agreed layout and extraction process, the broker will become harder to review, test, and extend safely.

## What Changes

- Establish a **canonical source layout** for cex-broker: thin `server.ts`, domain modules under `src/helpers/`, optional `src/handlers/` for RPC dispatch, and `src/helpers/shared/` for cross-cutting primitives.
- **Extract** existing local helpers from `server.ts` into focused modules (gRPC payload/status, treasury discovery, transfer network resolution, deposit matching, telemetry wrappers) with no public API or gRPC contract changes.
- **Deduplicate** shared helpers (`isRecord`, `getErrorMessage`, error-to-gRPC mapping) used in `server.ts`, `order-book.ts`, `order-telemetry.ts`, and `Subscribe` stream handlers.
- Introduce **reusable RPC patterns** (`resolveGrpcError`, payload validation helpers, broker resolution) to shrink repeated boilerplate inside `ExecuteAction`.
- **Optionally migrate** `ExecuteAction` and `Subscribe` cases into `src/handlers/` in small, action-scoped PRs after leaf helpers are stable.
- Add **unit tests** for extracted pure helpers and keep existing RPC integration tests (`treasury-discovery-rpc`, `order-book-rpc`, `internal-transfer-rpc`, `order-telemetry`) green after each slice.
- Document **guardrails**: dependency direction (`server` → `handlers` → `helpers`), no imports from `server.ts` into helpers, prefer concrete module imports over growing `helpers/index.ts`, and a target size budget for `server.ts` (registration + dispatch only).

No **BREAKING** changes to gRPC proto definitions, `getServer` export shape, or client-visible request/response contracts.

## Capabilities

### New Capabilities

- `cex-broker-server-modularization`: Defines the broker's canonical folder structure, module boundaries, dependency rules, phased extraction process, deduplication requirements, and acceptance criteria for shrinking `server.ts` while preserving behavior and test coverage.

### Modified Capabilities

- None. This change is structural and organizational; existing functional specs (for example order-book depth sourcing) remain unchanged at the requirement level.

## Impact

- **Primary file:** [`src/server.ts`](src/server.ts) — reduced to service registration and handler delegation.
- **New / extended modules (illustrative):**
  - `src/helpers/shared/guards.ts`, `errors.ts`
  - `src/helpers/grpc/payload.ts`, `status.ts`
  - `src/helpers/treasury-discovery.ts`, `transfer-network.ts`, `deposit.ts`
  - `src/handlers/execute-action/` (phased)
  - `src/helpers/subscribe/` or handler equivalents (phased)
- **Files updated for deduplication:** [`src/helpers/order-book.ts`](src/helpers/order-book.ts), [`src/helpers/order-telemetry.ts`](src/helpers/order-telemetry.ts).
- **Tests:** new unit tests under `test/` for shared/grpc/deposit helpers; existing RPC tests must pass unchanged.
- **Out of scope for this change:** splitting [`src/helpers/index.ts`](src/helpers/index.ts) (~965 lines) unless touched incidentally; proto or policy schema changes.
- **Precedent:** future features MUST place domain logic in the appropriate `helpers/` or `handlers/` module rather than expanding `server.ts`.