## Why

Each public market-data `Subscribe` call currently owns its own CCXT watcher, sampler or OHLCV tracker, and archive path. When the production collector and FIET Maker subscribe to the same exchange and symbol, the broker therefore duplicates upstream work and archives the same physical market observation more than once.

## What Changes

- Introduce broker-runtime-scoped ownership of canonical public `ORDERBOOK`, `TICKER`, `TRADES`, and `OHLCV` feeds, with one upstream watcher and archive path shared across matching gRPC subscribers.
- Define canonical feed identity, public read-broker precedence, venue-resolved ORDERBOOK acquisition profiles, per-subscriber depth projection, and retryable first-positive OHLCV bootstrap ownership so request credentials and compatible presentation options do not split a physical feed unnecessarily.
- Add bounded in-process subscriber fanout with slow-subscriber isolation, shared failure propagation, and deterministic last-subscriber cleanup.
- Distinguish logical gRPC subscriptions from physical exchange watches and archive captures in architecture, E2E, and Maker sidecar conformance evidence.
- Add a collector-driven verification gate that compares conservative depth-isolated collection with Binance/MEXC profile-coalesced collection over the same bounded observation window and proves equivalent logical and canonical archive outcomes.
- Preserve the protobuf contract, credential-scoped `BALANCE` and `ORDERS` streams, write-side behavior, and archive-forwarder retry/deduplication semantics.

## Capabilities

### New Capabilities

- `public-market-data-feed-multiplexing`: Defines canonical public feed identity, venue-specific ORDERBOOK acquisition-profile resolution, single-owner upstream collection and archival, subscriber fanout/backpressure, broker selection, and feed lifecycle.

### Modified Capabilities

- `cex-market-data-replay-capture`: Refines public-feed capture and OHLCV bootstrap requirements so one canonical feed owner archives each physical observation once while multiple clients may consume it.
- `cex-broker-order-book-depth-sourcing`: Requires subscriber-specific depth projection from compatible venue-resolved L2 acquisition profiles, with conservative isolation when a venue has no verified coalescing resolver.
- `cex-broker-service-architecture`: Documents the collector as a coverage/liveness subscriber rather than a duplicate-prevention mechanism and explains logical versus physical subscription ownership.
- `maker-archive-sidecar-conformance`: Requires production-compatible evidence that Maker receives a shared feed while the physical exchange watch and archive capture remain singular.
- `archive-e2e-regression`: Extends integrated archive coverage to prove concurrent compatible subscriptions share one physical watcher and archive cadence, and gates coalescing on collector-observed equivalence with the conservative model.

## Impact

The change affects Subscribe dispatch, new helper-level feed supervision and queueing, Binance/MEXC ORDERBOOK acquisition-profile resolvers, broker runtime/server lifecycle wiring, archive ownership, public archive account labeling and checksums, metrics, controlled-exchange test instrumentation, Maker sidecar verification, and `SERVICES_ARCHITECTURE.md`. It changes no protobuf/API fields and introduces no external queue, cache, or persistence dependency.
