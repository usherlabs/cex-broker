# Changelog

## Unreleased

- Add explicit unary RPC and public-market-stream-only mode. Full behavior remains
  the default; configured accounts require no archive settings in the new mode.
- Return gRPC `NOT_FOUND` for MEXC's missing-order reply on `GetOrderDetails`.
