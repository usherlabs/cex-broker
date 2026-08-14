## Context

The Subscribe handler currently resolves or creates an exchange for every RPC and runs the public market-data watch loop inside that RPC. ORDERBOOK creates a sampler per call, OHLCV creates a tracker and bootstrap per call, and the public loops currently submit archive work only after a successful response write. Two equivalent clients therefore create two physical CCXT watches and two archive producers, while a disconnected or backpressured client can suppress capture, even though public exchange data does not vary by account credentials.

FIET deployments intentionally run an independent collector for continuous capture while Maker is also a normal third-party broker client. The change must preserve that topology, the existing protobuf contract, current terminal JSON error frames, request-scoped broker cleanup, and the separation between public market data and credential-scoped user/write activity. It must also fit the repository dependency direction: `server` wires handlers, handlers dispatch, and helper modules own domain behavior.

## Goals / Non-Goals

**Goals:**

- Own one physical CCXT watcher, sampler/tracker, and archive path per canonical public feed in a broker runtime.
- Fan each physical observation out to any number of matching gRPC subscriptions without allowing a slow client to block archival or healthy clients.
- Keep ORDERBOOK response depth as a subscriber presentation concern after resolving it to a compatible venue acquisition profile, and keep later OHLCV bootstrap delivery separate from the shared live tracker/archive.
- Preserve enough normalized L2 price levels to calculate immediate sell-into-bids and buy-from-asks capacity for every configured FIET Maker hedge-envelope measurement band.
- Retire workers deterministically, release request-owned exchanges, and make failures observable without leaking credential identity.
- Prove the distinction between logical gRPC subscriptions and physical exchange/archive work in unit, integrated archive, and Maker sidecar evidence.
- Gate Binance/MEXC coalescing on collector-observed data equivalence and FIET Maker position-policy equivalence with the conservative depth-isolated model over a bounded deterministic observation window.

**Non-Goals:**

- Changing protobuf messages, subscription enum values, or client reconnect behavior.
- Sharing `BALANCE`, `ORDERS`, execution/write archive, or other credential-scoped activity across accounts.
- Adding broker-side archive deduplication or changing archive-forwarder retry tokens, durable SQLite spooling, append-only evidence, or canonical ClickHouse deduplication.
- Adding Redis, Valkey, SQLite, or another queueing dependency for disposable gRPC subscriber buffers.
- Making the collector optional for continuous coverage/liveness or moving archive ownership into the collector.
- Providing or normalizing true L3/order-by-order feeds; this change operates on CCXT's price-aggregated L2 snapshot model.
- Treating displayed L2 depth as executed trading volume, passive queue position, or guaranteed fills; realized flow remains a TRADES/OHLCV concern and safety/participation factors remain Maker policy concerns.

## Decisions

### Put a public feed supervisor in the broker runtime

A helper-level `PublicMarketDataFeedSupervisor` will be created once per `CEXBroker` runtime, passed through `getServer` into the Subscribe handler, and closed during broker shutdown or runtime replacement. `src/server.ts` will remain wiring-only. The supervisor will expose subscriptions as closeable async iterables so the handler retains responsibility for gRPC validation, response writes, and terminal error formatting.

The supervisor will use an atomic get-or-create registry so concurrent first subscribers cannot start duplicate workers. A worker remains registered while it has subscribers. Removing the final subscriber first retires the registry entry, then stops its watch and resources; a new arrival after retirement creates a fresh worker rather than attaching to a stopping one.

Alternative considered: keep the registry in the handler closure. This would share calls registered by one server instance but obscure broker-runtime shutdown and resource ownership. Runtime ownership makes reload, test injection, and deterministic close behavior explicit.

### Key workers by the resolved physical public feed

The canonical key is normalized exchange (`trim().toLowerCase()`), resolved symbol, parsed market type, and public feed type, plus the resolved ORDERBOOK acquisition profile or the OHLCV timeframe (default `1m`). Request credentials, account selector, raw ORDERBOOK `depthLimit`/`limit`, and OHLCV bootstrap limit are excluded. Two ORDERBOOK requests coalesce only when their venue resolver returns the same profile and that profile guarantees enough retained L2 depth for each explicit request and the configured archive-depth requirement.

