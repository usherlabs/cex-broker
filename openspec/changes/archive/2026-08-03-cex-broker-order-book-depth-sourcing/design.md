## Context

Fiet Maker HB strategy compatibility now depends on a broker-mediated order-book access surface for current depth, live depth, capability discovery, and historical sampled top-N snapshots when available. The broker currently exposes `ExecuteAction(Action.Call)` as a generic CCXT method invocation using `functionName`, and `Subscribe(ORDERBOOK)` streams raw CCXT order books as JSON text.

Maker-side clients already call `Action.Call` with order-book-specific `method` payload values:

- `fetch_order_book_capability`
- `fetch_order_book_snapshot`
- `fetch_historical_order_book_snapshots`

The broker therefore needs a small typed order-book dispatch layer on top of the existing gRPC service before any proto-native order-book RPCs are considered. Existing stream clients must continue to decode `bids` and `asks` from `SubscribeResponse.data`.

## Goals / Non-Goals

**Goals:**

- Provide HB-compatible JSON-over-`Action.Call` order-book methods.
- Return normalized current top-N snapshots with exchange, symbol, source timestamp, received timestamp, sequence/update id when available, and requested depth limit.
- Preserve existing `Subscribe(ORDERBOOK)` semantics while enriching stream payloads with the same metadata.
- Return typed historical unsupported payloads when the broker cannot supply historical sampled top-N snapshots.
- Report truthful provider capabilities without advertising exact L2 reconstruction prematurely.
- Keep exchange and symbol strict so the broker never substitutes another venue.

**Non-Goals:**

- Implement exact L2 reconstruction in this change.
- Treat OHLCV or trade volume as order-book-backed depth evidence.
- Replace the existing gRPC service with new proto-native order-book RPCs.
- Add a native Hummingbot adapter to this TypeScript broker unless a real integration is introduced separately.
- Emit credentials, secrets, or private provider metadata in response payloads.

## Decisions

### 1. Add an order-book Call router before generic CCXT dispatch

`Action.Call` should first inspect a normalized order-book method name from `payload.method` or `payload.functionName`. If the method is one of the HB-compatible order-book methods, the broker handles it with an internal typed router. Other calls continue through the existing generic CCXT dispatch.

This keeps Maker compatibility without a breaking proto change and avoids exposing these broker-specific methods as fake CCXT methods.

Alternative considered: require Maker to send CCXT `functionName` values such as `fetchOrderBook`. That would provide current snapshots only and would not express capability discovery or typed historical unsupported responses.

### 2. Keep JSON response contracts stable and tolerant

The order-book router should emit camelCase fields that Maker already decodes, while preserving existing raw `bids` and `asks` arrays:

```json
{
  "bids": [[100.0, 1.0]],
  "asks": [[101.0, 2.0]],
  "timestamp": 1760000000000,
  "receivedTimestamp": 1760000000100,
  "exchange": "binance",
  "symbol": "BTC/USDT",
  "sequence": 123,
  "depthLimit": 100
}
```

The broker may preserve provider raw fields in the object, but it should avoid reshaping `bids` and `asks` in a way that breaks old clients.

Alternative considered: introduce protobuf messages immediately. That is cleaner long-term, but it forces generated client updates before the broker can satisfy the existing Maker helper contract.

### 3. Historical support is capability-driven and honest

Historical sampled top-N snapshots should be advertised only when the broker can return order-book snapshots for the requested exchange, symbol, window, cadence, and depth. If historical support is absent, `fetch_historical_order_book_snapshots` returns:

```json
{
  "exchange": "mexc",
  "symbol": "ARB/USDT",
  "unsupported": true,
  "unsupportedReason": "historical_order_book_provider_unsupported"
}
```

The broker must not synthesize historical responses from the live book after the requested window.

Alternative considered: fail the gRPC call with `UNIMPLEMENTED`. That makes callers infer capability from transport behavior and conflicts with Maker's typed fallback path.

### 4. Exact L2 reconstruction remains false until proven

`supportsExactL2Reconstruction` should remain false unless the broker implements a snapshot-plus-delta reconstruction path with sequence continuity tests, timestamp ordering checks, and invalid-book rejection.

Alternative considered: set exact reconstruction true for exchanges that expose websocket order-book updates. Websocket updates alone are insufficient because exact reconstruction requires initial snapshots, ordered deltas, continuity markers, and replay validation.

### 5. Public market-data access needs an explicit implementation choice

Current broker creation requires API key and secret. Order-book current/live public market-data access may need public exchange instantiation without credentials, or the broker may continue to require registered credentials/metadata for all exchange access. The implementation should pick one behavior deliberately and test it.

Recommended v1: allow public order-book operations to create an exchange instance without credentials when the exchange class supports the requested public method, while keeping private trading and account actions credential-gated.

Alternative considered: keep all broker access credential-gated. That is simpler but weakens the broker-mediated backtest path because public market data does not normally require credentials.

## Risks / Trade-offs

- Provider historical support is exchange-specific -> Capability responses must be derived from real provider support and conservative defaults.
- `Action.Call` currently validates `functionName` only -> Payload validation needs to accept Maker's `method` field without weakening dangerous-name protections for generic calls.
- Existing clients may expect raw CCXT stream payloads -> Stream enrichment must add fields without removing raw `bids`, `asks`, or timestamp fields.
- Public unauthenticated exchange creation can broaden broker behavior -> Limit it to public market-data methods and keep private actions on the existing credential path.
- CCXT `has` flags can be booleans or capability strings -> Capability mapping should treat unknown/non-true historical support conservatively.

## Migration Plan

1. Add payload parsing for order-book Call methods while preserving generic `functionName` calls.
2. Implement normalized current snapshot and capability responses using CCXT public order-book methods.
3. Enrich `Subscribe(ORDERBOOK)` payload JSON without changing response message fields.
4. Add historical response handling that returns typed unsupported unless real historical sampled top-N support is implemented.
5. Add tests for Maker method names, malformed payloads, unsupported historical results, stream backward compatibility, old/default subscription type behavior, and exact reconstruction false.
6. Update README/examples to document the order-book Call methods and corrected subscription enum behavior.
