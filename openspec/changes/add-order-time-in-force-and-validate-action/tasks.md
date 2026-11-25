## 1. Contract

- [ ] 1.1 Add `ValidateAction = 18` to `src/proto/node.proto`, regenerate descriptors with `proto-gen.sh`, and prove `ActionRequest` and `ActionResponse` fields are unchanged
- [ ] 1.2 Schemas for `timeInForce`, `clientOrderId` lookup and the `cex-broker-action-validation/v1` evidence document; update the package contract

## 2. Behavior

- [ ] 2.1 Time in force on `CreateOrder`: validation per order type and venue support, passed through CCXT (spec: Orders state their time in force)
- [ ] 2.2 `GetOrderDetails` by `clientOrderId` with a stable unsupported error (spec: Orders can be found by client order id)
- [ ] 2.3 `ValidateAction` for orders, withdrawals and deposit-address requests, reusing policy and market-rule checks and calling no mutating method (spec: Actions can be validated without being placed)

## 3. Checks and docs

- [ ] 3.1 Tests: IOC, FOK and PO cases, unsupported combinations, client order id lookup and its unsupported path, validation refusals and a valid case, and a test double that fails on any mutating call
- [ ] 3.2 README and CHANGELOG entries; `bun run check`, `bun run build:ts`, `bun run test`, `bun run check:package`, `bun run check:server-lines`