An ORDERBOOK resolver returns a stable profile ID, the upstream CCXT limit/options to use, its guaranteed retained depth when known, and whether requests may coalesce. Binance and MEXC receive the first verified coalescing resolvers: their supported public L2 watch path uses one venue profile from which compatible client depths are projected locally. A venue without a verified resolver uses a conservative profile containing the explicit requested depth or an omitted-depth sentinel and preserves the existing upstream call behavior. This fallback can create separate physical workers; it avoids asserting equivalence that the broker has not verified.

The resolver chooses a profile that covers `max(explicit subscriber depth, configured archive depth)` when both are known. Omitted-depth subscribers receive all levels retained by the selected profile. If a later request cannot be satisfied by an existing profile, the supervisor starts a separate compatible profile rather than mutating or hot-swapping the active worker. Raw requested depth remains response metadata, not the worker key itself.

Public exchange selection follows one stable precedence: the configured primary account exchange when present, a request-credential exchange only when no configured deployment exchange exists, then a credentialless public exchange. Secondary account selection does not create or select a different public feed. Public archive rows use the configured primary label when that deployment exchange exists and omit `account_selector` otherwise; secondary selection never changes this checksum-relevant value. If the supervisor owns a request-created or public exchange, the worker closes it when retired; it never closes a configured primary exchange.

Alternative considered: always omit depth or always key by the raw requested number. Global omission is unsafe because venues such as Bybit, Kraken, and OKX use depth to select fixed topics, cadences, or entitlements. Raw-depth keying duplicates Binance/MEXC work and fails to recognize venue buckets. A resolved acquisition profile captures the physical distinction while preserving conservative behavior for unknown venues. Account identity remains part of the existing BALANCE, ORDERS, and write paths instead.

### Treat L2 band depth as the immediate-hedgeability input

FIET Maker caps counterpart DEX liquidity by the base quantity that can be immediately hedged on the reference CEX inside each candidate position range's price band. For a band `B` around L2 mid, sell capacity is the sum of displayed bid amounts with `price >= mid * (1 - B / 10_000)` and buy capacity is the sum of displayed ask amounts with `price <= mid * (1 + B / 10_000)`. Maker applies its participation/safety policy and uses the weaker relevant side when deriving the advertised-liquidity cap. This computation needs aggregate `[price, amount]` L2 levels, freshness, and continuity provenance; it does not need individual L3 order IDs or queue priority.

`depthLimit` is a count of retained price levels per side, while Maker requirements are price-band widths. A profile proves coverage for band `B` only when its farthest retained bid is at or below the bid boundary and its farthest retained ask is at or above the ask boundary, or when the provider explicitly proves that the visible side is exhausted. A snapshot that stops inside either boundary supplies only a conservative lower bound, regardless of its nominal level count, and cannot satisfy the exact policy-equivalence gate.

The broker cannot infer every external Maker policy from an ordinary subscription. Deployments that intend captured rows to reproduce a policy MUST configure ORDERBOOK archive depth at least as deep as that policy's requested `position_auto_management.depth_limit` and MUST still prove price-band coverage from the retained boundary levels. In the verification profile, Maker's current default live snapshot depth of 100 is therefore paired with archive depth of at least 100; the ordinary archive default of 25 is not accepted as replay-sufficiency evidence unless the controlled book is explicitly exhausted or all required bands are already proven within those levels.

Alternative considered: add L3 to improve the cap. L3 would expose individual resting orders and queue behavior but would not change aggregate immediately marketable quantity at each price. It adds venue-specific identity and reconstruction complexity without satisfying the missing band-coverage or realized-volume requirements. L2 plus existing freshness, coverage, participation, and safety controls is the appropriate contract; TRADES may independently inform realized-flow policy.

### Archive once before subscriber fanout

Each worker owns exactly one watch loop and invokes archive capture once for an accepted physical observation before enqueueing subscriber frames. Archive submission does not wait on gRPC backpressure. ORDERBOOK owns one sampler per worker; OHLCV owns one bar tracker per worker. TICKER and TRADES likewise archive once from the worker, not from each handler call.

ORDERBOOK calls `watchOrderBook` according to the resolved acquisition profile, normalizes the retained base L2 snapshot, makes one archive decision from that base snapshot, applies the existing configured archive-depth cap and `sampled_top_n_snapshot` construction, then slices bids and asks independently for each subscriber's parsed `depthLimit` or legacy `limit`. “Unsliced” means not sliced to any subscriber limit; it does not bypass the archive depth cap. An explicit-N response reports `depthLimit: N`; an omitted-depth response reports the actual retained snapshot depth. This allows compatible explicit-depth collector and omitted-depth Maker calls to share on Binance/MEXC without claiming that all venues have equivalent depth channels.

