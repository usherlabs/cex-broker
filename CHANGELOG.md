# Changelog

## Unreleased

- Add optional limit-order time in force (GTC, IOC, FOK, and post-only) on
  supporting exchange markets without changing legacy order behavior.
- Look up order details by native client order ID where supported, with a
  stable refusal on unsupported routes instead of scanning history.
- Add read-only validation for order, withdrawal, and deposit-address
  requests, returning applied checks and refusal reasons or normalized values.

## 0.3.5

- Add explicit unary RPC and public-market-stream-only mode. Full behavior remains
  the default; configured accounts require no archive settings in the new mode.
- Return gRPC `NOT_FOUND` for MEXC's missing-order reply on `GetOrderDetails`.
