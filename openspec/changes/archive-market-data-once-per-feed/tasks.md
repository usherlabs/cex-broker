## 1. Characterization and Contract Tests

- [ ] 1.1 Add focused supervisor tests proving concurrent matching public subscriptions share one worker/watch/archive cadence and that exchange normalization, resolved symbol, market type, feed, ORDERBOOK acquisition profile, and OHLCV resolved timeframe split canonical keys while credentials, account selector, raw depth, and bootstrap limit do not.
- [ ] 1.2 Add ORDERBOOK resolver contract tests for stable profile IDs, guaranteed retained depth, archive-depth inclusion, explicit/omitted projection metadata, incompatible later-depth isolation, and conservative exact/default fallback for unverified venues.
- [ ] 1.3 Characterize and test Binance and MEXC CCXT watch behavior, then prove compatible explicit/omitted depths map to one coalesced public L2 acquisition profile without passing arbitrary projection depth as physical identity.
- [ ] 1.4 Add public broker-selection and archive-row tests covering configured-primary precedence, ignored secondary selection, primary-label `account_selector`, omitted selector for request-created/credentialless workers, checksum fixture impact, and configured versus worker-owned exchange cleanup.
- [ ] 1.5 Add subscriber-buffer tests for FIFO behavior, protobuf-wire byte measurement, injected count and byte limits, empty-buffer oversized-frame failure, exact `Public market-data subscriber fell behind` terminal JSON, isolated RPC termination, safe overflow metric labels, and continued archive/healthy-subscriber delivery.
- [ ] 1.6 Add worker lifecycle tests covering one-of-many unsubscribe, request-created exchange lifetime beyond its creating RPC, final-subscriber atomic retirement/close-once, configured-primary unwatch and no-unwatch barriers, subscribe-during-retirement, ignored late watch results, terminal error fanout, fresh worker after failure, and bounded retirement timeout.
- [ ] 1.7 Add feed tests for base ORDERBOOK archive before subscriber slicing, existing archive depth cap and `sampled_top_n_snapshot`, explicit/legacy/omitted `depthLimit` metadata, late-join waits for next observation, and archive independence from gRPC drain.
- [ ] 1.8 Add OHLCV tests for zero-bootstrap first attach, atomic first-positive ownership, failed-fetch release/retry, completed-bootstrap collector restart, subscriber-local later bootstrap ordering before live frames, later-fetch failure, and no tracker/archive mutation.
- [ ] 1.9 Add runtime lifecycle and transport tests for `run()` replacement, awaited `stop()` cleanup, configured-primary preservation, request-created close, bare close without blocked drain, and bare close during blocked drain.

## 2. Public Feed Supervisor and Acquisition Profiles

- [ ] 2.1 Implement a helper-level fixed-capacity O(1) ring buffer that tracks frame count and full protobuf-wire-encoded `SubscribeResponse` bytes, supports close/fail wakeups, and exposes test-only capacity overrides while retaining 16-frame and 1 MiB production constants.
- [ ] 2.2 Implement canonical public feed key construction with `trim().toLowerCase()` exchange normalization, `1m` OHLCV default timeframe, and an ORDERBOOK acquisition-profile component rather than raw subscriber depth.
- [ ] 2.3 Implement the ORDERBOOK resolver interface returning stable profile ID, upstream CCXT limit/options, guaranteed retained depth, and coalescing support; add verified Binance and MEXC resolvers plus conservative explicit/default fallback for all other venues.
- [ ] 2.4 Implement public exchange resolution and ownership metadata with primary/request/credentialless precedence, worker-scoped request-created lifetime, configured-primary preservation, and stable public archive `account_selector` selection.
- [ ] 2.5 Implement the runtime-scoped public feed registry, atomic worker get-or-create, closeable async-iterable subscribers, archive-decision-before-fanout sequencing, FIFO fanout, and subscriber-isolated overflow handling with the specified terminal error.
- [ ] 2.6 Implement ORDERBOOK workers that acquire the resolved L2 profile, normalize one retained base snapshot, run one archive decision with the existing archive depth cap, and project independent explicit/legacy/omitted responses without hot-swapping an active profile.
- [ ] 2.7 Implement TICKER and TRADES workers with one watcher/archive owner per canonical key and next-observation-only late-join behavior.
- [ ] 2.8 Implement OHLCV workers with one live tracker, `unclaimed`/`in-flight`/`complete` archive-bootstrap state, non-claiming zero requests, retry after failure, serialized subscriber-local later bootstrap, and shared live delivery.
- [ ] 2.9 Implement generation-fenced failure/retirement, optional feed-specific `unWatch*`, configured-primary predecessor barriers and timeout, late-result suppression, worker-owned exchange close-once, and supervisor-wide awaited shutdown.
- [ ] 2.10 Add credential-free physical-worker, profile, physical-frame/archive-decision, active-subscriber, and overflow telemetry without API keys, account selectors, or credential-derived labels.

