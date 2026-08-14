## Context

The Subscribe handler currently resolves or creates an exchange for every RPC and runs the public market-data watch loop inside that RPC. ORDERBOOK creates a sampler per call, OHLCV creates a tracker and bootstrap per call, and every public loop submits archive work before writing its own response. Two equivalent clients therefore create two physical CCXT watches and two archive producers even though public exchange data does not vary by account credentials.

FIET deployments intentionally run an independent collector for continuous capture while Maker is also a normal third-party broker client. The change must preserve that topology, the existing protobuf contract, current terminal JSON error frames, request-scoped broker cleanup, and the separation between public market data and credential-scoped user/write activity. It must also fit the repository dependency direction: `server` wires handlers, handlers dispatch, and helper modules own domain behavior.

## Goals / Non-Goals

**Goals:**

- Own one physical CCXT watcher, sampler/tracker, and archive path per canonical public feed in a broker runtime.
- Fan each physical observation out to any number of matching gRPC subscriptions without allowing a slow client to block archival or healthy clients.
- Keep ORDERBOOK response depth and later OHLCV bootstrap delivery as subscriber presentation concerns rather than physical-feed identity.
- Retire workers deterministically, release request-owned exchanges, and make failures observable without leaking credential identity.
- Prove the distinction between logical gRPC subscriptions and physical exchange/archive work in unit, integrated archive, and Maker sidecar evidence.

**Non-Goals:**

- Changing protobuf messages, subscription enum values, or client reconnect behavior.
- Sharing `BALANCE`, `ORDERS`, execution/write archive, or other credential-scoped activity across accounts.
- Adding broker-side archive deduplication or changing archive-forwarder retry tokens, durable SQLite spooling, append-only evidence, or canonical ClickHouse deduplication.
- Adding Redis, Valkey, SQLite, or another queueing dependency for disposable gRPC subscriber buffers.
- Making the collector optional for continuous coverage/liveness or moving archive ownership into the collector.

## Decisions

### Put a public feed supervisor in the broker runtime

A helper-level `PublicMarketDataFeedSupervisor` will be created once per `CEXBroker` runtime, passed through `getServer` into the Subscribe handler, and closed during broker shutdown or runtime replacement. `src/server.ts` will remain wiring-only. The supervisor will expose subscriptions as closeable async iterables so the handler retains responsibility for gRPC validation, response writes, and terminal error formatting.

The supervisor will use an atomic get-or-create registry so concurrent first subscribers cannot start duplicate workers. A worker remains registered while it has subscribers. Removing the final subscriber first retires the registry entry, then stops its watch and resources; a new arrival after retirement creates a fresh worker rather than attaching to a stopping one.

Alternative considered: keep the registry in the handler closure. This would share calls registered by one server instance but obscure broker-runtime shutdown and resource ownership. Runtime ownership makes reload, test injection, and deterministic close behavior explicit.

### Key workers by the physical public feed

The canonical key is normalized exchange, resolved symbol, parsed market type, and public feed type, plus timeframe for OHLCV. Request credentials, account selector, ORDERBOOK `depthLimit`/`limit`, and OHLCV bootstrap limit are excluded.

Public exchange selection follows one stable precedence: the configured primary account exchange when present, a request-credential exchange only when no configured deployment exchange exists, then a credentialless public exchange. Secondary account selection does not create or select a different public feed. If the supervisor owns a request-created or public exchange, the worker closes it when retired; it never closes a configured primary exchange.

Alternative considered: include credential/account identity in every key. Public venue data is the same across those identities, so that would retain the duplicate-watch bug. Account identity remains part of the existing BALANCE, ORDERS, and write paths instead.

### Archive once before subscriber fanout

Each worker owns exactly one watch loop and invokes archive capture once for an accepted physical observation before enqueueing subscriber frames. Archive submission does not wait on gRPC backpressure. ORDERBOOK owns one sampler per worker; OHLCV owns one bar tracker per worker. TICKER and TRADES likewise archive once from the worker, not from each handler call.

ORDERBOOK always calls `watchOrderBook(resolvedSymbol)` without a depth argument, normalizes the full returned snapshot, samples and archives that base snapshot, then slices bids and asks for each subscriber's parsed `depthLimit` or legacy `limit`. An omitted depth receives the exchange-default snapshot. This allows explicit-depth collector and omitted-depth Maker calls to share the same physical watcher.

For OHLCV, timeframe is physical identity. The first subscriber's bootstrap request establishes the worker and its one archived historical bootstrap. A later subscriber may fetch its requested bootstrap for delivery to that subscriber only; those rows do not update the worker tracker or enter the archive path. Live bars then come from the one shared watch/tracker.