For OHLCV, timeframe is physical identity. Worker bootstrap ownership has `unclaimed`, `in-flight`, and `complete` states. A zero/false bootstrap request does not claim ownership; the first positive request atomically claims it. A successful fetch is archived once and seeds the single tracker. A fetch failure is non-fatal, leaves live delivery attached, and returns ownership to `unclaimed` so a later positive collector attach or restart can retry. After bootstrap is complete, later bootstrap requests are subscriber-local only: their frames are serialized before live frames and do not update the worker tracker or archive path.

Alternative considered: archive after fanout or let one designated subscriber archive. Both couple capture to client health and create ownership races. Worker-owned capture makes the physical observation the unit of archival.

### Use a fixed-capacity in-process ring buffer per subscriber

Every subscription gets a custom O(1) ring buffer capped at 16 frames and 1 MiB of serialized response data. Enqueue accounts for the serialized subscriber-specific frame, including ORDERBOOK projection. Production limits are fixed constants; tests may inject smaller limits to exercise count and byte saturation deterministically.

If either limit would be exceeded, including a single oversized frame against an empty queue, only that subscriber is failed and removed. Byte capacity is the byte length of the protobuf wire encoding of the complete queued `SubscribeResponse`. The handler emits `Public market-data subscriber fell behind` through the existing JSON terminal error form and ends that RPC through the same terminal-error path as `writeSubscribeError`. The worker, archive path, and other subscribers continue. Frames remain FIFO until a limit fails that subscriber, and a blocked gRPC write never stops the shared watch or other subscribers. A credential-free counter records overflow using safe public dimensions such as exchange, feed, and market type; it never includes API keys, account selectors, or credential-derived hashes.

Alternative considered: reuse array `shift()` queueing or add an external stream/queue. Array shifting is O(n), while Redis/Valkey/SQLite would add operations and durability semantics that disposable RPC buffers do not need. A small ring buffer provides bounded memory and constant-time operations locally.

### Make worker failure terminal and cleanup race-safe

An upstream watch error fails every current subscriber with a terminal feed error and retires the worker. The supervisor does not reconnect underneath an existing RPC; established clients retain responsibility for reconnecting, and the next Subscribe call creates a fresh worker.

On final unsubscribe, the worker is marked retired before resource cleanup. A watch promise that resolves afterward is ignored and cannot archive or fan out. Cleanup calls the feed-specific CCXT `unWatch*` method when available, once, and closes only a worker-owned exchange. A request-created exchange remains worker-owned across individual RPC lifetimes and closes once only after the final subscriber retires.

For a configured primary without the relevant `unWatch*`, a generation-fenced retirement barrier prevents a replacement worker from starting its first watch until the predecessor's in-flight watch settles. Late predecessor results are discarded. If it does not settle within the bounded retirement timeout, the new subscription fails explicitly rather than starting an overlapping loop on the same exchange instance. Broker `run()` replacement and `stop()` retire and await every worker; configured primaries remain exchange-pool-owned while request-created exchanges close. Cancellation, end, and error remove a subscription. A bare gRPC `close` without cancellation is not unsubscribe when no write is blocked; during a blocked drain it remains a terminal transport failure under the existing write-drain contract.

Late joiners do not receive a cached ORDERBOOK, TICKER, TRADE, or live OHLCV frame. They begin with the next accepted physical observation; requested OHLCV bootstrap is the only initial replay path. This avoids manufacturing a second archive offer or ambiguous trade replay.

Alternative considered: keep workers warm with zero subscribers or reconnect them internally. A warm cache consumes exchange resources without demand, while hidden reconnect changes current RPC failure/reconnect ownership. Immediate retirement is simpler and deterministic.

### Instrument logical and physical activity separately

Existing Subscribe request metrics remain logical-client evidence. New safe metrics/test probes identify physical worker starts, accepted physical frames/archive submissions, active subscribers, and slow-subscriber overflow without credential labels. The deterministic controlled exchange will expose watch-call and release barriers separately from gRPC delivery barriers.

The production-compatible sidecar will assert that collector and Maker create two logical subscriptions and both receive the shared frame, while only one CCXT watch and one archive capture occur for a compatible canonical feed. `SERVICES_ARCHITECTURE.md` will describe the collector as the coverage/liveness owner, not as the mechanism preventing duplicates.