## 3. Subscribe and Runtime Integration

- [ ] 3.1 Inject the concrete public feed supervisor through `CEXBroker` and `getServer` into Subscribe dependencies while keeping `src/server.ts` limited to handler wiring and helpers independent of handlers/server.
- [ ] 3.2 Replace only the public ORDERBOOK, TICKER, TRADES, and OHLCV per-RPC loops with supervisor subscriptions, preserving request validation, response JSON/protobuf shape, terminal error frames, legacy `NO_ACTION`, and subscriber-local gRPC drain handling.
- [ ] 3.3 Remove per-RPC ownership cleanup for shared request-created public exchanges while preserving the existing BALANCE, ORDERS, and private request-exchange lifecycle.
- [ ] 3.4 Register awaited supervisor retirement with both `CEXBroker.run()` runtime replacement and `stop()`, coordinating configured-primary versus request-created exchange ownership.
- [ ] 3.5 Run and extend Subscribe regression coverage to prove BALANCE, ORDERS, secondary account routing, execution/write archival, request-scoped private broker cleanup, and archive-forwarder behavior remain unchanged.

## 4. Collector Equivalence Gate and Integrated Evidence

- [ ] 4.1 Extend the controlled exchange and archive lifecycle harness to expose ordered event tapes, acquisition-profile identity, logical subscribe/delivery events, physical CCXT watch iterations, archive decisions, and explicit subscription/frame/duration/flush/spool/query barriers.
- [ ] 4.2 Add a production-`MarketDataCollector` E2E comparison runner that feeds identical tapes for a configured minimum duration and frame count into conservative depth-isolated and candidate coalesced broker compositions.
- [ ] 4.3 Compare ordered normalized logical payloads per subscription and canonicalized unique archive rows with deployment/run identity removed; fail on missing, reordered, changed, or additional market events while separately asserting fewer coalesced physical watches/archive offers.
- [ ] 4.4 Require independent Binance and MEXC resolver cases to pass the conservative-versus-coalesced collector gate before their coalescing profiles are enabled by default.
- [ ] 4.5 Extend the four-feed archive lifecycle with overlapping compatible ORDERBOOK collector/client depths and a zero-bootstrap-first OHLCV client followed by the positive-bootstrap collector, proving one physical worker/tracker/archive bootstrap and correct live delivery.
- [ ] 4.6 Update production-compatible Maker sidecar scripts/verifier so the real Maker and collector identify the shared Binance/MEXC acquisition profile, retain omitted-versus-explicit response contracts, and prove two logical deliveries with one physical watch/archive capture; retain independent reference-depth action evidence.
- [ ] 4.7 Update `SERVICES_ARCHITECTURE.md` to describe collector coverage/liveness, venue-profile resolution, verified Binance/MEXC coalescing, conservative unknown-venue isolation, and multiple logical clients sharing compatible broker-owned physical feeds.

## 5. Verification

- [ ] 5.1 Run the focused resolver, supervisor, Subscribe, order-book, OHLCV, archive, account-stream, and broker/runtime-lifecycle test files and resolve all failures.
- [ ] 5.2 Run the full `bun test test` suite, TypeScript/build checks, and Biome checks with no regressions.
- [ ] 5.3 Run the integrated archive lifecycle, Binance and MEXC conservative-versus-coalesced collector gates, and production-compatible sidecar conformance path, retaining evidence for logical equivalence, reduced physical work, successful strategy spool drainage, and canonical ClickHouse output.
