## Why

A client that runs broker actions after one human approval needs each action to be independent and its worst case to be bounded by the venue, not by the client. Three things are missing today: orders cannot state their time in force, so an immediate-or-cancel limit order (the venue-enforced way to cap price and leftover exposure) cannot be requested explicitly; an order can be looked up only by the exchange's order id, so a client that crashed after submitting cannot recover an order it identified by its own client order id; and nothing checks an action against policy, market limits and venue capabilities without placing it.

## What Changes

- `CreateOrder` accepts a first-class `timeInForce` (`GTC`, `IOC`, `FOK`, `PO`), validated against the order type and the venue's advertised support, and passed through CCXT. Callers that omit it behave as today.
- `GetOrderDetails` accepts `clientOrderId` as an alternative to `orderId`, resolved through CCXT where the venue supports it, with a stable unsupported error otherwise.
- New action `ValidateAction = 18`: checks an order, withdrawal or deposit-address request against the broker's policy, the market's limits and precision, and the venue's capabilities, without calling any mutating venue method. It returns the normalized action or every reason it would be refused, as `cex-broker-action-validation/v1` evidence.

## Capabilities

### New Capabilities

- `cex-order-bounds`: time in force on orders, lookup by client order id, and validation without placement.

## Impact

- `src/proto/node.proto` (new enum value; descriptors regenerated), order and lookup handlers, a validation helper, schemas, evidence, package contract, README and CHANGELOG.
- Backward compatible: existing payloads and responses are unchanged.