The archive E2E gate will run the production `MarketDataCollector` against two deterministic broker compositions fed the same event tape for a configured observation duration plus explicit frame/flush barriers. The conservative composition keys ORDERBOOK workers by requested/default depth; the candidate composition enables the Binance or MEXC resolver. The gate compares ordered logical payloads per subscription and canonicalized unique archive rows after removing deployment/run identity, while separately asserting that the coalesced composition uses fewer physical watches/archive offers and produces no additional canonical events.

For each configured Maker candidate band, the gate also proves that both retained sides cross the band boundary or carry explicit exhaustion evidence. It rehydrates policy inputs independently from each composition's canonical archive rows and compares them with the corresponding live reference snapshot inputs, using an archive depth at least equal to the policy depth limit. Finally, the production-compatible Maker verifier evaluates the live and rehydrated conservative/coalesced inputs through the shared position-policy/hedge-envelope implementation and requires identical band depths, limiting side, envelope liquidity cap, selected width, and rebalance decision. Binance and MEXC must each pass all three layers before their resolver is enabled by default. A live smoke may supplement this proof but is not the deterministic merge gate.

## Risks / Trade-offs

- [A deep upstream ORDERBOOK may be larger than a requested top-N watch] → Resolve the smallest verified profile that covers client and archive requirements, bound subscriber queues by serialized bytes, and retain the existing archive-depth cap.
- [An exchange may not implement a feed-specific `unWatch*` method] → Fence generations, discard late results, await predecessor quiescence before replacement, and fail explicitly on bounded cleanup timeout rather than overlap a configured-primary loop.
- [A late OHLCV subscriber bootstrap fetch can race with live delivery] → Keep bootstrap delivery subscriber-local and serialize its initial delivery before attaching live frames, without touching the shared tracker/archive state.
- [Concurrent subscribe/unsubscribe can create duplicate or orphaned workers] → Centralize atomic registry transitions and cover simultaneous first subscribe, final unsubscribe, late watch completion, and fresh-worker-after-failure cases.
- [One upstream error now affects more clients] → Emit an explicit terminal error to all affected calls and require reconnect to create a clean worker; unrelated canonical feed keys remain isolated.
- [Configured primary credentials are used for a public feed shared with other clients] → Never expose credential material or credential-derived identity in keys, payloads, errors, archive dimensions, or metrics; keep account/user feeds outside the supervisor.
- [Public archive `account_selector` currently affects checksums] → Use the configured primary label when a deployment exchange exists and omit it for request-created/credentialless public feeds; never let secondary selection alter it, and update checksum fixtures deliberately.
- [A Binance/MEXC adapter change invalidates a coalescing assumption] → Keep resolver behavior explicit and venue-scoped, run the conservative-versus-coalesced collector equivalence gate, and fall back to conservative profile isolation on mismatch.
- [A nominal top-N snapshot stops inside a required Maker band] → Treat it as an incomplete lower bound; require retained boundary or explicit-exhaustion proof for the exact verification gate and expose a band-specific failure.
- [The archive cap is shallower than the live Maker policy request] → Configure verification/production capture depth to at least the policy depth limit, validate retained band coverage, and reject replay-equivalence claims based only on the default 25 levels.

## Migration Plan

1. Add the helper supervisor, ring buffer, feed adapters, and focused tests without changing the protobuf surface.
2. Inject one supervisor through runtime/server wiring and move only the four public Subscribe branches onto it.
3. Add Binance/MEXC resolvers behind conservative fallback, update controlled-exchange probes, and make L2 band coverage, archive replay sufficiency, and downstream position-policy equivalence required gates before enabling coalescing.
4. Run focused Subscribe/archive tests, the full Bun suite, type/build and Biome checks, then the archive E2E and production-compatible sidecar profile.
5. Deploy as an in-place broker change; no stored-data migration or coordinated client rollout is required. Rollback restores per-RPC watchers, with archive-forwarder and ClickHouse state remaining compatible.

## Open Questions

None. The L2 immediate-hedgeability purpose, band-coverage proof, replay-depth requirement, downstream policy-equivalence gate, acquisition-profile key, initial Binance/MEXC resolver scope, conservative fallback, broker precedence, buffer/error contract, late-join policy, failure ownership, and retryable first-positive OHLCV bootstrap semantics are fixed by this change.
