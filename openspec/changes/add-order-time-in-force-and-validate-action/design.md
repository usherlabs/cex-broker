## Decisions

1. **Time in force is explicit.** `timeInForce` is an optional payload field. `IOC` and `FOK` require `orderType: limit`; `PO` (post-only) is accepted only where CCXT reports support for the venue. An unsupported combination fails with `INVALID_ARGUMENT` before any venue call.
2. **Lookup by client order id.** `GetOrderDetails` takes exactly one of `orderId` or `clientOrderId`. The client order id path uses the venue's native lookup through CCXT when available and otherwise fails with `FAILED_PRECONDITION` (`client_order_lookup_unsupported`); it never scans order history.
3. **Validation never places.** `ValidateAction` reuses the policy and market-rule code paths the real actions use, loads markets read-only, and calls no mutating CCXT method. A test double fails the run if one is called.
4. **Evidence.** Results use a versioned document `cex-broker-action-validation/v1` carrying the normalized action, the checks applied and any refusal reasons, with no credential material.

Implementation decision rule: keep the three outcomes and backward compatibility; payload field names and error codes may change with review.
