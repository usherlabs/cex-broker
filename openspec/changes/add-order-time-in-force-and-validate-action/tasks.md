## 1. Contract

- [x] 1.1 Add `ValidateAction = 18` to `src/proto/node.proto`, regenerate descriptors with `proto-gen.sh`, and prove `ActionRequest` and `ActionResponse` fields are unchanged
- [x] 1.2 Schemas for `timeInForce`, `clientOrderId` lookup and the `cex-broker-action-validation/v1` evidence document; update the package contract

## 2. Behavior

- [x] 2.1 Time in force on `CreateOrder`: validation per order type and venue support, passed through CCXT (spec: Orders state their time in force)
- [x] 2.2 `GetOrderDetails` by `clientOrderId` with a stable unsupported error (spec: Orders can be found by client order id)
- [x] 2.3 `ValidateAction` for orders, withdrawals and deposit-address requests, reusing policy and market-rule checks and calling no mutating method (spec: Actions can be validated without being placed)

- [ ] 2.4 Explicit bind host for the gRPC server (environment variable and CLI flag), defaulting to the current behaviour; loopback-only when set to 127.0.0.1 or ::1
  - The bind-host tests pass for both loopback addresses. The full test suite did not pass. It failed in the execution archiver, ClickHouse conformance, and two order book RPC tests. The same failures occurred before the bind-host change.

## 3. Checks and docs

- [x] 3.1 Tests: IOC, FOK and PO cases, unsupported combinations, client order id lookup and its unsupported path, validation refusals and a valid case, and a test double that fails on any mutating call
- [x] 3.2 README and CHANGELOG entries; `bun run check`, `bun run build:ts`, `bun run test`, `bun run check:package`, `bun run check:server-lines` (verified in a fresh container on CI's Bun 1.3.14 and Node 24; `check:package` needs the packed tarball arguments CI passes)
