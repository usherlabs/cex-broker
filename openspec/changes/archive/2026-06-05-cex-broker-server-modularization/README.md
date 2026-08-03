# cex-broker-server-modularization

Establish canonical `src/helpers/` and `src/handlers/` layout, extract `server.ts` helpers, deduplicate shared primitives, and shrink `server.ts` to gRPC wiring and dispatch only.

## Post-archive compliance note (2026-08-03)

This change remains archived because its primary architectural outcome is implemented and the change is stale. The following known gaps are accepted as deferred follow-up work; archival does not assert that these requirements are fully satisfied:

- `src/handlers/subscribe/handler.ts` still contains an inline `error instanceof Error ? error.message : ...` expression instead of using `getErrorMessage`.
- `src/helpers/treasury-discovery.ts` still performs a local record-like object guard instead of using the shared `isRecord` helper.
- Dedicated unit-test evidence is incomplete for some extracted pure helpers, including `parsePayload`, `depositField`, `callArgs`, and `buildTransferNetworkEvidence`.
- Repository history records the implementation phases in one implementation commit, so independent phased delivery cannot be demonstrated retrospectively.

At review time, the full test suite passed (538 tests), TypeScript validation passed, strict OpenSpec validation passed, and `src/server.ts` remained within its 400-line budget. The synced main specification remains authoritative, and the gaps above may be revisited in future changes.
