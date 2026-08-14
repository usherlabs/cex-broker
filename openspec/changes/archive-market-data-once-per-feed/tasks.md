## 1. Characterization and Contract Tests

- [ ] 1.1 Add focused supervisor tests proving concurrent identical public subscriptions share one worker/watch/archive cadence and that exchange, resolved symbol, market type, feed, and OHLCV timeframe split canonical keys while credentials, account selector, depth, and bootstrap limit do not.
- [ ] 1.2 Add public broker-selection tests covering configured-primary precedence, ignored secondary selection for public feeds, request-credential fallback, credentialless fallback, and configured versus worker-owned exchange cleanup.
- [ ] 1.3 Add subscriber-buffer tests for FIFO behavior, injected count and byte limits, isolated overflow termination, safe overflow metric labels, and continued archive/healthy-subscriber delivery.
- [ ] 1.4 Add worker lifecycle tests covering one-of-many unsubscribe, final-subscriber atomic retirement, optional feed-specific unwatch, ignored late watch results, terminal error fanout, fresh worker after failure, runtime close, and bare `close` without cancellation.
- [ ] 1.5 Add feed-specific tests for unsliced ORDERBOOK archive with per-client `depthLimit`/`limit` projection and for one OHLCV tracker/archived bootstrap with subscriber-local later bootstrap delivery.

## 2. Public Feed Supervisor

- [ ] 2.1 Implement a helper-level fixed-capacity O(1) ring buffer that tracks frame count and serialized bytes, supports close/fail wakeups, and exposes test-only capacity overrides while retaining 16-frame and 1 MiB production constants.
- [ ] 2.2 Implement canonical public feed key construction and the primary/request/public broker-resolution result with explicit configured-versus-owned exchange lifecycle metadata.
- [ ] 2.3 Implement the runtime-scoped public feed registry, atomic worker get-or-create, closeable async-iterable subscribers, archive-before-fanout sequencing, and subscriber-isolated overflow handling.
- [ ] 2.4 Implement ORDERBOOK, TICKER, TRADES, and OHLCV worker adapters with one watcher per key, one ORDERBOOK sampler or OHLCV tracker, full-book projection, first-owner OHLCV bootstrap archival, and subscriber-local later bootstrap delivery.
- [ ] 2.5 Implement race-safe worker failure/retirement, optional feed-specific `unWatch*` calls, late-result suppression, worker-owned exchange close, configured-primary preservation, and supervisor-wide shutdown.
- [ ] 2.6 Add credential-free physical-worker, physical-frame/archive, active-subscriber, and overflow telemetry without API keys, account selectors, or credential-derived labels.

## 3. Subscribe and Runtime Integration

- [ ] 3.1 Inject the concrete public feed supervisor through `CEXBroker` and `getServer` into Subscribe dependencies while keeping `src/server.ts` limited to handler wiring and helpers independent of handlers/server.
- [ ] 3.2 Replace only the public ORDERBOOK, TICKER, TRADES, and OHLCV per-RPC loops with supervisor subscriptions, preserving request validation, response JSON/protobuf shape, terminal error frames, gRPC drain behavior, and legacy `NO_ACTION` resolution.
- [ ] 3.3 Register supervisor shutdown with broker stop and ensure request-owned public exchanges are not also closed by per-call lifecycle code, while configured primary exchanges remain runtime-owned.
- [ ] 3.4 Run and extend Subscribe regression coverage to prove BALANCE, ORDERS, secondary account routing, execution/write archival, request-scoped private broker cleanup, and archive-forwarder behavior remain unchanged.

## 4. Integrated Evidence and Documentation

- [ ] 4.1 Extend the controlled exchange and archive lifecycle harness to measure logical gRPC subscribe/delivery events separately from physical CCXT watch calls and archive captures using explicit barriers.
- [ ] 4.2 Extend archive E2E coverage with overlapping collector and independent ORDERBOOK subscriptions, explicit-versus-omitted depths, one physical watch/archive capture, both deliveries, and unchanged four-feed ClickHouse results.
- [ ] 4.3 Update production-compatible Maker sidecar scripts/verifier so the real Maker subscription is proven by logical delivery while the matching collector+Maker physical watch count and controlled archive capture remain one; retain independent reference-depth action evidence.
- [ ] 4.4 Update `SERVICES_ARCHITECTURE.md` to describe the collector as the persistent coverage/liveness subscriber and show multiple logical clients sharing one broker-owned physical public feed/archive path.

## 5. Verification

- [ ] 5.1 Run the focused supervisor, Subscribe, order-book, OHLCV, archive, account-stream, and broker-lifecycle test files and resolve all failures.
- [ ] 5.2 Run the full `bun test test` suite, TypeScript/build checks, and Biome checks with no regressions.
- [ ] 5.3 Run the integrated archive E2E and production-compatible sidecar conformance path, retaining evidence for two logical subscribers, one physical watcher/archive capture, successful strategy spool drainage, and canonical ClickHouse output.