Alternative considered: archive after fanout or let one designated subscriber archive. Both couple capture to client health and create ownership races. Worker-owned capture makes the physical observation the unit of archival.

### Use a fixed-capacity in-process ring buffer per subscriber

Every subscription gets a custom O(1) ring buffer capped at 16 frames and 1 MiB of serialized response data. Enqueue accounts for the serialized subscriber-specific frame, including ORDERBOOK projection. Production limits are fixed constants; tests may inject smaller limits to exercise count and byte saturation deterministically.

If either limit would be exceeded, only that subscriber is failed and removed. The handler emits the existing JSON terminal error shape and ends the call. The worker, archive path, and other subscribers continue. A credential-free counter records overflow using safe public dimensions such as exchange, feed, and market type; it never includes API keys, account selectors, or credential-derived hashes.

Alternative considered: reuse array `shift()` queueing or add an external stream/queue. Array shifting is O(n), while Redis/Valkey/SQLite would add operations and durability semantics that disposable RPC buffers do not need. A small ring buffer provides bounded memory and constant-time operations locally.

### Make worker failure terminal and cleanup race-safe

An upstream watch error fails every current subscriber with a terminal feed error and retires the worker. The supervisor does not reconnect underneath an existing RPC; established clients retain responsibility for reconnecting, and the next Subscribe call creates a fresh worker.

On final unsubscribe, the worker is marked retired before resource cleanup. A watch promise that resolves afterward is ignored and cannot archive or fan out. Cleanup calls the feed-specific CCXT `unWatch*` method when available, once, and closes only a worker-owned exchange. Broker shutdown retires and awaits every worker. Cancellation, end, and error remove a subscription; a bare gRPC `close` event without cancellation keeps the established subscription semantics unchanged.

Alternative considered: keep workers warm with zero subscribers or reconnect them internally. A warm cache consumes exchange resources without demand, while hidden reconnect changes current RPC failure/reconnect ownership. Immediate retirement is simpler and deterministic.

### Instrument logical and physical activity separately

Existing Subscribe request metrics remain logical-client evidence. New safe metrics/test probes identify physical worker starts, accepted physical frames/archive submissions, active subscribers, and slow-subscriber overflow without credential labels. The deterministic controlled exchange will expose watch-call and release barriers separately from gRPC delivery barriers.

The production-compatible sidecar will assert that collector and Maker create two logical subscriptions and both receive the shared frame, while only one CCXT watch and one archive capture occur for the canonical feed. `SERVICES_ARCHITECTURE.md` will describe the collector as the coverage/liveness owner, not as the mechanism preventing duplicates.

## Risks / Trade-offs

- [A full upstream ORDERBOOK may be larger than a requested top-N watch] → Bound each subscriber queue by serialized bytes, retain provider defaults, and archive/sample one base snapshot rather than multiplying watches.
- [An exchange may not implement a feed-specific `unWatch*` method] → Treat it as optional, always retire the worker and ignore late results, and close worker-owned exchanges as the fallback resource release.
- [A late OHLCV subscriber bootstrap fetch can race with live delivery] → Keep bootstrap delivery subscriber-local and serialize its initial delivery before attaching live frames, without touching the shared tracker/archive state.
- [Concurrent subscribe/unsubscribe can create duplicate or orphaned workers] → Centralize atomic registry transitions and cover simultaneous first subscribe, final unsubscribe, late watch completion, and fresh-worker-after-failure cases.
- [One upstream error now affects more clients] → Emit an explicit terminal error to all affected calls and require reconnect to create a clean worker; unrelated canonical feed keys remain isolated.
- [Configured primary credentials are used for a public feed shared with other clients] → Never expose credential material or credential-derived identity in keys, payloads, errors, archive dimensions, or metrics; keep account/user feeds outside the supervisor.

## Migration Plan

1. Add the helper supervisor, ring buffer, feed adapters, and focused tests without changing the protobuf surface.
2. Inject one supervisor through runtime/server wiring and move only the four public Subscribe branches onto it.
3. Update controlled-exchange probes, integrated archive/sidecar assertions, and architecture documentation to distinguish logical and physical activity.
4. Run focused Subscribe/archive tests, the full Bun suite, type/build and Biome checks, then the archive E2E and production-compatible sidecar profile.
5. Deploy as an in-place broker change; no stored-data migration or coordinated client rollout is required. Rollback restores per-RPC watchers, with archive-forwarder and ClickHouse state remaining compatible.

## Open Questions

None. The feed key, broker precedence, buffer limits, overflow behavior, failure ownership, and OHLCV bootstrap semantics are fixed by this change.
