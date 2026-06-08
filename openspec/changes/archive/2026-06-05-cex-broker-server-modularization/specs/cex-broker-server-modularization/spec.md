## ADDED Requirements

### Requirement: Canonical source layout for broker code
The cex-broker repository SHALL organize server and domain logic according to a documented layout: thin `src/server.ts`, domain modules under `src/helpers/`, optional RPC handlers under `src/handlers/`, shared primitives under `src/helpers/shared/`, and gRPC transport helpers under `src/helpers/grpc/`.

#### Scenario: server.ts contains only wiring and dispatch
- **WHEN** the modularization change is complete
- **THEN** `src/server.ts` MUST limit itself to gRPC package loading, `getServer` factory, service registration, authentication and telemetry wrappers, and delegation to handlers or helpers
- **AND** `src/server.ts` MUST NOT contain deposit matching, transfer network resolution, treasury discovery, or other domain business rules inline

#### Scenario: New domain logic uses helpers or handlers
- **WHEN** a contributor adds new broker domain behavior after this change lands
- **THEN** the implementation MUST reside in `src/helpers/<domain>.ts` or `src/handlers/<rpc>/<handler>.ts`
- **AND** it MUST NOT be added as new top-level functions inside `src/server.ts`

#### Scenario: No parallel utils tree
- **WHEN** shared primitives are introduced or consolidated
- **THEN** they MUST live under `src/helpers/shared/` or `src/helpers/grpc/`
- **AND** the repository MUST NOT introduce a separate `src/utils/` tree for the same purpose

### Requirement: Enforced module dependency direction
Helper modules MUST NOT depend on `server.ts` or `handlers/`; handlers and `server.ts` MAY depend on helpers.

#### Scenario: Helpers remain independent of server
- **WHEN** any file under `src/helpers/` is imported
- **THEN** that file MUST NOT import from `src/server.ts` or `src/handlers/**`

#### Scenario: Handlers compose helpers
- **WHEN** an action handler under `src/handlers/execute-action/` needs domain logic
- **THEN** it MUST import from `src/helpers/**` or `src/schemas/**`
- **AND** it MUST NOT duplicate logic that already exists in a helper module

### Requirement: Shared primitives are defined once
The broker SHALL provide a single implementation for record guards and error message extraction used across server, helpers, and subscribe paths.

#### Scenario: isRecord is shared
- **WHEN** code needs to narrow `unknown` to `Record<string, unknown>`
- **THEN** it MUST use the export from `src/helpers/shared/guards.ts`
- **AND** duplicate local `isRecord` or equivalent `asRecord` implementations MUST NOT remain in `server.ts`, `order-book.ts`, or `order-telemetry.ts`

#### Scenario: getErrorMessage is shared
- **WHEN** an error is formatted for logging, gRPC details, or Subscribe stream JSON
- **THEN** it MUST use `getErrorMessage` from `src/helpers/shared/errors.ts`
- **AND** inline `error instanceof Error ? error.message : ...` ternaries MUST NOT remain in `Subscribe` handlers after Phase 0

### Requirement: gRPC transport helpers are centralized
Payload validation and error-to-status mapping SHALL live in `src/helpers/grpc/` and be reused by all `ExecuteAction` paths.

#### Scenario: Payload parsing uses grpc helper
- **WHEN** an action validates a Zod schema against `Record<string, string>` payload fields
- **THEN** it MUST use `parsePayload` from `src/helpers/grpc/payload.ts`

#### Scenario: CCXT and stable errors map consistently
- **WHEN** an `ExecuteAction` handler surfaces an error to the client
- **THEN** it MUST resolve gRPC status via `stableGrpcErrorCode` and/or `mapCcxtErrorToGrpcStatus` from `src/helpers/grpc/status.ts` (or a composed `resolveGrpcError` helper defined there)
- **AND** the mapping MUST remain behavior-identical to pre-extraction behavior for the same error inputs

### Requirement: Domain helpers extracted from server.ts
Treasury discovery, transfer network resolution, and deposit validation helpers currently in `server.ts` SHALL be moved to dedicated helper modules without changing RPC contracts.

#### Scenario: Treasury discovery is modular
- **WHEN** `Action.Call` dispatches `fetchMarkets` or `fetchCurrencies` treasury paths
- **THEN** the logic MUST be implemented in `src/helpers/treasury-discovery.ts`
- **AND** existing `test/treasury-discovery-rpc.test.ts` scenarios MUST pass unchanged

#### Scenario: Transfer network resolution is modular
- **WHEN** withdraw or deposit flows resolve operator network aliases
- **THEN** the logic MUST be implemented in `src/helpers/transfer-network.ts`
- **AND** `test/internal-transfer-rpc.test.ts` MUST pass unchanged where applicable

#### Scenario: Deposit validation helpers are modular
- **WHEN** deposit observation compares amounts, addresses, or transaction hashes
- **THEN** the logic MUST use exports from `src/helpers/deposit.ts`

### Requirement: Phased delivery with regression safety
Each extraction phase MUST ship independently with passing tests; handler extraction is optional and action-scoped.

#### Scenario: Phase 0–1 does not require handlers
- **WHEN** Phases 0–1 (shared, grpc, domain helpers) are merged
- **THEN** `getServer` MUST remain exported from `src/server.ts`
- **AND** `bun test` MUST pass with no proto or public API changes

#### Scenario: Handler extraction is incremental
- **WHEN** Phase 3 migrates an `ExecuteAction` case to `src/handlers/execute-action/`
- **THEN** at most one action cluster SHOULD move per PR
- **AND** RPC tests covering that action MUST pass before merge

#### Scenario: Public gRPC contract unchanged
- **WHEN** modularization PRs merge
- **THEN** proto definitions and client-visible request/response JSON shapes MUST NOT change
- **AND** no requirement in this spec SHALL be interpreted as permitting breaking gRPC API changes

### Requirement: Unit tests for extracted pure helpers
Pure functions moved out of `server.ts` SHALL have dedicated unit tests that do not require starting a gRPC server.

#### Scenario: Shared and grpc helpers are unit tested
- **WHEN** `helpers/shared/guards.ts`, `helpers/shared/errors.ts`, `helpers/grpc/status.ts`, or `helpers/deposit.ts` export pure functions
- **THEN** corresponding tests MUST exist under `test/` and run via `bun test`

#### Scenario: RPC integration tests remain the contract for handlers
- **WHEN** handler modules are introduced
- **THEN** existing RPC test files (`treasury-discovery-rpc`, `order-book-rpc`, `internal-transfer-rpc`, `order-telemetry`) MUST continue to pass without modifying their public import path from `src/server.ts`

### Requirement: Concrete imports over barrel growth
Contributors SHALL import from specific helper modules rather than expanding `helpers/index.ts` with server or handler utilities.

#### Scenario: Server helpers are not re-exported from index
- **WHEN** `parsePayload`, deposit helpers, or grpc status helpers are extracted
- **THEN** they MUST NOT be added to the public barrel in `src/helpers/index.ts`
- **AND** consumers MUST import from the concrete module path (for example `helpers/grpc/payload`)