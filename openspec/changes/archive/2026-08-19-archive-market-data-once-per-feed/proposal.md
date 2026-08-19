## Why

Each public market-data `Subscribe` call currently owns its own CCXT watcher, sampler or OHLCV tracker, and archive path. When the production collector and FIET Maker subscribe to the same exchange and symbol, the broker therefore duplicates upstream work and archives the same physical market observation more than once.

## What Changes

- Introduce broker-runtime-scoped ownership of canonical public `ORDERBOOK`, `TICKER`, `TRADES`, and `OHLCV` feeds, with one upstream watcher and archive path shared across matching gRPC subscribers.
- Define canonical feed identity, public read-broker precedence, venue-resolved ORDERBOOK acquisition profiles, per-subscriber depth projection, and retryable first-positive OHLCV bootstrap ownership so request credentials and compatible presentation options do not split a physical feed unnecessarily.
- Define normalized L2 price-level depth as immediate hedgeability evidence for FIET Maker: sell capacity is displayed bid quantity inside the policy band, buy capacity is displayed ask quantity inside the policy band, and L3 order identity/queue position is not required for this cap.
- Add bounded in-process subscriber fanout with slow-subscriber isolation, shared failure propagation, and deterministic last-subscriber cleanup.
- Distinguish logical gRPC subscriptions from physical exchange watches and archive captures in architecture, E2E, and Maker sidecar conformance evidence.
- Add a CEX-owned Proof A gate that compares conservative depth-isolated collection with candidate Binance/MEXC profile-coalesced collection over the same bounded observation window, proves every configured Maker measurement band is covered, proves archived depth can replay the live policy inputs, and publishes deterministic hashable evidence as `cex-orderbook-coalescing-evidence/v1`.
- Define the cross-repository Proof B boundary: FIET Maker independently consumes Proof A through its real Layer 12 policy-authoring path and publishes hash-bound `fiet-maker-immediate-hedgeability/v2` evidence. CEX Broker validates and combines that external evidence but does not implement or invoke Maker policy logic.
- Keep Proof C in CEX Broker: the production-compatible sidecar proves the real Maker broker boundary, collector overlap, one physical watch/archive decision for two logical subscribers, durable HTTP 202 spool admission and drain, and canonical ClickHouse output.
- Keep Binance and MEXC coalescing candidates fail-closed and disabled by default in this change. A separate `activate-binance-mexc-coalesced-orderbook-profiles` change will pin passing Proof A and Proof B hashes before enabling them in production.
- Preserve the protobuf contract, credential-scoped `BALANCE` and `ORDERS` streams, write-side behavior, and archive-forwarder retry/deduplication semantics.

## Capabilities

### New Capabilities

- `public-market-data-feed-multiplexing`: Defines canonical public feed identity, venue-specific ORDERBOOK acquisition-profile resolution, single-owner upstream collection and archival, subscriber fanout/backpressure, broker selection, and feed lifecycle.

### Modified Capabilities

- `cex-market-data-replay-capture`: Refines public-feed capture, Maker policy replay-depth alignment, and OHLCV bootstrap requirements so one canonical feed owner archives each physical observation once while multiple clients may consume it.
- `cex-broker-order-book-depth-sourcing`: Requires subscriber-specific depth projection from compatible venue-resolved L2 acquisition profiles, defines immediate-hedgeability band coverage, and retains conservative isolation when a venue candidate is absent or inactive.
- `cex-broker-service-architecture`: Documents the collector as a coverage/liveness subscriber rather than a duplicate-prevention mechanism and explains logical versus physical subscription ownership.
- `maker-archive-sidecar-conformance`: Requires production-compatible CEX evidence that Maker receives a shared L2 feed and that the local topology/spool/ClickHouse boundary passes, then consumes separately owned, hash-bound Maker Proof B v2 without asking Maker to reproduce CEX topology facts.
- `archive-e2e-regression`: Extends integrated archive coverage to prove concurrent compatible subscriptions share one physical watcher and archive cadence, and makes CEX-owned Proof A cover logical/archive equality, band coverage, replay sufficiency, a 25-level negative, and reduced physical work for Binance and MEXC candidates.

## Impact

The change affects Subscribe dispatch, new helper-level feed supervision and queueing, default-off Binance/MEXC ORDERBOOK acquisition-profile candidates, broker runtime/server lifecycle wiring, archive ownership and configured archive depth, public archive account labeling and checksums, metrics, controlled-exchange test instrumentation, deterministic Proof A production, hash-bound Proof B consumption, CEX-owned Proof C sidecar verification, and `SERVICES_ARCHITECTURE.md`. FIET Maker's companion change owns Layer 12 Proof B production; production activation is deliberately delegated to a later CEX change. This change changes no protobuf/API fields, introduces no external queue, cache, or persistence dependency, and does not port Maker policy logic into TypeScript.
